import { createHash, randomUUID } from 'node:crypto';

import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { decodeTicketWorkflow } from './ticketPostgresCodec.js';
import type { Sql, TransactionalSql } from './database.js';
import type {
  PublishedTicketIntakeEntry, SavedPublicTicketIntakeOperation,
  TicketPublicIntakeStore, TicketPublicIntakeTransaction, PublicTicketIntakeAdmission,
} from './ticketPublicIntakeStore.js';

interface IntakeEntryDbRow {
  id: string;
  workspace_id: string;
  slug: string;
  company_label: string;
  published: boolean;
  entry_write_mode: string;
  workspace_write_mode: string | null;
  policy_version: string;
  per_source_max: string | number;
  per_entry_max: string | number;
  window_seconds: string | number;
}

interface SavedOperationDbRow {
  workspace_id: string;
  entry_id: string;
  operation_id: string;
  ticket_id: string;
  fingerprint: string;
  fingerprint_key_id: string;
  request_entry_id: string | null;
  source: string | null;
}

function invariant(): never { throw new TicketReadInvariantError(); }

function requiredString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invariant();
}

function positiveInteger(value: unknown): number {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : 0;
}

function entryMode(entryMode: string, workspaceMode: string | null): PublishedTicketIntakeEntry['mode'] {
  if (entryMode === 'maintenance' || workspaceMode === 'maintenance') return 'maintenance';
  if (entryMode === 'enabled' && workspaceMode === 'enabled') return 'enabled';
  return 'disabled';
}

function entryFromRow(row: IntakeEntryDbRow): PublishedTicketIntakeEntry {
  if (typeof row.published !== 'boolean') return invariant();
  return {
    id: requiredString(row.id),
    workspaceId: requiredString(row.workspace_id),
    slug: requiredString(row.slug),
    companyLabel: requiredString(row.company_label),
    published: row.published,
    mode: entryMode(row.entry_write_mode, row.workspace_write_mode),
    policy: {
      version: requiredString(row.policy_version),
      perSourceMax: positiveInteger(row.per_source_max),
      perEntryMax: positiveInteger(row.per_entry_max),
      windowSeconds: positiveInteger(row.window_seconds),
    },
  };
}

async function readEntry(sql: Sql, slug: string, lock: boolean): Promise<PublishedTicketIntakeEntry | null> {
  const { rows } = await sql.query<IntakeEntryDbRow>(
    `select e.id, e.workspace_id, e.slug, e.company_label, e.published,
            e.write_mode as entry_write_mode,
            w.settings_json->>'ticketing_write_mode' as workspace_write_mode,
            e.policy_version, e.per_source_max, e.per_entry_max, e.window_seconds
     from alpha_private.ticket_intake_entries e
     join public.workspaces w on w.id = e.workspace_id and w.status = 'active'
     where e.slug = $1
     ${lock ? 'for share of w for update of e' : ''}`,
    [slug],
  );
  return rows[0] ? entryFromRow(rows[0]) : null;
}

function samePolicy(a: PublishedTicketIntakeEntry, b: PublishedTicketIntakeEntry): boolean {
  return a.id === b.id && a.workspaceId === b.workspaceId && a.slug === b.slug
    && a.companyLabel === b.companyLabel && a.policy.version === b.policy.version
    && a.policy.perSourceMax === b.policy.perSourceMax && a.policy.perEntryMax === b.policy.perEntryMax
    && a.policy.windowSeconds === b.policy.windowSeconds;
}

class IntakeRateLimitDenied extends Error {
  constructor(readonly retryAfterSeconds: number) { super('Public ticket intake budget reached.'); }
}

/**
 * Durable public inquiry persistence over the same cloud-owned PostgreSQL
 * authority as PM queue reads. RLS is defense in depth here: every statement is
 * explicitly entry/workspace scoped because the cloud connection owns tables.
 * It does not implement origin admission or mount a public route.
 */
export class PostgresTicketPublicIntakeStore implements TicketPublicIntakeStore {
  constructor(private readonly db: TransactionalSql, private readonly acknowledgmentsEnabled = false) {}

