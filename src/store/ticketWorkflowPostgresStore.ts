import { createHash, randomUUID } from 'node:crypto';
import type { Sql, TransactionalSql } from './database.js';
import { createTicketTriageTransaction } from './ticketTriagePostgresStore.js';
import type { LockedTicket, TicketTarget } from './ticketCommandStore.js';
import type { TicketMessageTransaction } from './ticketMessageStore.js';
import type { TicketScopeProposalTransaction } from './ticketScopeStore.js';
import type { TicketDeliveryTransaction, TicketDeliverySnapshot, TicketDeliveryObjectReader } from './ticketDeliveryStore.js';
import type { TicketDeliveryAssessmentTransaction, TicketDeliveryAssessmentCandidate } from './ticketDeliveryAssessmentStore.js';
import type { SavedTicketReadiness } from './ticketTechnicalReadinessStore.js';
import { decodeTicketWorkflow, ticketSqlIso } from './ticketPostgresCodec.js';
import { TicketWorkflowError, type TicketFacts, type TicketIssueEvidence } from '../ticketing/workflow.js';

export type TicketWorkflowTransaction = TicketMessageTransaction & TicketScopeProposalTransaction
  & TicketDeliveryTransaction & TicketDeliveryAssessmentTransaction;

const conflict = (message: string): never => { throw new TicketWorkflowError(409, 'ticket_manifest_conflict', message); };
export const ticketManifestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Durable lifecycle adapters share the same transaction and authorization as
 * existing ticket messages. No provider or runner calls execute in a transaction. */
export class PostgresTicketWorkflowStore {
  constructor(private readonly db: TransactionalSql) {}
  transaction<T>(work: (tx: TicketWorkflowTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(createTicketWorkflowTransaction(sql)));
  }
}

export async function ticketClientAccess(sql: Sql, ticket: LockedTicket): Promise<boolean> {
  const { state } = ticket;
  const { rows } = await sql.query<{ active: boolean }>(
    `select exists(select 1 from alpha_private.ticket_client_grants cg
       join alpha_private.ticket_service_grants sg using(workspace_id,client_user_id)
       where cg.workspace_id=$1 and cg.ticket_id=$2 and cg.client_user_id=$3
         and cg.active and cg.revoked_at is null and sg.status='active' and sg.revoked_at is null) as active`,
    [state.workspaceId, state.id, state.clientId]);
  return rows[0]?.active === true;
}

export async function ticketProjectFacts(sql: Sql, workspaceId: string, projectId: string) {
  const { rows } = await sql.query<{ id: string; workspace_id: string; status: string; created_by: string }>(
    `select id,workspace_id,status,created_by from public.projects where workspace_id=$1 and id=$2 for share`,
    [workspaceId, projectId]);
  const project = rows[0];
  if (!project) return undefined;
  const { rows: owners } = await sql.query(
    `select user_id from public.workspace_members where workspace_id=$1 and user_id=$2 and role='pm' and status='active' for share`,
    [workspaceId, project.created_by]);
  return { id: project.id, workspaceId, creatorActive: owners.length === 1,
    // Execution always uses the existing runner's feature branch/release gates.
    // Archived/completed projects cannot accept new execution authorization.
    nonProductionSafe: !['completed', 'cancelled', 'archived'].includes(project.status) };
}

