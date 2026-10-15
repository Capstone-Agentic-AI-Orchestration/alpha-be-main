import { randomUUID } from 'node:crypto';
import type { Sql, TransactionalSql } from './database.js';

export interface ClientAccountSetup {
  idHash: string;
  userId: string;
  email: string;
  action: 'set_password' | 'sign_in' | 'reset_password';
  csrfHash: string;
  protectedProof: string;
  expiresAt: string;
}

interface SetupRow {
  id_hash: string; client_user_id: string; email: string; action: ClientAccountSetup['action'];
  csrf_hash: string; protected_proof: string; expires_at: Date | string;
}

function decode(row: SetupRow): ClientAccountSetup {
  return { idHash: row.id_hash, userId: row.client_user_id, email: row.email, action: row.action,
    csrfHash: row.csrf_hash, protectedProof: row.protected_proof,
    expiresAt: new Date(row.expires_at).toISOString() };
}

/** Setup proofs live in a private, bounded server store, never browser storage. */
export class PostgresTicketClientAccountStore {
  constructor(private readonly db: TransactionalSql) {}

  async hasPassword(userId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ configured: boolean }>(
      `select exists(select 1 from alpha_private.ticket_client_password_credentials where client_user_id=$1) as configured`, [userId]);
    return rows[0]?.configured === true;
  }

  async markPasswordConfigured(userId: string): Promise<void> {
    if (typeof userId !== 'string' || !userId.trim() || userId.length > 200 || userId.trim() !== userId) {
      throw new Error('Client password marker is invalid.');
    }
    await this.db.query(`insert into alpha_private.ticket_client_password_credentials(client_user_id)
      values ($1) on conflict (client_user_id) do nothing`, [userId]);
  }

  async create(setup: ClientAccountSetup): Promise<void> {
    await this.db.transaction(async tx => {
      await this.lockUser(tx, setup.userId);
      await tx.query(`update alpha_private.ticket_client_account_setups set consumed_at=now(),protected_proof=null
        where consumed_at is null and expires_at<=now() and (processing_until is null or processing_until<=now())`);
      const busy = await tx.query(`select 1 from alpha_private.ticket_client_account_setups
        where client_user_id=$1 and consumed_at is null and processing_until>now()`, [setup.userId]);
      if (busy.rows.length) throw new Error('Account setup is already being completed.');
      await tx.query(`update alpha_private.ticket_client_account_setups
        set consumed_at=now(),protected_proof=null where client_user_id=$1 and consumed_at is null`, [setup.userId]);
      await tx.query(`insert into alpha_private.ticket_client_account_setups
        (id_hash,client_user_id,email,action,csrf_hash,protected_proof,expires_at)
        values ($1,$2,$3,$4,$5,$6,$7)`,
      [setup.idHash, setup.userId, setup.email, setup.action, setup.csrfHash, setup.protectedProof, setup.expiresAt]);
    });
  }

  async get(idHash: string): Promise<ClientAccountSetup | null> {
    const { rows } = await this.db.query<SetupRow>(`select * from alpha_private.ticket_client_account_setups
      where id_hash=$1 and consumed_at is null and expires_at>now()`, [idHash]);
    return rows[0] ? decode(rows[0]) : null;
  }

  async finish<T>(idHash: string, work: (setup: ClientAccountSetup) => Promise<T>): Promise<T | null> {
    const discovered = await this.get(idHash);
    if (!discovered) return null;
    const leaseId = randomUUID();
    const setup = await this.db.transaction(async tx => {
      await this.lockUser(tx, discovered.userId);
      const { rows } = await tx.query<SetupRow>(`select * from alpha_private.ticket_client_account_setups
        where id_hash=$1 and consumed_at is null and expires_at>now()
          and (processing_until is null or processing_until<=now()) for update`, [idHash]);
      if (!rows[0]) return null;
      await tx.query(`update alpha_private.ticket_client_account_setups
        set lease_id=$2,processing_until=now()+interval '2 minutes' where id_hash=$1`, [idHash, leaseId]);
      return decode(rows[0]);
    });
    if (!setup) return null;
    try {
      // Network calls never hold a database transaction or ticket lock open.
      const result = await work(setup);
      const consumed = await this.db.query(`update alpha_private.ticket_client_account_setups
        set consumed_at=now(),protected_proof=null,processing_until=null,lease_id=null
        where id_hash=$1 and lease_id=$2 and consumed_at is null returning id_hash`, [idHash, leaseId]);
      if (consumed.rows.length !== 1) throw new Error('Account setup could not be confirmed.');
      return result;
    } catch (error) {
      await this.db.query(`update alpha_private.ticket_client_account_setups set processing_until=null,lease_id=null
        where id_hash=$1 and lease_id=$2 and consumed_at is null`, [idHash, leaseId]);
      throw error;
    }
  }

  /** Commit revocation before changing the provider password, even if setup later fails. */
  async revokeSessions(userId: string): Promise<void> {
    await this.db.query(`update alpha_private.ticket_client_sessions set revoked_at=now()
      where client_user_id=$1 and revoked_at is null`, [userId]);
  }

  async ticketGranted(workspaceId: string, ticketId: string, userId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ allowed: boolean }>(`select exists(
      select 1 from alpha_private.ticket_client_grants
      where workspace_id=$1 and ticket_id=$2 and client_user_id=$3 and active and revoked_at is null) as allowed`,
    [workspaceId, ticketId, userId]);
    return rows[0]?.allowed === true;
  }

  private async lockUser(tx: Sql, userId: string): Promise<void> {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [`alpha-client-account:${userId}`]);
  }
}