  async loadPublishedEntry(slug: string): Promise<PublishedTicketIntakeEntry | null> {
    return readEntry(this.db, slug, false);
  }

  async consumeIntakeAttempt(
    entry: PublishedTicketIntakeEntry,
    admission: PublicTicketIntakeAdmission,
    occurredAt: string,
  ): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
    try {
      await this.db.transaction(async sql => {
        const current = await readEntry(sql, entry.slug, true);
        if (!current || !current.published || current.mode !== 'enabled' || !samePolicy(entry, current)
          || admission.entryId !== current.id || !/^[a-f0-9]{64}$/.test(admission.rateSubjectKey)) {
          throw new Error('The public intake entry changed or is unavailable.');
        }
        const nowMs = Date.parse(occurredAt);
        const windowSeconds = current.policy.windowSeconds;
        if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
          throw new Error('The public intake budget is invalid.');
        }
        const nowSeconds = nowMs / 1000;
        const windowStartSeconds = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
        const windowStartedAt = new Date(windowStartSeconds * 1000).toISOString();
        const retryAfterSeconds = Math.max(1, Math.min(windowSeconds, Math.ceil(windowStartSeconds + windowSeconds - nowSeconds)));
        const entrySubjectHash = createHash('sha256')
          .update(`${current.workspaceId}\0${current.id}`)
          .digest('hex');

        // One entry-row lock serializes both counters for this published form.
        // If either upsert is denied, throwing rolls back BOTH bucket changes.
        for (const bucket of [
          { kind: 'source' as const, subjectHash: admission.rateSubjectKey, maximum: current.policy.perSourceMax },
          { kind: 'entry' as const, subjectHash: entrySubjectHash, maximum: current.policy.perEntryMax },
        ]) {
          const { rows } = await sql.query<{ attempts: number }>(
            `insert into alpha_private.ticket_intake_rate_buckets
               (workspace_id, entry_id, bucket_kind, subject_hash, window_started_at, window_seconds, attempts, updated_at)
             values ($1, $2, $3, $4, $5, $6, 1, $7)
             on conflict (workspace_id, entry_id, bucket_kind, subject_hash, window_started_at)
             do update set attempts = alpha_private.ticket_intake_rate_buckets.attempts + 1,
                           window_seconds = excluded.window_seconds,
                           updated_at = excluded.updated_at
             where alpha_private.ticket_intake_rate_buckets.attempts < $8
             returning attempts`,
            [current.workspaceId, current.id, bucket.kind, bucket.subjectHash, windowStartedAt,
              windowSeconds, new Date(nowMs).toISOString(), bucket.maximum],
          );
          if (rows.length !== 1) throw new IntakeRateLimitDenied(retryAfterSeconds);
        }
      });
      return { allowed: true };
    } catch (error) {
      if (error instanceof IntakeRateLimitDenied) {
        return { allowed: false, retryAfterSeconds: error.retryAfterSeconds };
      }
      throw error;
    }
  }

  transaction<T>(work: (tx: TicketPublicIntakeTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(sql => work(new PostgresTicketPublicIntakeTransaction(sql, this.acknowledgmentsEnabled)));
  }
}

class PostgresTicketPublicIntakeTransaction implements TicketPublicIntakeTransaction {
  private lockedEntry: PublishedTicketIntakeEntry | null = null;
  private createdTarget: { workspaceId: string; ticketId: string } | null = null;

  constructor(private readonly sql: Sql, private readonly acknowledgmentsEnabled: boolean) {}

  async lockPublishedEntry(slug: string): Promise<PublishedTicketIntakeEntry | null> {
    this.lockedEntry = await readEntry(this.sql, slug, true);
    return this.lockedEntry;
  }

