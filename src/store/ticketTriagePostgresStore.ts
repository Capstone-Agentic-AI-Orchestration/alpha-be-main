import { randomUUID } from 'node:crypto';
import type { Sql, TransactionalSql } from './database.js';
import type { TicketMessageStore, TicketMessageTransaction } from './ticketMessageStore.js';
import type { LockedTicket, SavedTicketOperation, TicketOperationKey } from './ticketCommandStore.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { ticketWriteMode } from './ticketPostgresCodec.js';

function unavailable(): never {
  throw new TicketWorkflowError(503, 'ticket_action_unavailable', 'This ticket action is not enabled yet.');
}

/** Same cloud connection as the existing directory. No local persistence.
 * Communication routes are separately gated; unsupported workflow actions fail closed.
 */
export class PostgresTicketTriageStore implements TicketMessageStore {
  constructor(private readonly db: TransactionalSql, private readonly options: { communicationEnabled?: boolean } = {}) {}
  transaction<T>(work: (tx: TicketMessageTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async sql => work(createTicketTriageTransaction(sql, this.options)));
  }
}

/** Shared transaction primitives for communication and the complete lifecycle. */
export function createTicketTriageTransaction(sql: Sql, options: { communicationEnabled?: boolean } = {}): TicketMessageTransaction {
      const authorization = new PostgresTicketAuthorization(sql);
      let locked: LockedTicket | null = null;
      const communicationEnabled = options.communicationEnabled === true;
      function requireKey(key: TicketOperationKey): void {
        if (!locked || key.workspaceId !== locked.state.workspaceId || key.ticketId !== locked.state.id
          || key.actorId !== locked.actor.userId
          || (locked.actor.kind === 'client' ? key.actorKind !== 'client' : key.actorKind !== 'pm')) unavailable();
      }
      const tx: TicketMessageTransaction = {
        async lockAuthorizedTicket(target, subject) {
          if (subject.kind === 'client' && !communicationEnabled) return null;
          locked = await authorization.lockTicket(target, subject, 'update');
          if (locked && subject.kind === 'client' && communicationEnabled) {
            // Client service-grant write_mode intentionally blocks opening
            // additional requests. Existing ticket conversations instead use
            // the workspace's existing ticketing kill switch.
            const { rows } = await sql.query<{ write_mode: string | null }>(
              `select settings_json->>'ticketing_write_mode' as write_mode
                 from public.workspaces where id=$1 and status='active'`, [target.workspaceId],
            );
            locked = { ...locked, mode: ticketWriteMode(rows[0]?.write_mode) };
          }
          return locked;
        },
        async findOperation(key) {
          requireKey(key);
          const { rows } = await sql.query<{ operation_kind: string; fingerprint: string; receipt: Record<string, unknown> }>(
            `select operation_kind, fingerprint, receipt from alpha_private.ticket_operation_receipts
             where workspace_id=$1 and ticket_id=$2 and actor_kind=$3 and actor_id=$4 and operation_id=$5`,
            [key.workspaceId, key.ticketId, key.actorKind, key.actorId, key.operationId]);
          const row = rows[0];
          if (!row) return null;
          const r = row.receipt;
          if (!r || r.ticketId !== key.ticketId || r.operationId !== key.operationId
            || !Number.isSafeInteger(r.version) || Number(r.version) < 0 || typeof r.status !== 'string'
            || !/^[a-f0-9]{64}$/.test(row.fingerprint)) throw new Error('Invalid ticket operation receipt.');
          const receipt = r as unknown as SavedTicketOperation['receipt'];
          if (row.operation_kind === 'command') return { kind: 'command', key, fingerprint: row.fingerprint, receipt };
          if ((row.operation_kind === 'note' || row.operation_kind === 'message')
            && typeof r.messageId === 'string' && r.messageId.length > 0) {
            return { kind: row.operation_kind, key, fingerprint: row.fingerprint, receipt, messageId: r.messageId };
          }
          return unavailable();
        },
        async loadFacts(ticket, envelope) {
          if (['review', 'decline'].includes(envelope.command.type) && ticket.actor.kind === 'pm') return {};
          if (!communicationEnabled || !['reply', 'request_details'].includes(envelope.command.type)
            || !locked || !('messageId' in envelope.command)) return unavailable();
          const { rows: messages } = await sql.query<{ id: string; ticket_id: string; author_id: string; author_kind: string; audience: string }>(
            `select id,ticket_id,author_id,author_kind,audience from alpha_private.ticket_messages
              where workspace_id=$1 and ticket_id=$2 and id=$3 and audience='client'`,
            [locked.state.workspaceId, locked.state.id, envelope.command.messageId],
          );
          const message = messages[0];
          const { rows: grants } = await sql.query<{ active: boolean }>(
            `select exists(
                select 1 from alpha_private.ticket_client_grants cg
                join alpha_private.ticket_service_grants sg
                  on sg.workspace_id=cg.workspace_id and sg.client_user_id=cg.client_user_id
                where cg.workspace_id=$1 and cg.ticket_id=$2 and cg.client_user_id=$3
                  and cg.active and cg.revoked_at is null
                  and sg.status='active' and sg.revoked_at is null
              ) as active`,
            [locked.state.workspaceId, locked.state.id, locked.state.clientId],
          );
          return {
            clientAccessActive: locked.state.clientId !== null && grants[0]?.active === true,
            ...(message && message.author_id === locked.actor.userId && message.author_kind === locked.actor.kind
              ? { message: { id: message.id, ticketId: message.ticket_id, authorId: message.author_id, audience: message.audience as 'client' } }
              : {}),
          };
        },
        async saveWorkflow(target, version, state) {
          if (!locked || target.workspaceId !== locked.state.workspaceId || target.ticketId !== locked.state.id
            || state.id !== target.ticketId || state.workspaceId !== target.workspaceId
            || (!['under_review', 'declined'].includes(state.status)
              && !(communicationEnabled && ['under_review', 'awaiting_client', 'in_progress', 'ready_for_review', 'on_hold'].includes(state.status)))
            || state.version !== version + 1) unavailable();
          const { rows } = await sql.query(
            `update alpha_private.tickets set workflow_state=$4::jsonb, status=$5, version=$6,
               internal_updated_at=greatest(internal_updated_at, now()),
               client_updated_at=greatest(client_updated_at, now()),
               closed_at=case when $5='declined' then now() else closed_at end
             where workspace_id=$1 and id=$2 and version=$3 returning id`,
            [target.workspaceId, target.ticketId, version, JSON.stringify(state), state.status, state.version]);
          return rows.length === 1;
        },
        async appendAudit(audit) {
          requireKey(audit.key);
          await appendAudit(sql, audit.key, audit.event.type, audit.occurredAt,
            { operationId: audit.key.operationId, command: audit.envelope.command, version: audit.envelope.expectedVersion + 1 });
          if (audit.envelope.command.type === 'decline') {
            // Retain the decision reason in the PM-only history, not a client message.
            await tx.insertMessage({ ...audit.key, id: randomUUID(), authorKind: 'pm', authorId: audit.key.actorId,
              audience: 'internal', body: `Declined: ${audit.envelope.command.reason}`, createdAt: audit.occurredAt });
          }
        },
        async enqueueChange(signal) {
          requireKey(signal.key);
          await sql.query(
            `insert into alpha_private.ticket_outbox_events
             (id,workspace_id,ticket_id,event_type,dedupe_key,payload,status,available_at,created_at)
             values ($1,$2,$3,'ticket_changed',$4,$5::jsonb,'pending',$6,$6)`,
            [randomUUID(), signal.key.workspaceId, signal.key.ticketId,
              `triage:${signal.key.ticketId}:${signal.key.actorId}:${signal.key.operationId}`,
              JSON.stringify({ version: signal.version, operationId: signal.key.operationId }), signal.occurredAt]);
        },
        async insertOperation(operation) {
          requireKey(operation.key);
          if (operation.kind !== 'command' && operation.kind !== 'note' && operation.kind !== 'message') unavailable();
          if (operation.kind === 'note' && locked?.actor.kind !== 'pm') unavailable();
          const k = operation.key;
          await sql.query(
            `insert into alpha_private.ticket_operation_receipts
             (workspace_id,ticket_id,actor_kind,actor_id,operation_id,operation_kind,fingerprint,receipt)
             values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [k.workspaceId, k.ticketId, k.actorKind, k.actorId, k.operationId, operation.kind, operation.fingerprint,
              JSON.stringify({ ...operation.receipt,
                ...(operation.kind === 'note' || operation.kind === 'message' ? { messageId: operation.messageId } : {}) })]);
        },
        async insertMessage(message) {
          if (!locked || message.workspaceId !== locked.state.workspaceId || message.ticketId !== locked.state.id
            || message.authorKind !== locked.actor.kind || message.authorId !== locked.actor.userId
            || (message.audience === 'internal' && locked.actor.kind !== 'pm')
            || (message.audience === 'client' && !communicationEnabled)) unavailable();
          await sql.query(
            `insert into alpha_private.ticket_messages (id,workspace_id,ticket_id,author_kind,author_id,audience,body,created_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [message.id, message.workspaceId, message.ticketId, message.authorKind, message.authorId,
              message.audience, message.body, message.createdAt]);
          if (communicationEnabled && message.audience === 'client' && message.authorKind === 'pm') {
            await sql.query(
              `insert into alpha_private.ticket_communication_notifications
                 (id,workspace_id,ticket_id,notification_kind,object_id,dedupe_key,status,available_at,created_at)
               values ($1,$2,$3,'message',$4,$5,'pending',$6,$6)
               on conflict (workspace_id,dedupe_key) do nothing`,
              [randomUUID(), message.workspaceId, message.ticketId, message.id,
                `ticket-message:${message.id}`, message.createdAt],
            );
          }
        },
        async updateMessageClocks(target, version, audience, occurredAt) {
          if (!locked || target.workspaceId !== locked.state.workspaceId || target.ticketId !== locked.state.id) unavailable();
          const { rows } = audience === 'internal'
            ? await sql.query(
              `update alpha_private.tickets set internal_updated_at=greatest(internal_updated_at,$4::timestamptz)
               where workspace_id=$1 and id=$2 and version=$3 returning id`,
              [target.workspaceId, target.ticketId, version, occurredAt])
            : await sql.query(
              `update alpha_private.tickets set client_updated_at=greatest(client_updated_at,$4::timestamptz),
                 internal_updated_at=greatest(internal_updated_at,$4::timestamptz)
               where workspace_id=$1 and id=$2 and version=$3 returning id`,
              [target.workspaceId, target.ticketId, version, occurredAt]);
          return rows.length === 1;
        },
        async appendNoteAudit(audit) {
          if (locked?.actor.kind !== 'pm') unavailable();
          requireKey(audit.key);
          await appendAudit(sql, audit.key, audit.type, audit.occurredAt,
            { messageId: audit.messageId, operationId: audit.key.operationId, version: audit.workflowVersion });
        },
        async loadAssessmentCandidate() { return unavailable(); },
        async insertWorkBindings() { return unavailable(); },
        async reopenIssues() { return unavailable(); },
      };
      return tx;
}

async function appendAudit(sql: Sql, key: TicketOperationKey, type: string, at: string, metadata: object) {
  await sql.query(
    `insert into alpha_private.ticket_audit_events
     (id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [randomUUID(), key.workspaceId, key.ticketId, key.actorKind, key.actorId, type, at, JSON.stringify(metadata)]);
}
