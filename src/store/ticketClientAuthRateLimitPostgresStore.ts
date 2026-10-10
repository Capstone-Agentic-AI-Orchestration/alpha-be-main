import { createHash } from 'node:crypto';

import type { TransactionalSql } from './database.js';

export type ClientAuthRateLimitBucket = 'client_sign_in' | 'client_activation';

/** A fixed-window, persistent per-source budget shared by all cloud instances. */
export class PostgresTicketClientAuthRateLimitStore {
  constructor(private readonly db: TransactionalSql) {}

  async consume(input: { bucket: ClientAuthRateLimitBucket; subjectHash: string; windowStartedAt: string; maximum: number }): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(input.subjectHash) || !Number.isSafeInteger(input.maximum)
      || input.maximum < 1 || input.maximum > 1000 || !Number.isFinite(Date.parse(input.windowStartedAt))) return false;
    const { rows } = await this.db.query<{ attempts: number }>(
      `insert into alpha_private.ticket_client_auth_rate_buckets
         (bucket_kind,subject_hash,window_started_at,attempts)
       values ($1,$2,$3,1)
       on conflict (bucket_kind,subject_hash) do update
         set window_started_at=case
               when alpha_private.ticket_client_auth_rate_buckets.window_started_at<excluded.window_started_at
               then excluded.window_started_at
               else alpha_private.ticket_client_auth_rate_buckets.window_started_at end,
             attempts=case
               when alpha_private.ticket_client_auth_rate_buckets.window_started_at<excluded.window_started_at
               then 1 else alpha_private.ticket_client_auth_rate_buckets.attempts+1 end
       where alpha_private.ticket_client_auth_rate_buckets.window_started_at<excluded.window_started_at
          or alpha_private.ticket_client_auth_rate_buckets.attempts<$4
       returning attempts`,
      [input.bucket, input.subjectHash, input.windowStartedAt, input.maximum],
    );
    return rows.length === 1;
  }
}

export function ticketClientRateSubject(secret: string, bucket: ClientAuthRateLimitBucket, address: string): string {
  return createHash('sha256').update(`${bucket}\0`, 'utf8').update(secret, 'utf8').update('\0', 'utf8')
    .update(address, 'utf8').digest('hex');
}
