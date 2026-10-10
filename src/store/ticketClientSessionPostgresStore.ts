import { randomUUID } from 'node:crypto';

import type { TransactionalSql, Sql } from './database.js';
import type {
  TicketClientSessionAudit, TicketClientSessionRecord, TicketClientSessionStore,
  TicketClientSessionTransaction,
} from './ticketClientSessionStore.js';

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid client session timestamp.');
  return parsed.toISOString();
}

/** Client-only sessions are isolated from Alpha's GitHub/internal sessions. */
export class PostgresTicketClientSessionStore implements TicketClientSessionStore {
  constructor(private readonly db: TransactionalSql) {}

  async resolveSession(sessionIdHash: string): Promise<TicketClientSessionRecord | null> {
    const { rows } = await this.db.query<{
      session_id_hash: string; client_user_id: string; csrf_hash: string;
      created_at: Date | string; expires_at: Date | string; revoked_at: Date | string | null;
    }>(
      `select s.session_id_hash, s.client_user_id, s.csrf_hash, s.created_at, s.expires_at, s.revoked_at
         from alpha_private.ticket_client_sessions s
        where s.session_id_hash=$1
          and exists (
            select 1 from alpha_private.ticket_service_grants g
             where g.client_user_id=s.client_user_id and g.status='active' and g.revoked_at is null
          )`,
      [sessionIdHash],
    );
    const row = rows[0];
    return row ? {
      sessionIdHash: row.session_id_hash,
      providerUserId: row.client_user_id,
      csrfHash: row.csrf_hash,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
    } : null;
  }

  transaction<T>(work: (tx: TicketClientSessionTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async sql => work(this.transactionBoundary(sql)));
  }

  private transactionBoundary(sql: Sql): TicketClientSessionTransaction {
    return {
      async hasActiveClientServiceGrant(clientUserId) {
        const { rows } = await sql.query<{ workspace_id: string }>(
          `select workspace_id from alpha_private.ticket_service_grants
            where client_user_id=$1 and status='active' and revoked_at is null
            order by workspace_id limit 1 for share`,
          [clientUserId],
        );
        return rows.length === 1;
      },
      async insertSession(record: TicketClientSessionRecord) {
        await sql.query(
          `insert into alpha_private.ticket_client_sessions
             (session_id_hash,client_user_id,csrf_hash,created_at,expires_at,revoked_at)
           values ($1,$2,$3,$4,$5,$6)`,
          [record.sessionIdHash, record.providerUserId, record.csrfHash,
            record.createdAt, record.expiresAt, record.revokedAt],
        );
      },
      async revokeSession(sessionIdHash, clientUserId, revokedAt) {
        const { rows } = await sql.query<{ session_id_hash: string }>(
          `update alpha_private.ticket_client_sessions set revoked_at=$3
            where session_id_hash=$1 and client_user_id=$2 and revoked_at is null
            returning session_id_hash`,
          [sessionIdHash, clientUserId, revokedAt],
        );
        return rows.length === 1;
      },
      async appendAudit(audit: TicketClientSessionAudit) {
        await sql.query(
          `insert into alpha_private.ticket_client_auth_events (id,client_user_id,event_type,occurred_at)
           values ($1,$2,$3,$4)`,
          [randomUUID(), audit.providerUserId, audit.type, audit.occurredAt],
        );
      },
    };
  }
}
