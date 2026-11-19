import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import type { TicketSubject, TicketTarget } from './ticketCommandStore.js';
import { PostgresTicketCentralIntakeStore } from './ticketCentralIntakePostgresStore.js';
import { PostgresTicketInvitationStore } from './ticketInvitationPostgresStore.js';
import { PostgresTicketClientActivationStore } from './ticketClientActivationPostgresStore.js';
import { PostgresTicketClientSessionStore } from './ticketClientSessionPostgresStore.js';
import { PostgresTicketProjectManagementStore } from './ticketProjectManagementPostgresStore.js';
import { PostgresTicketWorkflowStore } from './ticketWorkflowPostgresStore.js';
import { PostgresTicketReadStore } from './ticketReadPostgresStore.js';
import { PostgresProjectStore } from './postgresProjectStore.js';
import { PostgresIssueStore } from './postgresIssueStore.js';
import { createTicketCentralIntakeService } from '../services/ticketCentralIntakeService.js';
import { createTicketInvitationService } from '../services/ticketInvitationService.js';
import { createTicketClientActivationService } from '../services/ticketClientActivationService.js';
import { createTicketClientSessionService } from '../services/ticketClientSessionService.js';
import { createTicketProjectManagementService } from '../services/ticketProjectManagementService.js';
import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketMessageService } from '../services/ticketMessageService.js';
import { createTicketScopeService } from '../services/ticketScopeService.js';
import { createTicketLifecycleRuntime } from '../services/ticketLifecycleRuntime.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { createClientTicketInvitationSecretProtector } from '../ticketing/clientTicketSecrets.js';

