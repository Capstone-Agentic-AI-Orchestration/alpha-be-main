import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTicketClientIntakeContextService } from '../services/ticketClientIntakeContextService.js';
import { createTicketCreationService } from '../services/ticketCreationService.js';
import { createTicketProjectManagementService } from '../services/ticketProjectManagementService.js';
import { createTicketQueueService } from '../services/ticketQueueService.js';
import { createTicketReadService } from '../services/ticketReadService.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import type { PmTicketQueueItem } from '../ticketing/queueModels.js';
import type { TicketSubject } from './ticketCommandStore.js';
import type { TransactionalSql } from './database.js';
import { createTestDatabase, sqlFor } from './testDatabase.js';
import { PostgresTicketClientIntakeContextStore } from './ticketClientIntakeContextPostgresStore.js';
import { PostgresTicketCreationStore, ticketClientProjectOptionId } from './ticketCreationPostgresStore.js';
import { PostgresTicketProjectManagementStore } from './ticketProjectManagementPostgresStore.js';
import { PostgresTicketQueueStore } from './ticketQueuePostgresStore.js';
import { PostgresTicketReadStore } from './ticketReadPostgresStore.js';
import { PostgresProjectStore } from './postgresProjectStore.js';
import { ProjectLinkedToTicketError } from './projectStore.js';

const workspaceId = 'phase6-workspace';
const otherWorkspaceId = 'phase6-other-workspace';
const pmId = 'phase6-pm';
const clientId = 'phase6-client';
const firstTicketId = 'phase6-existing-request';
const projectId = 'phase6-project';
const visibleProjectName = 'Client Preview Name';
const now = new Date();
const sessionId = createHash('sha256').update('phase6-client-session').digest('hex');
const client: Extract<TicketSubject, { kind: 'client' }> = { kind: 'client', userId: clientId, sessionId };
const pm: Extract<TicketSubject, { kind: 'internal' }> = {
  kind: 'internal', userId: pmId,
  authentication: { kind: 'verified_github_bearer', verificationId: 'phase6-pm-credential' },
};

let pg: PGlite;
let db: TransactionalSql;

