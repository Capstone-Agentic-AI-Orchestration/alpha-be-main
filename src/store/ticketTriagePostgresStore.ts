import { randomUUID } from 'node:crypto';
import type { Sql, TransactionalSql } from './database.js';
import type { TicketMessageStore, TicketMessageTransaction } from './ticketMessageStore.js';
import type { LockedTicket, SavedTicketOperation, TicketOperationKey } from './ticketCommandStore.js';
import { PostgresTicketAuthorization } from './ticketPostgresAuthorization.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

function unavailable(): never {
  throw new TicketWorkflowError(503, 'ticket_action_unavailable', 'This ticket action is not enabled yet.');
}

/** Same cloud connection as the existing directory. No local persistence.
 * Only review/decline and private notes are implemented; later work fails closed.
 */
export class PostgresTicketTriageStore implements TicketMessageStore {
  constructor(private readonly db: TransactionalSql) {}
  transaction<T>(work: (tx: TicketMessageTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async sql => {
      const authorization = new PostgresTicketAuthorization(sql);
      let locked: LockedTicket | null = null;
      function requireKey(key: TicketOperationKey): void {
        if (!locked || key.workspaceId !== locked.state.workspaceId || key.ticketId !== locked.state.id
          || key.actorKind !== 'pm' || key.actorId !== locked.actor.userId) unavailable();
      }
      const tx: TicketMessageTransaction = {
        async lockAuthorizedTicket(target, subject) {
          // Never query future client-session tables from the Phase 2 adapter.
          if (subject.kind !== 'internal') return null;
          locked = await authorization.lockTicket(target, subject, 'update');
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
          if (row.operation_kind === 'note' && typeof r.messageId === 'string' && r.messageId.length > 0) {
            return { kind: 'note', key, fingerprint: row.fingerprint, receipt, messageId: r.messageId };
          }
          return unavailable();
        },
        async loadFacts(_ticket, envelope) {
          if (!['review', 'decline'].includes(envelope.command.type)) unavailable();
          return {};
        },
        async saveWorkflow(target, version, state) {
          if (!locked || target.workspaceId !== locked.state.workspaceId || target.ticketId !== locked.state.id
            || state.id !== target.ticketId || state.workspaceId !== target.workspaceId
            || !['under_review', 'declined'].includes(state.status)) unavailable();
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
          if (operation.kind !== 'command' && operation.kind !== 'note') unavailable();
          const k = operation.key;
          await sql.query(
            `insert into alpha_private.ticket_operation_receipts
             (workspace_id,ticket_id,actor_kind,actor_id,operation_id,operation_kind,fingerprint,receipt)
             values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [k.workspaceId, k.ticketId, k.actorKind, k.actorId, k.operationId, operation.kind, operation.fingerprint,
              JSON.stringify({ ...operation.receipt, ...(operation.kind === 'note' ? { messageId: operation.messageId } : {}) })]);
        },
        async insertMessage(message) {
          if (!locked || message.workspaceId !== locked.state.workspaceId || message.ticketId !== locked.state.id
            || message.authorKind !== 'pm' || message.authorId !== locked.actor.userId || message.audience !== 'internal') unavailable();
          await sql.query(
            `insert into alpha_private.ticket_messages (id,workspace_id,ticket_id,author_kind,author_id,audience,body,created_at)
             values ($1,$2,$3,'pm',$4,'internal',$5,$6)`,
            [message.id, message.workspaceId, message.ticketId, message.authorId, message.body, message.createdAt]);
        },
        async updateMessageClocks(target, version, audience, occurredAt) {
          if (audience !== 'internal' || !locked || target.workspaceId !== locked.state.workspaceId || target.ticketId !== locked.state.id) unavailable();
          const { rows } = await sql.query(
            `update alpha_private.tickets set internal_updated_at=greatest(internal_updated_at,$4::timestamptz)
             where workspace_id=$1 and id=$2 and version=$3 returning id`,
            [target.workspaceId, target.ticketId, version, occurredAt]);
          return rows.length === 1;
        },
        async appendNoteAudit(audit) {
          requireKey(audit.key);
          await appendAudit(sql, audit.key, audit.type, audit.occurredAt,
            { messageId: audit.messageId, operationId: audit.key.operationId, version: audit.workflowVersion });
        },
        async loadAssessmentCandidate() { return unavailable(); },
        async insertWorkBindings() { return unavailable(); },
        async reopenIssues() { return unavailable(); },
      };
      return work(tx);
    });
  }
}

async function appendAudit(sql: Sql, key: TicketOperationKey, type: string, at: string, metadata: object) {
  await sql.query(
    `insert into alpha_private.ticket_audit_events
     (id,workspace_id,ticket_id,actor_kind,actor_id,event_type,occurred_at,metadata)
     values ($1,$2,$3,'pm',$4,$5,$6,$7::jsonb)`,
    [randomUUID(), key.workspaceId, key.ticketId, key.actorId, type, at, JSON.stringify(metadata)]);
}