// Synthetic, isolated QA only: provider verification and the finished run are simulated.
describe('QA ticket identity chain', () => {
  it('connects inquiry, client conversation, project, task, run, review and delivery', async () => {
    const pg = await createTestDatabase();
    const sql = sqlFor(pg);
    const db: TransactionalSql = { ...sql, transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
    const workspaceId = 'qa-trace-workspace';
    const clientId = 'qa-trace-client';
    const clientEmail = 'qa-trace@example.test';
    const pm: TicketSubject = { kind: 'internal', userId: 'qa-trace-pm', authentication: { kind: 'verified_github_bearer', verificationId: 'qa-pm-auth' } };
    const developer: TicketSubject = { kind: 'internal', userId: 'qa-trace-dev', authentication: { kind: 'verified_github_bearer', verificationId: 'qa-dev-auth' } };
    const now = new Date();
    try {
      await db.query(`insert into public.workspaces(id,name,slug,status,settings_json)
        values ($1,'QA trace','qa-trace','active','{"ticketing_write_mode":"enabled"}')`, [workspaceId]);
      await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role,status) values
        ('qa-pm-member',$1,'qa-trace-pm','pm','active'),('qa-dev-member',$1,'qa-trace-dev','dev','active')`, [workspaceId]);
      const intake = createTicketCentralIntakeService({
        store: new PostgresTicketCentralIntakeStore(db), organizationKey: 'qa-trace-org',
        guard: { async admitRequest(entry) { return { entryId: entry.id, rateSubjectKey: 'a'.repeat(64), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() }; } },
        fingerprintKeys: [{ id: 'qa-key', secret: new Uint8Array(32).fill(9) }], maxRequestAgeMs: 300_000,
        now: () => now, nextId: randomUUID,
      });
      await intake.submit({ schemaVersion: 1, operationId: randomUUID(), fullName: 'QA Client', email: clientEmail,
        company: null, title: 'QA request', description: 'Trace this request through delivery.', requestedDeadline: null },
      { origin: 'https://alpha.example.test', remoteAddress: '192.0.2.10' });
      const pending = await intake.listPending(workspaceId, pm, {});
      expect(pending.items).toHaveLength(1);
      const intakeId = pending.items[0].id;
      const accepted = await intake.accept(intakeId, workspaceId, pm, { schemaVersion: 1, operationId: randomUUID() });
      const target: TicketTarget = { workspaceId, ticketId: accepted.ticketId };
      const intakeLink = await db.query<{ accepted_ticket_id: string; accepted_workspace_id: string }>(
        'select accepted_ticket_id,accepted_workspace_id from alpha_private.ticket_central_intakes where id=$1', [intakeId]);
      expect(intakeLink.rows[0]).toEqual({ accepted_ticket_id: target.ticketId, accepted_workspace_id: workspaceId });

      const workflowStore = new PostgresTicketWorkflowStore(db);
      const commands = createTicketCommandService(workflowStore);
      const version = async () => (await db.query<{ version: number }>(
        'select version::int as version from alpha_private.tickets where workspace_id=$1 and id=$2', [workspaceId, target.ticketId])).rows[0].version;
      await commands.execute(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), command: { type: 'review' } });

      const secrets = createClientTicketInvitationSecretProtector('qa-trace-session-secret-with-sufficient-entropy');
      const invitation = await createTicketInvitationService(new PostgresTicketInvitationStore(db),
        { lifetimeMs: 60 * 60 * 1000 }, secrets.invitation, () => now).issue(target, pm);
      const outbox = await db.query<{ payload: { protectedToken: string } }>(
        `select payload from alpha_private.ticket_outbox_events where workspace_id=$1 and ticket_id=$2 and payload->>'activationVersion'='1'`,
        [workspaceId, target.ticketId]);
      const invitationToken = secrets.invitation.unprotect(outbox.rows[0].payload.protectedToken,
        { workspaceId, ticketId: target.ticketId, invitationId: invitation.invitationId, expiresAt: invitation.expiresAt });
      const verifier = { async verifyCredential(value: string) { return value === 'qa-credential' ? { userId: clientId, email: clientEmail, emailVerified: true } : null; } };
      await createTicketClientActivationService(new PostgresTicketClientActivationStore(db), verifier, () => now)
        .activate({ invitationToken, providerCredential: 'qa-credential' });
      const sessions = createTicketClientSessionService(new PostgresTicketClientSessionStore(db), verifier, { lifetimeMs: 60 * 60 * 1000 }, () => now);
      const session = await sessions.exchange('qa-credential');
      const auth = await sessions.authenticate(session!.sessionCookieValue);
      expect(auth.kind).toBe('authenticated');
      if (auth.kind !== 'authenticated') throw new Error('Synthetic client session missing');
      const client = auth.subject;

      const messages = createTicketMessageService(workflowStore);
      await messages.reply(target, client, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), body: 'Client question' });
      await messages.reply(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), body: 'PM response' });
      const project = await new PostgresProjectStore(db).create(workspaceId,
        { id: 'qa-trace-project', name: 'QA Project', key: 'QA', status: 'in_progress', createdBy: pm.userId });
      const taskStore = new PostgresIssueStore(db);
      const task = await taskStore.create(workspaceId, { id: 'qa-trace-task', projectId: project.id, identifier: 'QA-1', title: 'Implement request', status: 'todo' });
      await createTicketProjectManagementService(new PostgresTicketProjectManagementStore(db)).linkProject(target, pm,
        { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), projectId: project.id, clientVisible: true, projectPreview: null });
      const scope = await createTicketScopeService(workflowStore).propose(target, pm,
        { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), publicSummary: 'Agreed client scope', developerBrief: 'Approved developer work' });
      await commands.execute(target, client, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(),
        command: { type: 'agree_scope', scopeVersionId: scope.scopeVersionId } });
      await commands.execute(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(),
        command: { type: 'authorize_work', scopeVersionId: scope.scopeVersionId, projectId: project.id, issueIds: [task.id] } });
      const bindings = await db.query<{ ticket_id: string; project_id: string; issue_id: string; scope_version_id: string; current_revision_id: string }>(
        'select ticket_id,project_id,issue_id,scope_version_id,current_revision_id from alpha_private.ticket_work_bindings where workspace_id=$1 and issue_id=$2', [workspaceId, task.id]);
      expect(bindings.rows[0]).toMatchObject({ ticket_id: target.ticketId, project_id: project.id, issue_id: task.id, scope_version_id: scope.scopeVersionId });

      await db.query(`insert into public.agents(id,workspace_id,name,role,model_provider,model_name,autonomy_level,allowed_users,is_archived)
        values ('qa-trace-agent',$1,'QA agent','developer','openai','fixture','supervised','team',false)`, [workspaceId]);
      const lifecycle = createTicketLifecycleRuntime(db, true);
      const runId = 'qa-trace-run';
      const executor = { kind: 'agent' as const, id: 'qa-trace-agent' };
      const reserved = await lifecycle.reserve({ workspaceId, issueId: task.id }, developer, { operationId: randomUUID(), executor, runId });
      expect(reserved.kind).toBe('ticket');
      if (reserved.kind !== 'ticket') throw new Error('Ticket work was not reserved');
      expect(reserved.receipt.issueRevisionId).toBe(bindings.rows[0].current_revision_id);
      const admitted = await lifecycle.admit({ workspaceId, issueId: task.id }, developer,
        { claimId: reserved.receipt.claimId, runId, executor, memberOrder: 0 });
      expect(admitted).toMatchObject({ launch: true, context: { issueId: task.id, projectId: project.id, scopeVersionId: scope.scopeVersionId, brief: 'Approved developer work' } });
      await db.query(`insert into public.prototype_runs(id,workspace_id,owner_id,issue_id,project_id,agent_id,status)
        values ($1,$2,'qa-trace-dev',$3,$4,'qa-trace-agent','completed')`, [runId, workspaceId, task.id, project.id]);
      await taskStore.update(workspaceId, task.id, { status: 'review' });
      await expect(lifecycle.completeReviewedIssue({ workspaceId, issueId: task.id }, pm, runId)).resolves.toMatchObject({ kind: 'ticket', ready: true });
      const review = await db.query<{ issue_id: string; revision_id: string; run_id: string }>(
        'select issue_id,revision_id,run_id from alpha_private.ticket_issue_reviews where workspace_id=$1 and issue_id=$2', [workspaceId, task.id]);
      expect(review.rows[0]).toEqual({ issue_id: task.id, revision_id: bindings.rows[0].current_revision_id, run_id: runId });

      const prepared = await lifecycle.prepareResult(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), publicSummary: 'QA result ready for review.' });
      await lifecycle.commands.execute(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), command: { type: 'assess_delivery', deliveryId: prepared.deliveryId } });
      await lifecycle.commands.execute(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), command: { type: 'share_delivery', deliveryId: prepared.deliveryId } });
      const reads = createTicketReadService(new PostgresTicketReadStore(db));
      const detail = await reads.detail(target, client);
      expect(JSON.stringify(detail)).toContain('QA result ready for review.');
      expect(JSON.stringify(detail)).not.toContain('Approved developer work');
      expect(JSON.stringify(detail)).not.toContain(task.id);
      await expect(lifecycle.commands.execute(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(),
        command: { type: 'close_accepted', deliveryId: prepared.deliveryId } })).rejects.toMatchObject({ code: 'client_acceptance_required' });
      await messages.reply(target, client, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(),
        body: 'Please fix the requested behavior.', action: { type: 'request_correction', deliveryId: prepared.deliveryId } });
      await lifecycle.commands.execute(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(),
        command: { type: 'authorize_correction', deliveryId: prepared.deliveryId, issueIds: [task.id], reason: 'Correct the agreed behavior.' } });
      const correction = await db.query<{ ticket_id: string; current_revision_id: string }>(
        'select ticket_id,current_revision_id from alpha_private.ticket_work_bindings where workspace_id=$1 and issue_id=$2', [workspaceId, task.id]);
      expect(correction.rows[0].ticket_id).toBe(target.ticketId);
      expect(correction.rows[0].current_revision_id).not.toBe(bindings.rows[0].current_revision_id);
      expect((await taskStore.get(workspaceId, task.id))?.status).toBe('todo');
      await taskStore.update(workspaceId, task.id, { status: 'review' });
      await expect(lifecycle.completeReviewedIssue({ workspaceId, issueId: task.id }, pm)).resolves.toMatchObject({ kind: 'ticket', ready: true });
      const corrected = await lifecycle.prepareResult(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), publicSummary: 'Corrected QA result ready for review.' });
      await lifecycle.commands.execute(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), command: { type: 'assess_delivery', deliveryId: corrected.deliveryId } });
      await lifecycle.commands.execute(target, pm, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), command: { type: 'share_delivery', deliveryId: corrected.deliveryId } });
      expect(JSON.stringify(await reads.detail(target, client))).toContain('Corrected QA result ready for review.');
      const conversation = await reads.conversation(target, client);
      expect(conversation.items.map(item => item.body)).toEqual(['Client question', 'PM response', 'Please fix the requested behavior.']);
      await lifecycle.commands.execute(target, client, { schemaVersion: 1, operationId: randomUUID(), expectedVersion: await version(), command: { type: 'accept_delivery', deliveryId: corrected.deliveryId } });
      // Client acceptance closes the request; there is no separate PM closing step.
      expect((await reads.detail(target, client)).status).toBe('closed');
    } finally {
      await pg.close();
    }
  }, 120_000);
});