export async function ticketIssueFacts(sql: Sql, ticket: LockedTicket, ids: readonly string[], initial?: { projectId: string; scopeVersionId: string }): Promise<TicketIssueEvidence[]> {
  const result: TicketIssueEvidence[] = [];
  for (const id of [...ids].sort()) {
    const { rows } = await sql.query<{ id: string; project_id: string; status: TicketIssueEvidence['status'] }>(
      `select id,project_id,status from public.issues where workspace_id=$1 and id=$2 for update`, [ticket.state.workspaceId, id]);
    const issue = rows[0];
    if (!issue) continue;
    const { rows: bindings } = await sql.query<{ ticket_id: string; scope_version_id: string; current_revision_id: string; project_id: string }>(
      `select ticket_id,scope_version_id,current_revision_id,project_id from alpha_private.ticket_work_bindings
        where workspace_id=$1 and issue_id=$2 for update`, [ticket.state.workspaceId, id]);
    const binding = bindings[0];
    if (initial && binding) conflict('An Issue is already linked to authorized ticket work.');
    if (initial) {
      // A task linked to another client request from the conversation stays with that request.
      const { rows: links } = await sql.query<{ ticket_id: string }>(
        `select ticket_id from alpha_private.request_task_links where workspace_id=$1 and issue_id=$2 for share`,
        [ticket.state.workspaceId, id]);
      if (links.some(link => link.ticket_id !== ticket.state.id)) conflict('An Issue already belongs to another client request.');
    }
    if (!initial && (!binding || binding.ticket_id !== ticket.state.id || binding.project_id !== issue.project_id)) continue;
    const { rows: activity } = await sql.query<{ active: boolean }>(
      `select (exists(select 1 from alpha_private.ticket_execution_claims where workspace_id=$1 and issue_id=$2 and phase in ('reserved','admitted'))
        or exists(select 1 from public.prototype_runs where workspace_id=$1 and issue_id=$2 and status in ('queued','running','awaiting_approval'))
        or exists(select 1 from public.squad_runs where workspace_id=$1 and issue_id=$2 and status in ('queued','running'))) as active`,
      [ticket.state.workspaceId, id]);
    const revisionId = initial ? randomUUID() : binding!.current_revision_id;
    const { rows: reviews } = await sql.query(
      `select issue_id from alpha_private.ticket_issue_reviews where workspace_id=$1 and issue_id=$2 and revision_id=$3 and verdict='passed' for share`,
      [ticket.state.workspaceId, id, revisionId]);
    result.push({ id, revisionId, ticketId: ticket.state.id, workspaceId: ticket.state.workspaceId,
      projectId: issue.project_id, scopeVersionId: initial?.scopeVersionId ?? binding!.scope_version_id,
      status: issue.status, hasActiveRun: activity[0]?.active !== false, requiredReviewsPassed: reviews.length === 1 });
  }
  return result;
}