beforeEach(async () => {
  pg = await createTestDatabase();
  const sql = sqlFor(pg);
  db = { ...sql, transaction: work => pg.transaction(async tx => work(sqlFor(tx as unknown as PGlite))) };
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json) values
    ($1,'Phase 6 workspace','phase6-workspace','active','{"ticketing_write_mode":"enabled"}'),
    ($2,'Other workspace','phase6-other-workspace','active','{"ticketing_write_mode":"enabled"}')`, [workspaceId, otherWorkspaceId]);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values
    ('phase6-pm-member',$1,$2,'pm')`, [workspaceId, pmId]);
  await db.query(`insert into alpha_private.ticket_service_grants
    (id,workspace_id,client_user_id,status,display_name,accepts_new_requests,write_mode)
    values ('phase6-client-grant',$1,$2,'active','Phase 6 Client',true,'enabled')`, [workspaceId, clientId]);
  await db.query(`insert into alpha_private.ticket_client_sessions
    (session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
    values ($1,$2,$3,$4,$5)`, [sessionId, clientId, 'a'.repeat(64), new Date(now.getTime() - 60_000), new Date(now.getTime() + 3_600_000)]);
  await db.query(`insert into public.projects(id,workspace_id,name,key,status)
    values ($1,$2,$4,'P6','active'),('phase6-other-project',$3,'Other Project','OTHER6','active')`,
  [projectId, workspaceId, otherWorkspaceId, visibleProjectName]);
  const state = newTicketWorkflow(firstTicketId, workspaceId, clientId);
  await db.query(`insert into alpha_private.tickets
    (id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,workflow_state,
     client_user_id,created_at,client_updated_at,internal_updated_at)
    values ($1,$2,'TKT-PHASE6-1','Existing request','Original request body','Phase 6 Client',
      'authenticated_client','received',0,$3::jsonb,$4,$5,$5,$5)`,
  [firstTicketId, workspaceId, JSON.stringify(state), clientId, now]);
  await db.query(`insert into alpha_private.ticket_requests(workspace_id,ticket_id,source,project_preference)
    values ($1,$2,'authenticated_client','not_sure')`, [workspaceId, firstTicketId]);
  await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active)
    values ($1,$2,$3,true)`, [workspaceId, firstTicketId, clientId]);
}, 60_000);

afterEach(async () => { await pg?.close(); });

describe('PM project organization and client requests on the main migration schema', () => {
  it('links requests under a project, shares only its name, and allows authorized clients to submit a separate request', async () => {
    const projectService = createTicketProjectManagementService(new PostgresTicketProjectManagementStore(db), () => now);
    const linkInput = { schemaVersion: 1 as const, operationId: 'phase6-link-1', expectedVersion: 0,
      projectId, clientVisible: true };
    const link = await projectService.linkProject({ workspaceId, ticketId: firstTicketId }, pm, linkInput);
    expect(link).toMatchObject({ projectId, projectName: visibleProjectName, clientVisible: true, version: 1 });
    expect(await projectService.linkProject({ workspaceId, ticketId: firstTicketId }, pm, linkInput)).toEqual(link);

    const detail = await createTicketReadService(new PostgresTicketReadStore(db))
      .detail({ workspaceId, ticketId: firstTicketId }, client);
    expect(detail.sharedProjectName).toBe(visibleProjectName);
    expect(JSON.stringify(detail)).not.toContain(projectId);
    expect(JSON.stringify(detail)).not.toContain('requiredIssueIds');

    const intake = createTicketClientIntakeContextService(new PostgresTicketClientIntakeContextStore(db));
    const context = await intake.get(workspaceId, client);
    expect(context.canCreate).toBe(true);
    expect(context.sharedProjects).toEqual([{ optionId: ticketClientProjectOptionId(workspaceId, clientId, projectId), displayName: visibleProjectName }]);
    expect(JSON.stringify(context)).not.toContain(projectId);

    const creation = createTicketCreationService(new PostgresTicketCreationStore(db), () => now, () => 'phase6-follow-up');
    const receipt = await creation.create(context.intakeContextId, client, {
      schemaVersion: 1, operationId: 'phase6-create-1', title: 'A separate request',
      description: 'A new request has its own ticket and conversation.',
      projectPreference: { kind: 'shared_project', optionId: context.sharedProjects[0]!.optionId },
    });
    expect(receipt).toMatchObject({ ticketId: 'phase6-follow-up', status: 'received', version: 0 });
    const created = await db.query<{ project_id: string | null; preferred_project_id: string | null }>(
      `select t.project_id,r.preferred_project_id from alpha_private.tickets t
        join alpha_private.ticket_requests r on r.workspace_id=t.workspace_id and r.ticket_id=t.id
        where t.workspace_id=$1 and t.id=$2`, [workspaceId, receipt.ticketId]);
    expect(created.rows[0]).toEqual({ project_id: null, preferred_project_id: projectId });

    const queue = await createTicketQueueService(new PostgresTicketQueueStore(db), () => now)
      .list(workspaceId, pm);
    const pmItems = queue.items.filter((item): item is PmTicketQueueItem => 'internal' in item);
    expect(queue.items.map(item => item.id)).toContain(firstTicketId);
    expect(queue.items.map(item => item.id)).toContain(receipt.ticketId);
    expect(pmItems.filter(item => item.internal.clientGroup?.key === `client:${clientId}`)).toHaveLength(2);
    expect(pmItems.find(item => item.id === firstTicketId)?.internal).toMatchObject({
      projectId, projectName: visibleProjectName, clientGroup: {
        displayName: 'Phase 6 Client', accessActive: true, acceptsNewRequests: true,
      },
    });
    expect(pmItems.find(item => item.id === receipt.ticketId)?.internal.projectId).toBeNull();

    const access = await projectService.setClientRequestsEnabled({ workspaceId, ticketId: firstTicketId }, pm,
      { acceptsNewRequests: false });
    expect(access).toEqual({ ticketId: firstTicketId, acceptsNewRequests: false });
    expect((await intake.get(workspaceId, client)).canCreate).toBe(false);
    await expect(creation.create(context.intakeContextId, client, {
      schemaVersion: 1, operationId: 'phase6-create-disabled', title: 'Blocked request', description: 'Should not be written.',
    })).rejects.toMatchObject({ status: 503, code: 'ticket_writes_disabled' });
  }, 60_000);

  it('rejects client project-management actions and cross-workspace project links without changing the ticket', async () => {
    const service = createTicketProjectManagementService(new PostgresTicketProjectManagementStore(db), () => now);
    await expect(service.linkProject({ workspaceId, ticketId: firstTicketId }, client, {
      schemaVersion: 1, operationId: 'client-cannot-link', expectedVersion: 0, projectId, clientVisible: true,
    })).rejects.toMatchObject({ status: 403 });
    await expect(service.linkProject({ workspaceId, ticketId: firstTicketId }, pm, {
      schemaVersion: 1, operationId: 'cross-workspace-link', expectedVersion: 0,
      projectId: 'phase6-other-project', clientVisible: true,
    })).rejects.toMatchObject({ status: 404 });
    const ticket = await db.query<{ project_id: string | null; version: number }>(
      `select project_id,version from alpha_private.tickets where workspace_id=$1 and id=$2`, [workspaceId, firstTicketId]);
    expect(ticket.rows[0]).toEqual({ project_id: null, version: 0 });
  }, 60_000);

  it('shares only a ready hosted preview on the linked ticket and prevents deleting a linked project', async () => {
    const service = createTicketProjectManagementService(new PostgresTicketProjectManagementStore(db), () => now);
    const preview = { repository: 'Capstone-Agentic-AI-Orchestration/alpha-fe-main', branch: 'main' as const,
      url: 'https://alpha-fe-main.vercel.app/' };
    const link = await service.linkProject({ workspaceId, ticketId: firstTicketId }, pm, {
      schemaVersion: 1, operationId: 'phase6-preview-link', expectedVersion: 0,
      projectId, clientVisible: true, projectPreview: preview,
    });
    expect(link.projectPreview).toEqual(preview);
    const reader = createTicketReadService(new PostgresTicketReadStore(db));
    await expect(reader.detail({ workspaceId, ticketId: firstTicketId }, client))
      .resolves.toMatchObject({ sharedProjectName: visibleProjectName, sharedProjectPreviewUrl: preview.url });
    await expect(reader.detail({ workspaceId, ticketId: firstTicketId }, pm))
      .resolves.toMatchObject({ internal: { projectPreview: preview } });
    await expect(service.linkProject({ workspaceId, ticketId: firstTicketId }, pm, {
      schemaVersion: 1, operationId: 'phase6-preview-untrusted-host', expectedVersion: 1,
      projectId, clientVisible: true, projectPreview: { ...preview, url: 'https://example.com/' },
    })).rejects.toMatchObject({ status: 400, code: 'invalid_ticket_project_link' });
    await expect(new PostgresProjectStore(db).remove(workspaceId, projectId)).rejects.toBeInstanceOf(ProjectLinkedToTicketError);
  }, 60_000);

  it('shows client replies as unread to PMs until that PM opens the conversation', async () => {
    await db.query(`insert into alpha_private.ticket_messages
      (id,workspace_id,ticket_id,author_kind,author_id,audience,body,created_at)
      values ('phase6-client-reply',$1,$2,'client',$3,'client','Please clarify the timeline.',$4)`,
    [workspaceId, firstTicketId, clientId, new Date(now.getTime() + 1_000)]);
    const queue = createTicketQueueService(new PostgresTicketQueueStore(db), () => now);
    const initial = await queue.list(workspaceId, pm);
    expect((initial.items[0] as PmTicketQueueItem).internal.clientReplyUnread).toBe(true);
    expect(JSON.stringify(await queue.list(workspaceId, client))).not.toContain('clientReplyUnread');
    await createTicketReadService(new PostgresTicketReadStore(db)).conversation({ workspaceId, ticketId: firstTicketId }, pm);
    const afterRead = await queue.list(workspaceId, pm);
    expect((afterRead.items[0] as PmTicketQueueItem).internal.clientReplyUnread).toBe(false);
  }, 60_000);

  it('removes a ticket from the client queue as soon as its grant is revoked', async () => {
    const queue = createTicketQueueService(new PostgresTicketQueueStore(db), () => now);
    expect((await queue.list(workspaceId, client)).items.map(item => item.id)).toContain(firstTicketId);
    await db.query(`update alpha_private.ticket_client_grants set revoked_at=$3
      where workspace_id=$1 and ticket_id=$2 and client_user_id=$4`,
    [workspaceId, firstTicketId, now, clientId]);
    expect((await queue.list(workspaceId, client)).items.map(item => item.id)).not.toContain(firstTicketId);
  }, 60_000);
});
