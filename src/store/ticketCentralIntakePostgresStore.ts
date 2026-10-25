import { createHash, randomUUID } from 'node:crypto';
import type { Sql, TransactionalSql } from './database.js';
import type { TicketSubject } from './ticketCommandStore.js';
import type {
  CentralIntakeAcceptance, CentralIntakeCursor, CentralIntakeDeclineReceipt, CentralIntakeFingerprint, CentralIntakeItem,
  CentralIntakePage, CentralIntakeRatePolicy, TicketCentralIntakeStore,
} from './ticketCentralIntakeStore.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { decodeTicketWorkflow } from './ticketPostgresCodec.js';

interface CentralIntakeDbRow {
  id: string; public_reference: string; full_name: string; email: string; company: string | null; title: string;
  description: string; requested_deadline: string | null; submitted_at: Date | string;
  status: 'pending' | 'accepted' | 'declined'; handled_at: Date | string | null;
  outcome_email_status: CentralIntakeItem['outcomeEmailStatus'];
}
interface SavedOperationDbRow {
  id: string; fingerprint: string; fingerprint_key_id: string; status: string;
  accepted_by: string | null; accepted_workspace_id: string | null; accepted_ticket_id: string | null;
  acceptance_operation_id: string | null; reference?: string | null;
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid central inquiry timestamp.');
  return parsed.toISOString();
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
}
function mapItem(row: CentralIntakeDbRow): CentralIntakeItem {
  if (!text(row.id) || typeof row.public_reference !== 'string' || !/^INQ-[A-F0-9]{32}$/.test(row.public_reference)
    || typeof row.full_name !== 'string' || !row.full_name.trim() || row.full_name.length > 160
    || typeof row.email !== 'string' || !row.email.trim() || row.email.length > 254
    || (row.company !== null && (typeof row.company !== 'string' || row.company.length > 160))
    || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 160
    || typeof row.description !== 'string' || !row.description.trim() || row.description.length > 6000
    || (row.requested_deadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(row.requested_deadline))) {
    throw new Error('Central inquiry row is invalid.');
  }
  return { id: row.id, publicReference: row.public_reference, fullName: row.full_name, email: row.email, company: row.company, title: row.title,
    description: row.description, requestedDeadline: row.requested_deadline, submittedAt: iso(row.submitted_at),
    status: row.status, handledAt: row.handled_at ? iso(row.handled_at) : null, outcomeEmailStatus: row.outcome_email_status ?? null };
}

/** Server-only global intake persistence. Ticket rows are created only when a PM accepts. */
export class PostgresTicketCentralIntakeStore implements TicketCentralIntakeStore {
  constructor(private readonly db: TransactionalSql) {}