export function createTicketWorkflowTransaction(sql: Sql): TicketWorkflowTransaction {
  const base = createTicketTriageTransaction(sql, { communicationEnabled: true });
  let locked: LockedTicket | null = null;
  const requireTicket = () => { if (!locked) throw new Error('Ticket authorization is required.'); return locked; };
  const scoped = (workspaceId: string, ticketId: string) => {
    const ticket = requireTicket();
    if (workspaceId !== ticket.state.workspaceId || ticketId !== ticket.state.id) throw new Error('Foreign ticket transaction.');
    return ticket;
  };
  const tx: TicketWorkflowTransaction = {
    ...base,
    async lockAuthorizedTicket(target, subject) {
      locked = await base.lockAuthorizedTicket(target, subject);
      return locked;
    },
    async loadFacts(ticket, envelope): Promise<TicketFacts> {
      scoped(ticket.state.workspaceId, ticket.state.id);
      const command = envelope.command;
      const projectId = command.type === 'authorize_work' ? command.projectId : ticket.state.projectId;
      const facts: TicketFacts = { clientAccessActive: await ticketClientAccess(sql, ticket) };
      if (projectId) facts.project = await ticketProjectFacts(sql, ticket.state.workspaceId, projectId);
      const ids = command.type === 'authorize_work' ? command.issueIds : ticket.state.requiredIssueIds;
      facts.issues = await ticketIssueFacts(sql, ticket, ids, command.type === 'authorize_work' ? command : undefined);
      facts.workStopped = facts.issues.length === ids.length && facts.issues.every(issue => !issue.hasActiveRun);
      const scopeId = command.type === 'propose_scope' ? command.scopeVersionId : ticket.state.scopeVersionId;
      if (scopeId) {
        const { rows } = await sql.query<{ id: string }>(`select id from alpha_private.ticket_scopes where workspace_id=$1 and ticket_id=$2 and id=$3 and immutable and client_visible for share`,
          [ticket.state.workspaceId, ticket.state.id, scopeId]);
        if (rows[0]) facts.scope = { id: rows[0].id, workspaceId: ticket.state.workspaceId, ticketId: ticket.state.id };
      }
      if ('messageId' in command) {
        const { rows } = await sql.query<{ id: string; author_id: string; audience: 'client' }>(
          `select id,author_id,audience from alpha_private.ticket_messages where workspace_id=$1 and ticket_id=$2 and id=$3 and audience='client' for share`,
          [ticket.state.workspaceId, ticket.state.id, command.messageId]);
        if (rows[0]) facts.message = { id: rows[0].id, authorId: rows[0].author_id, ticketId: ticket.state.id, audience: 'client' };
      }
      if ('deliveryId' in command) {
        const snapshot = await tx.loadDelivery(ticket, command.deliveryId);
        if (snapshot) facts.delivery = { id: snapshot.delivery.id, scopeVersionId: snapshot.delivery.scopeVersionId,
          pinnedAssetId: snapshot.delivery.pinnedAssetId, immutable: snapshot.delivery.immutable, issueRevisionIds: snapshot.delivery.issueRevisionIds };
      }
      return facts;
    },
    async saveWorkflow(target, expectedVersion, state) {
      scoped(target.workspaceId, target.ticketId);
      if (state.id !== target.ticketId || state.workspaceId !== target.workspaceId || state.version !== expectedVersion + 1) throw new Error('Invalid workflow write.');
      const { rows } = await sql.query(
        `update alpha_private.tickets set workflow_state=$4::jsonb,status=$5,version=$6,project_id=$7,
          project_display_name=case when project_id is distinct from $7 then (select name from public.projects where workspace_id=$1 and id=$7) else project_display_name end,
          client_updated_at=greatest(client_updated_at,now()),internal_updated_at=greatest(internal_updated_at,now()),
          closed_at=case when $5 in ('closed','declined','cancelled') then now() else closed_at end
          where workspace_id=$1 and id=$2 and version=$3 returning id`,
        [target.workspaceId,target.ticketId,expectedVersion,JSON.stringify(state),state.status,state.version,state.projectId]);
      if (rows.length && state.delivery?.shared) await sql.query(
        `update alpha_private.ticket_deliveries set shared_at=coalesce(shared_at,now()) where workspace_id=$1 and ticket_id=$2 and id=$3`,
        [target.workspaceId,target.ticketId,state.delivery.id]);
      return rows.length === 1;
    },
    async insertWorkBindings(bindings) {
      const ticket = requireTicket();
      if (ticket.actor.kind !== 'pm') throw new Error('PM required.');
      for (const binding of [...bindings].sort((a,b) => a.issueId.localeCompare(b.issueId))) {
        scoped(binding.workspaceId,binding.ticketId);
        const { rows } = await sql.query(`select id from public.issues where workspace_id=$1 and id=$2 and project_id=$3 and status in ('backlog','todo') for update`,
          [binding.workspaceId,binding.issueId,binding.projectId]);
        if (rows.length !== 1) conflict('The selected Issue changed before authorization.');
        await sql.query(`insert into alpha_private.ticket_work_bindings
          (workspace_id,ticket_id,project_id,issue_id,scope_version_id,initial_revision_id,current_revision_id,authorized_by,authorized_at)
          values ($1,$2,$3,$4,$5,$6,$6,$7,$8)`,
          [binding.workspaceId,binding.ticketId,binding.projectId,binding.issueId,binding.scopeVersionId,binding.issueRevisionId,binding.authorizedByPmId,binding.authorizedAt]);
        await sql.query(`insert into alpha_private.ticket_issue_revisions
          (workspace_id,ticket_id,project_id,issue_id,scope_version_id,revision_id,authorized_by,authorized_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [binding.workspaceId,binding.ticketId,binding.projectId,binding.issueId,binding.scopeVersionId,binding.issueRevisionId,binding.authorizedByPmId,binding.authorizedAt]);
      }
    },
    async reopenIssues(ticket, corrections) {
      for (const correction of [...corrections].sort((a,b) => a.issueId.localeCompare(b.issueId))) {
        scoped(correction.workspaceId,correction.ticketId);
        const { rows: active } = await sql.query(`select id from alpha_private.ticket_execution_claims where workspace_id=$1 and issue_id=$2 and phase in ('reserved','admitted')`, [correction.workspaceId,correction.issueId]);
        if (active.length) conflict('Resolve the current execution before authorizing corrections.');
        const { rows } = await sql.query(`update alpha_private.ticket_work_bindings set current_revision_id=$5
          where workspace_id=$1 and ticket_id=$2 and issue_id=$3 and current_revision_id=$4 returning issue_id`,
          [correction.workspaceId,correction.ticketId,correction.issueId,correction.previousRevisionId,correction.issueRevisionId]);
        if (rows.length !== 1) conflict('The correction revision changed.');
        await sql.query(`insert into alpha_private.ticket_issue_revisions
          (workspace_id,ticket_id,project_id,issue_id,scope_version_id,revision_id,previous_revision_id,instructions,source,authorized_by,authorized_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [correction.workspaceId,correction.ticketId,correction.projectId,correction.issueId,correction.scopeVersionId,
            correction.issueRevisionId,correction.previousRevisionId,correction.developerInstructions,correction.source,correction.authorizedByPmId,correction.authorizedAt]);
        await sql.query(`update public.issues set status='todo',updated_at=now() where workspace_id=$1 and id=$2 and project_id=$3`, [correction.workspaceId,correction.issueId,ticket.state.projectId]);
      }
    },
    async findScopeProposal(key) {
      scoped(key.workspaceId,key.ticketId);
      const { rows } = await sql.query<{ fingerprint: string; receipt: unknown }>(`select fingerprint,receipt from alpha_private.ticket_scope_operations where workspace_id=$1 and ticket_id=$2 and actor_id=$3 and operation_id=$4`,
        [key.workspaceId,key.ticketId,key.actorId,key.operationId]);
      return rows[0] ? { key, fingerprint: rows[0].fingerprint, receipt: rows[0].receipt as import('./ticketScopeStore.js').TicketScopeProposalReceipt } : null;
    },
    async insertScopeVersion(scope) {
      scoped(scope.workspaceId,scope.ticketId);
      if (requireTicket().actor.kind !== 'pm') throw new Error('PM required.');
      await sql.query(`insert into alpha_private.ticket_scopes(id,workspace_id,ticket_id,public_summary,developer_brief,immutable,client_visible,proposed_at)
        values ($1,$2,$3,$4,$5,true,true,$6)`, [scope.id,scope.workspaceId,scope.ticketId,scope.publicSummary,scope.developerBrief,scope.proposedAt]);
    },
    async insertScopeProposal(saved) {
      scoped(saved.key.workspaceId,saved.key.ticketId);
      await sql.query(`insert into alpha_private.ticket_scope_operations(workspace_id,ticket_id,actor_id,operation_id,fingerprint,receipt) values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [saved.key.workspaceId,saved.key.ticketId,saved.key.actorId,saved.key.operationId,saved.fingerprint,JSON.stringify(saved.receipt)]);
    },
    async loadDelivery(ticket, deliveryId) {
      scoped(ticket.state.workspaceId,ticket.state.id);
      // Clients can only query the currently published pointer, even under owner SQL.
      if (ticket.actor.kind === 'client' && (ticket.state.delivery?.id !== deliveryId || !ticket.state.delivery.shared)) return null;
      const { rows } = await sql.query<{ snapshot: TicketDeliverySnapshot; shared_at: Date | string | null }>(
        `select r.snapshot,d.shared_at from alpha_private.ticket_delivery_registrations r
         join alpha_private.ticket_deliveries d using(workspace_id,ticket_id,id)
         where r.workspace_id=$1 and r.ticket_id=$2 and r.id=$3 for share of r,d`, [ticket.state.workspaceId,ticket.state.id,deliveryId]);
      if (!rows[0]) return null;
      const snapshot = structuredClone(rows[0].snapshot);
      snapshot.delivery.sharedAt = rows[0].shared_at ? ticketSqlIso(rows[0].shared_at) : null;
      return snapshot;
    },
    async loadAssessmentCandidate(ticket, deliveryId) { return tx.loadCandidate(ticket,deliveryId); },
    async loadCandidate(ticket, deliveryId): Promise<TicketDeliveryAssessmentCandidate | null> {
      if (ticket.actor.kind !== 'pm') return null;
      const snapshot = await tx.loadDelivery(ticket,deliveryId);
      if (!snapshot || snapshot.delivery.sharedAt !== null) return null;
      const { rows } = await sql.query<{ readiness: SavedTicketReadiness }>(
        `select m.readiness from alpha_private.ticket_delivery_registrations r
         join alpha_private.ticket_ready_manifests m on m.workspace_id=r.workspace_id and m.ticket_id=r.ticket_id and m.id=r.ready_manifest_id
         where r.workspace_id=$1 and r.ticket_id=$2 and r.id=$3 for share of m`, [ticket.state.workspaceId,ticket.state.id,deliveryId]);
      if (!rows[0]) return null;
      const facts = await tx.loadFacts(ticket,{schemaVersion:1,operationId:'candidate-read',expectedVersion:ticket.state.version,command:{type:'review'}});
      return { snapshot, facts, readiness: rows[0].readiness };
    },
    async loadCandidates(ticket,page) {
      if (ticket.actor.kind !== 'pm') return [];
      scoped(ticket.state.workspaceId,ticket.state.id);
      if (page.after && !await tx.loadCandidate(ticket,page.after)) throw new TicketWorkflowError(404,'ticket_delivery_not_found','Result candidate not found.');
      const { rows } = await sql.query<{ id: string }>(`select r.id from alpha_private.ticket_delivery_registrations r
        join alpha_private.ticket_ready_manifests m on m.workspace_id=r.workspace_id and m.ticket_id=r.ticket_id and m.id=r.ready_manifest_id
        where r.workspace_id=$1 and r.ticket_id=$2 and m.scope_version_id=$3
          and ($4::text is null or r.id collate "C">$4 collate "C")
          and not exists(select 1 from alpha_private.ticket_work_bindings b
            where b.workspace_id=r.workspace_id and b.ticket_id=r.ticket_id
              and not exists(select 1 from jsonb_array_elements(m.readiness->'manifest'->'issueRevisions') v
                where v->>'issueId'=b.issue_id and v->>'revisionId'=b.current_revision_id))
        order by r.id collate "C" limit $5`, [ticket.state.workspaceId,ticket.state.id,ticket.state.scopeVersionId,page.after,page.limit+1]);
      const result: TicketDeliveryAssessmentCandidate[]=[];
      for (const row of rows) { const candidate=await tx.loadCandidate(ticket,row.id); if (candidate) result.push(candidate); }
      return result;
    },
  };
  return tx;
}

/** Immutable bounded text previews live in the private database, with no public URL. */
export class PostgresTicketResultObjects implements TicketDeliveryObjectReader {
  constructor(private readonly db: Sql) {}
  async read(input: Parameters<TicketDeliveryObjectReader['read']>[0]): Promise<Uint8Array> {
    input.signal.throwIfAborted();
    const { rows } = await this.db.query<{ content: Uint8Array }>(`select content from alpha_private.ticket_result_objects
      where workspace_id=$1 and ticket_id=$2 and asset_id=$3 and file_id=$4 and object_key=$5 and object_version=$6
      and octet_length(content)<=$7`, [input.workspaceId,input.ticketId,input.pinnedAssetId,input.fileId,input.key,input.version,input.maxBytes]);
    input.signal.throwIfAborted();
    if (!rows[0]) throw new Error('Result object unavailable.');
    return Buffer.from(rows[0].content);
  }
}