  async lockInquiryOperation(key: { workspaceId: string; entryId: string; operationId: string }): Promise<SavedPublicTicketIntakeOperation | null> {
    this.requireEntry(key.workspaceId, key.entryId);
    const { rows } = await this.sql.query<SavedOperationDbRow>(
      `select op.workspace_id, op.entry_id, op.operation_id, op.ticket_id, op.fingerprint,
              op.fingerprint_key_id, request.intake_entry_id as request_entry_id, t.source
       from alpha_private.ticket_intake_operations op
       left join alpha_private.tickets t
         on t.workspace_id = op.workspace_id and t.id = op.ticket_id
       left join alpha_private.ticket_requests request
         on request.workspace_id = op.workspace_id and request.ticket_id = op.ticket_id
       where op.workspace_id = $1 and op.entry_id = $2 and op.operation_id = $3
       for update of op`,
      [key.workspaceId, key.entryId, key.operationId],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.workspace_id !== key.workspaceId || row.entry_id !== key.entryId || row.operation_id !== key.operationId
      || !row.ticket_id || row.request_entry_id !== key.entryId || row.source !== 'public_inquiry'
      || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !row.fingerprint_key_id) {
      throw new Error('The saved public inquiry operation is inconsistent.');
    }
    return {
      key: { workspaceId: row.workspace_id, entryId: row.entry_id, operationId: row.operation_id },
      target: { workspaceId: row.workspace_id, ticketId: row.ticket_id },
      fingerprint: row.fingerprint,
      fingerprintKeyId: row.fingerprint_key_id,
    };
  }

  async allocateReference(entry: PublishedTicketIntakeEntry): Promise<string> {
    if (!samePolicy(this.requireEntry(entry.workspaceId, entry.id), entry)) return invariant();
    const { rows } = await this.sql.query<{ reference: string }>(
      `select 'TKT-' || upper(replace(gen_random_uuid()::text, '-', '')) as reference
       from alpha_private.ticket_intake_entries e
       join public.workspaces w on w.id = e.workspace_id and w.status = 'active'
       where e.workspace_id = $1 and e.id = $2 and e.slug = $3 and e.published
         and e.write_mode = 'enabled' and w.settings_json->>'ticketing_write_mode' = 'enabled'
       for share of w, e`,
      [entry.workspaceId, entry.id, entry.slug],
    );
    const reference = rows[0]?.reference;
    return typeof reference === 'string' && reference.startsWith('TKT-') ? reference : invariant();
  }

  async insertInquiry(record: Parameters<TicketPublicIntakeTransaction['insertInquiry']>[0]): Promise<void> {
    const { state, header, request } = record;
    const decoded = decodeTicketWorkflow(state);
    const contact = request.contact;
    const entry = this.requireEntry(header.workspaceId, request.entryId);
    if (this.createdTarget || state.id !== header.ticketId || state.workspaceId !== header.workspaceId
      || state.version !== 0 || state.status !== 'received' || state.clientId !== null
      || state.scopeVersionId !== null || state.agreedScopeVersionId !== null || state.authorizedScopeVersionId !== null
      || state.projectId !== null || state.requiredIssueIds.length !== 0
      || state.delivery !== null || state.withdrawalRequested || state.hold !== null || state.closureReason !== null
      || state.actionOwner !== 'pm' || state.nextAction !== 'review_ticket'
      || header.relatedTicketId !== null || header.sharedProject !== null
      || header.clientSafeCompanyLabel !== entry.companyLabel
      || request.workspaceId !== header.workspaceId || request.ticketId !== header.ticketId
      || request.entryId !== entry.id || !entry.published || entry.mode !== 'enabled' || request.source !== 'public_inquiry'
      || request.projectPreference.kind !== 'not_sure' || request.preferredProjectId !== null
      || request.requestedProjectLabel !== null || !contact
      || typeof contact.fullName !== 'string' || typeof contact.email !== 'string') {
      return invariant();
    }
    const contactId = randomUUID();
    await this.sql.query(
      `insert into alpha_private.ticket_contacts
         (id, workspace_id, full_name, email, company, email_verified, created_at)
       values ($1, $2, $3, $4, $5, false, $6)`,
      [contactId, header.workspaceId, contact.fullName, contact.email, contact.company, header.createdAt],
    );
    await this.sql.query(
      `insert into alpha_private.tickets
         (id, workspace_id, reference, title, description, client_safe_company_label, source, status, version,
          workflow_state, client_user_id, contact_id, project_id, project_display_name, project_client_visible,
          related_ticket_id, created_at, client_updated_at, internal_updated_at, closed_at)
       values ($1, $2, $3, $4, $5, $6, 'public_inquiry', $7, $8, $9::jsonb, null, $10, null, null, false,
               null, $11, $12, $13, null)`,
      [header.ticketId, header.workspaceId, header.reference, header.title, header.description,
        header.clientSafeCompanyLabel, decoded.status, decoded.version, JSON.stringify(decoded), contactId,
        header.createdAt, header.clientUpdatedAt, header.internalUpdatedAt],
    );
    await this.sql.query(
      `insert into alpha_private.ticket_requests
         (workspace_id, ticket_id, source, intake_context_id, intake_entry_id, project_preference,
          preferred_project_id, requested_project_label, requested_deadline, contact_id, submitted_at)
       values ($1, $2, 'public_inquiry', null, $3, 'not_sure', null, null, $4, $5, $6)`,
      [header.workspaceId, header.ticketId, request.entryId, request.requestedDeadline, contactId, header.createdAt],
    );
    this.createdTarget = { workspaceId: header.workspaceId, ticketId: header.ticketId };
  }