  async consumeAttempt(organizationKey: string, sourceHash: string, occurredAt: string,
    policy: CentralIntakeRatePolicy): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    if (!text(organizationKey) || !/^[a-f0-9]{64}$/.test(sourceHash)
      || !Number.isSafeInteger(policy.perSourceMax) || policy.perSourceMax < 1
      || !Number.isSafeInteger(policy.perOrganizationMax) || policy.perOrganizationMax < 1
      || !Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds < 1 || policy.windowSeconds > 86400) {
      throw new Error('Central intake rate policy is invalid.');
    }
    const timestamp = Date.parse(occurredAt);
    if (!Number.isFinite(timestamp)) throw new Error('Central intake timestamp is invalid.');
    const nowSeconds = timestamp / 1000;
    const windowStartSeconds = Math.floor(nowSeconds / policy.windowSeconds) * policy.windowSeconds;
    const windowStartedAt = new Date(windowStartSeconds * 1000).toISOString();
    const retryAfterSeconds = Math.max(1, Math.min(policy.windowSeconds,
      Math.ceil(windowStartSeconds + policy.windowSeconds - nowSeconds)));
    const organizationHash = createHash('sha256').update(organizationKey).digest('hex');
    try {
      await this.db.transaction(async tx => {
        // The organization row serializes both limits. If either is denied,
        // the transaction rolls back both counters; failed writes still count.
        await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`central-intake-rate:${organizationKey}:${windowStartedAt}`]);
        for (const bucket of [
          { kind: 'source' as const, hash: sourceHash, maximum: policy.perSourceMax },
          { kind: 'organization' as const, hash: organizationHash, maximum: policy.perOrganizationMax },
        ]) {
          const { rows } = await tx.query<{ attempts: number }>(
            `insert into alpha_private.ticket_central_intake_rate_buckets
               (organization_key,bucket_kind,subject_hash,window_started_at,window_seconds,attempts,updated_at)
             values ($1,$2,$3,$4,$5,1,$6)
             on conflict (organization_key,bucket_kind,subject_hash,window_started_at)
             do update set attempts=alpha_private.ticket_central_intake_rate_buckets.attempts+1,
                           window_seconds=excluded.window_seconds,updated_at=excluded.updated_at
             where alpha_private.ticket_central_intake_rate_buckets.attempts<$7
             returning attempts`,
            [organizationKey, bucket.kind, bucket.hash, windowStartedAt, policy.windowSeconds, occurredAt, bucket.maximum],
          );
          if (rows.length !== 1) throw new Error('Central inquiry rate limit reached.');
        }
      });
      return { allowed: true };
    } catch (error) {
      if (error instanceof Error && error.message === 'Central inquiry rate limit reached.') {
        return { allowed: false, retryAfterSeconds };
      }
      throw error;
    }
  }

  async submit(organizationKey: string, id: string, publicReference: string, input: import('../ticketing/intake.js').PublicTicketInquiryInput,
    fingerprints: readonly CentralIntakeFingerprint[], occurredAt: string): Promise<{ kind: 'received'; publicReference: string } | { kind: 'conflict' }> {
    if (!text(organizationKey) || !text(id) || !/^INQ-[A-F0-9]{32}$/.test(publicReference)
      || !Number.isFinite(Date.parse(occurredAt)) || fingerprints.length === 0) {
      throw new Error('Central inquiry submission is invalid.');
    }
    return this.db.transaction(async tx => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`central-intake-submit:${organizationKey}:${input.operationId}`]);
      const existing = await tx.query<{ operation_id: string; fingerprint: string; fingerprint_key_id: string; public_reference: string }>(
        `select operation_id,fingerprint,fingerprint_key_id,public_reference from alpha_private.ticket_central_intakes
         where organization_key=$1 and operation_id=$2 for update`, [organizationKey, input.operationId]);
      if (existing.rows[0]) {
        const saved = existing.rows[0];
        const candidate = fingerprints.find(item => item.keyId === saved.fingerprint_key_id);
        return candidate && saved.fingerprint === candidate.fingerprint
          ? { kind: 'received' as const, publicReference: saved.public_reference } : { kind: 'conflict' as const };
      }
      const fingerprint = fingerprints[0];
      if (!fingerprint || !text(fingerprint.keyId) || !/^[a-f0-9]{64}$/.test(fingerprint.fingerprint)) {
        throw new Error('Central inquiry fingerprint is invalid.');
      }
      await tx.query(
        `insert into alpha_private.ticket_central_intakes
           (organization_key,id,operation_id,fingerprint,fingerprint_key_id,public_reference,full_name,email,company,title,description,requested_deadline,submitted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [organizationKey, id, input.operationId, fingerprint.fingerprint, fingerprint.keyId, publicReference, input.fullName,
          input.email, input.company, input.title, input.description, input.requestedDeadline, occurredAt]);
      await tx.query(
        `insert into alpha_private.ticket_central_intake_events
           (id,organization_key,intake_id,event_type,actor_kind,occurred_at,metadata)
         values ($1,$2,$3,'inquiry_received','anonymous',$4,$5::jsonb)`,
        [randomUUID(), organizationKey, id, occurredAt, JSON.stringify({ operationId: input.operationId })]);
      await tx.query(
        `insert into alpha_private.ticket_central_intake_acknowledgments
           (organization_key,intake_id,idempotency_key,status,available_at,created_at)
         values ($1,$2,$3,'pending',$4,$4)`,
        [organizationKey, id, input.operationId, occurredAt]);
      return { kind: 'received', publicReference };
    });
  }

  async listPending(organizationKey: string, workspaceId: string, subject: TicketSubject,
    cursor: CentralIntakeCursor | null, limit: number, filter: 'pending' | 'handled' = 'pending'): Promise<CentralIntakePage | 'forbidden'> {
    if (!text(organizationKey) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Central inquiry page is invalid.');
    return this.db.transaction(async tx => {
      const scope = await new PostgresTicketAuthorization(tx).lockQueueScope(workspaceId, subject);
      if (!scope || scope.principal.kind !== 'pm') return 'forbidden';
      const { rows } = await tx.query<CentralIntakeDbRow>(
        `select i.id,i.public_reference,i.full_name,i.email,i.company,i.title,i.description,i.requested_deadline,i.submitted_at,
                i.status,coalesce(i.accepted_at,i.declined_at) as handled_at,o.status as outcome_email_status
           from alpha_private.ticket_central_intakes i
           left join alpha_private.ticket_central_intake_outcomes o on o.organization_key=i.organization_key and o.intake_id=i.id
          where i.organization_key=$1 and (($5='pending' and i.status='pending') or ($5='handled' and i.status in ('accepted','declined')))
            and ($2::timestamptz is null or (i.submitted_at,i.id collate "C")<($2::timestamptz,$3::text collate "C"))
          order by i.submitted_at desc,i.id collate "C" desc limit $4`,
        [organizationKey, cursor?.submittedAt ?? null, cursor?.id ?? null, limit + 1, filter]);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(mapItem);
      const last = items.at(-1);
      return { items, nextCursor: hasMore && last ? { submittedAt: last.submittedAt, id: last.id } : null };
    });
  }

  async accept(input: {
    organizationKey: string; intakeId: string; workspaceId: string; subject: TicketSubject;
    operationId: string; ticketId: string; reference: string; occurredAt: string;
  }): Promise<CentralIntakeAcceptance | 'not_found' | 'already_handled' | 'workspace_unavailable' | 'forbidden'> {
    return this.db.transaction(async tx => {
      const authorization = new PostgresTicketAuthorization(tx);
      const scope = await authorization.lockQueueScope(input.workspaceId, input.subject);
      if (!scope || scope.principal.kind !== 'pm') return 'forbidden';
      if (scope.mode !== 'enabled') return 'workspace_unavailable';
      const { rows } = await tx.query<SavedOperationDbRow>(
        `select intake.id,intake.status,intake.accepted_by,intake.accepted_workspace_id,
                intake.accepted_ticket_id,intake.acceptance_operation_id,ticket.reference
           from alpha_private.ticket_central_intakes intake
           left join alpha_private.tickets ticket
             on ticket.workspace_id=intake.accepted_workspace_id and ticket.id=intake.accepted_ticket_id
          where intake.organization_key=$1 and intake.id=$2 for update of intake`,
        [input.organizationKey, input.intakeId]);
      const existing = rows[0];
      if (!existing) return 'not_found';
      if (existing.status === 'accepted') {
        if (existing.accepted_by === input.subject.userId && existing.accepted_workspace_id === input.workspaceId
          && existing.acceptance_operation_id === input.operationId && text(existing.accepted_ticket_id)
          && text(existing.reference)) {
          return { ticketId: existing.accepted_ticket_id, workspaceId: input.workspaceId,
            reference: existing.reference, operationId: input.operationId };
        }
        return 'already_handled';
      }
      if (existing.status === 'declined') return 'already_handled';
      if (existing.status !== 'pending') throw new Error('Central inquiry state is invalid.');

      const workspace = await tx.query<{ name: string; write_mode: string | null }>(
        `select name,settings_json->>'ticketing_write_mode' as write_mode
           from public.workspaces where id=$1 and status='active' for share`, [input.workspaceId]);
      const workspaceRow = workspace.rows[0];
      if (!workspaceRow || workspaceRow.write_mode !== 'enabled') return 'workspace_unavailable';
      if (!text(workspaceRow.name)) throw new Error('Workspace display name is invalid.');

      const contact = await tx.query<{ id: string }>(
        `insert into alpha_private.ticket_contacts
           (id,workspace_id,full_name,email,company,email_verified,created_at)
         select $1,$2,full_name,email,company,false,$3
           from alpha_private.ticket_central_intakes where organization_key=$4 and id=$5 and status='pending'
         returning id`, [randomUUID(), input.workspaceId, input.occurredAt, input.organizationKey, input.intakeId]);
      const contactId = contact.rows[0]?.id;
      if (!text(contactId)) throw new Error('The inquiry contact could not be created.');

      const state = newTicketWorkflow(input.ticketId, input.workspaceId);
      const workflow = decodeTicketWorkflow(state);
      await tx.query(
        `insert into alpha_private.tickets
           (id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,workflow_state,
            client_user_id,contact_id,project_id,project_display_name,project_client_visible,related_ticket_id,
            created_at,client_updated_at,internal_updated_at,closed_at)
         select $1,$2,$3,title,description,$4,'public_inquiry',$5,$6,$7::jsonb,null,$8,null,null,false,null,$9,$9,$9,null
           from alpha_private.ticket_central_intakes where organization_key=$10 and id=$11 and status='pending'`,
        [state.id, input.workspaceId, input.reference, workspaceRow.name, state.status, state.version,
          JSON.stringify(workflow), contactId, input.occurredAt, input.organizationKey, input.intakeId]);
      await tx.query(
        `insert into alpha_private.ticket_requests
           (workspace_id,ticket_id,source,intake_context_id,intake_entry_id,project_preference,
            preferred_project_id,requested_project_label,requested_deadline,contact_id,submitted_at)
         select $1,$2,'public_inquiry',null,null,'not_sure',null,null,requested_deadline,$3,submitted_at
           from alpha_private.ticket_central_intakes where organization_key=$4 and id=$5`,
        [input.workspaceId, state.id, contactId, input.organizationKey, input.intakeId]);
      await tx.query(
        `insert into alpha_private.ticket_audit_events
           (id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
         values ($1,$2,$3,'anonymous',null,'inquiry_received',$4,$5::jsonb),
                ($6,$2,$3,'pm',$7,'inquiry_accepted',$4,$8::jsonb)`,
        [randomUUID(), input.workspaceId, state.id, input.occurredAt,
          JSON.stringify({ centralIntakeId: input.intakeId }), randomUUID(), input.subject.userId,
          JSON.stringify({ centralIntakeId: input.intakeId, operationId: input.operationId })]);
      await tx.query(
        `insert into alpha_private.ticket_outbox_events
           (id,workspace_id,ticket_id,event_type,dedupe_key,payload,status,available_at,created_at)
         values ($1,$2,$3,'ticket_created',$4,$5::jsonb,'pending',$6,$6)`,
        [randomUUID(), input.workspaceId, state.id, `central-intake:${input.organizationKey}:${input.intakeId}`,
          JSON.stringify({ source: 'public_inquiry', centralIntakeId: input.intakeId }), input.occurredAt]);
      const updated = await tx.query(
        `update alpha_private.ticket_central_intakes
            set status='accepted',accepted_by=$3,accepted_workspace_id=$4,accepted_ticket_id=$5,
                acceptance_operation_id=$6,accepted_at=$7
          where organization_key=$1 and id=$2 and status='pending'
          returning id`,
        [input.organizationKey, input.intakeId, input.subject.userId, input.workspaceId,
          state.id, input.operationId, input.occurredAt]);
      if (updated.rows.length !== 1) throw new Error('Central inquiry could not be atomically accepted.');
      await tx.query(
        `insert into alpha_private.ticket_central_intake_events
           (id,organization_key,intake_id,event_type,actor_kind,actor_id,workspace_id,ticket_id,occurred_at,metadata)
         values ($1,$2,$3,'inquiry_accepted','pm',$4,$5,$6,$7,$8::jsonb)`,
        [randomUUID(), input.organizationKey, input.intakeId, input.subject.userId, input.workspaceId,
          state.id, input.occurredAt, JSON.stringify({ operationId: input.operationId })]);
      return { ticketId: state.id, workspaceId: input.workspaceId, reference: input.reference, operationId: input.operationId };
    });
  }

  async decline(input: {
    organizationKey: string; intakeId: string; workspaceId: string; subject: TicketSubject;
    operationId: string; reason: string | null; occurredAt: string;
  }): Promise<CentralIntakeDeclineReceipt | 'not_found' | 'already_handled' | 'forbidden'> {
    return this.db.transaction(async tx => {
      const scope = await new PostgresTicketAuthorization(tx).lockQueueScope(input.workspaceId, input.subject);
      if (!scope || scope.principal.kind !== 'pm') return 'forbidden';
      const { rows } = await tx.query<{
        status: string; declined_by: string | null; declined_workspace_id: string | null;
        decline_operation_id: string | null; decline_reason: string | null;
      }>(
        `select status,declined_by,declined_workspace_id,decline_operation_id,decline_reason
           from alpha_private.ticket_central_intakes
          where organization_key=$1 and id=$2 for update`,
        [input.organizationKey, input.intakeId]);
      const existing = rows[0];
      if (!existing) return 'not_found';
      if (existing.status === 'declined') {
        return existing.declined_by === input.subject.userId
          && existing.declined_workspace_id === input.workspaceId
          && existing.decline_operation_id === input.operationId
          && existing.decline_reason === input.reason
          ? { intakeId: input.intakeId, operationId: input.operationId, status: 'declined' }
          : 'already_handled';
      }
      if (existing.status !== 'pending') return 'already_handled';
      const { rows: updated } = await tx.query<{ id: string }>(
        `update alpha_private.ticket_central_intakes
            set status='declined',declined_by=$3,declined_workspace_id=$4,decline_operation_id=$5,
                declined_at=$6,decline_reason=$7
          where organization_key=$1 and id=$2 and status='pending'
          returning id`,
        [input.organizationKey, input.intakeId, input.subject.userId, input.workspaceId,
          input.operationId, input.occurredAt, input.reason]);
      if (updated.length !== 1) throw new Error('Central inquiry could not be atomically declined.');
      await tx.query(`insert into alpha_private.ticket_central_intake_outcomes
        (organization_key,intake_id,idempotency_key,status,available_at,created_at)
        values($1,$2,$3,'pending',$4,$4)`, [input.organizationKey,input.intakeId,randomUUID(),input.occurredAt]);
      await tx.query(
        `insert into alpha_private.ticket_central_intake_events
           (id,organization_key,intake_id,event_type,actor_kind,actor_id,workspace_id,ticket_id,occurred_at,metadata)
         values ($1,$2,$3,'inquiry_declined','pm',$4,$5,null,$6,$7::jsonb)`,
        [randomUUID(), input.organizationKey, input.intakeId, input.subject.userId, input.workspaceId,
          input.occurredAt, JSON.stringify({ operationId: input.operationId, reason: input.reason })]);
      return { intakeId: input.intakeId, operationId: input.operationId, status: 'declined' };
    });
  }
}