  async appendInquiryAudit(audit: Parameters<TicketPublicIntakeTransaction['appendInquiryAudit']>[0]): Promise<void> {
    this.requireEntry(audit.target.workspaceId, audit.entryId);
    this.requireCreatedTarget(audit.target);
    await this.sql.query(
      `insert into alpha_private.ticket_audit_events
         (id, workspace_id, ticket_id, actor_kind, actor_id, event_type, occurred_at, metadata)
       values ($1, $2, $3, 'anonymous', null, 'inquiry_received', $4, $5::jsonb)`,
      [randomUUID(), audit.target.workspaceId, audit.target.ticketId, audit.occurredAt,
        JSON.stringify({ entryId: audit.entryId, operationId: audit.operationId })],
    );
  }

  async enqueueInquiryReceived(signal: Parameters<TicketPublicIntakeTransaction['enqueueInquiryReceived']>[0]): Promise<void> {
    this.requireEntry(signal.target.workspaceId, signal.entryId);
    this.requireCreatedTarget(signal.target);
    const dedupeKey = `ticket-created:${signal.entryId}:${signal.operationId}`;
    await this.sql.query(
      `insert into alpha_private.ticket_outbox_events
         (id, workspace_id, ticket_id, event_type, dedupe_key, payload, status, available_at, created_at)
       values ($1, $2, $3, 'ticket_created', $4, $5::jsonb, 'pending', $6, $6)`,
      [randomUUID(), signal.target.workspaceId, signal.target.ticketId, dedupeKey,
        JSON.stringify({ source: 'public_inquiry', entryId: signal.entryId, operationId: signal.operationId,
          ...(this.acknowledgmentsEnabled ? { acknowledgmentVersion: 1 } : {}) }), signal.occurredAt],
    );
  }

  async insertInquiryOperation(operation: SavedPublicTicketIntakeOperation): Promise<void> {
    this.requireEntry(operation.key.workspaceId, operation.key.entryId);
    this.requireCreatedTarget(operation.target);
    if (operation.key.workspaceId !== operation.target.workspaceId
      || !/^[a-f0-9]{64}$/.test(operation.fingerprint) || operation.fingerprintKeyId.length === 0) return invariant();
    await this.sql.query(
      `insert into alpha_private.ticket_intake_operations
         (workspace_id, entry_id, operation_id, ticket_id, fingerprint, fingerprint_key_id, created_at)
       values ($1, $2, $3, $4, $5, $6, now())`,
      [operation.key.workspaceId, operation.key.entryId, operation.key.operationId,
        operation.target.ticketId, operation.fingerprint, operation.fingerprintKeyId],
    );
  }

  private requireEntry(workspaceId: string, entryId: string): PublishedTicketIntakeEntry {
    if (!this.lockedEntry || this.lockedEntry.workspaceId !== workspaceId || this.lockedEntry.id !== entryId) return invariant();
    return this.lockedEntry;
  }

  private requireCreatedTarget(target: { workspaceId: string; ticketId: string }): void {
    if (!this.createdTarget || this.createdTarget.workspaceId !== target.workspaceId
      || this.createdTarget.ticketId !== target.ticketId) return invariant();
  }
}
