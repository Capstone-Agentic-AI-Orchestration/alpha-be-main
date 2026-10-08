import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LockedTicket, TicketSubject } from '../store/ticketCommandStore.js';
import type { TicketDeliveryObjectReader, TicketDeliveryReadPolicy, TicketDeliverySnapshot, TicketDeliveryStore } from '../store/ticketDeliveryStore.js';
import { projectTicketDeliveryManifest } from '../ticketing/deliveryReadModels.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { createTicketDeliveryService } from './ticketDeliveryService.js';

const target = { workspaceId: 'workspace-a', ticketId: 'ticket-a' };
const client: TicketSubject = { kind: 'client', userId: 'client-a', sessionId: 'client-session' };
const pm: TicketSubject = { kind: 'internal', userId: 'pm-a', authentication: { kind: 'session', sessionId: 'pm-session' } };
const policy: TicketDeliveryReadPolicy = { maxFiles: 5, maxFileBytes: 1024, maxTotalBytes: 4096, objectReadTimeoutMs: 1000 };
const timestamp = '2026-10-08T03:00:00.000Z';
const body = Buffer.from('Reviewed result');
const sha256 = createHash('sha256').update(body).digest('hex');

function fixture() {
  const state = newTicketWorkflow(target.ticketId, target.workspaceId, client.userId);
  Object.assign(state, { scopeVersionId: 'scope-a', agreedScopeVersionId: 'scope-a', authorizedScopeVersionId: 'scope-a',
    projectId: 'private-project', requiredIssueIds: ['private-issue'], status: 'ready_for_review',
    actionOwner: 'client', nextAction: 'review_result',
    delivery: { id: 'delivery-a', scopeVersionId: 'scope-a', pinnedAssetId: 'private-bundle',
      issueRevisionIds: ['private-revision'], assessedByPmId: 'private-pm', shared: true, acceptedByClientId: null } });
  const snapshot: TicketDeliverySnapshot = {
    delivery: { ...target, id: 'delivery-a', scopeVersionId: 'scope-a', pinnedAssetId: 'private-bundle',
      issueRevisionIds: ['private-revision'], immutable: true, clientVisible: true, publicSummary: 'Review this', sharedAt: timestamp },
    manifest: { ...target, id: 'private-bundle', scopeVersionId: 'scope-a', issueRevisionIds: ['private-revision'], immutable: true,
      files: [{ ...target, id: 'file-a', pinnedAssetId: 'private-bundle', filename: 'result.txt', mediaType: 'text/plain',
        byteLength: body.length, sha256, immutable: true, clientVisible: true,
        scan: { verdict: 'clean', sha256, policyVersion: 'scan-policy-1', completedAt: timestamp },
        object: { key: 'private-storage-key', version: 'private-generation' } }] },
  };
  const control = { access: true, active: true, wrongActor: false, wrongTicket: false, developer: false,
    missing: false, mode: 'enabled' as LockedTicket['mode'], inTransaction: false,
    calls: [] as string[], duringRead: () => {}, returned: body as Uint8Array, storageError: false };
  const store: TicketDeliveryStore = {
    async transaction(work) {
      control.inTransaction = true;
      try { return await work({
        async lockAuthorizedTicket(requestTarget, subject) {
          control.calls.push('authorize');
          if (!control.access || requestTarget.workspaceId !== state.workspaceId || requestTarget.ticketId !== state.id) return null;
          if (subject.kind === 'client' && (subject.userId !== client.userId || subject.sessionId !== 'client-session')) return null;
          if (subject.kind === 'internal' && (subject.userId !== pm.userId || subject.authentication.kind !== 'session'
            || subject.authentication.sessionId !== 'pm-session')) return null;
          return { state: { ...structuredClone(state), id: control.wrongTicket ? 'foreign' : state.id }, mode: control.mode,
            actor: subject.kind === 'client'
              ? { kind: 'client', userId: control.wrongActor ? 'other-client' : subject.userId, workspaceId: state.workspaceId,
                ticketId: state.id, grantActive: control.active }
              : control.developer ? { kind: 'developer', userId: subject.userId, workspaceId: state.workspaceId }
                : { kind: 'pm', userId: subject.userId, workspaceId: state.workspaceId, membershipActive: control.active, canManageTickets: true } };
        },
        async loadDelivery(_ticket, deliveryId) {
          control.calls.push('metadata');
          return !control.missing && deliveryId === snapshot.delivery.id ? structuredClone(snapshot) : null;
        },
      }); } finally { control.inTransaction = false; }
    },
  };
  const read = vi.fn<TicketDeliveryObjectReader['read']>(async () => {
    expect(control.inTransaction).toBe(false);
    control.calls.push('storage'); control.duringRead();
    if (control.storageError) throw new Error('SECRET storage account/key');
    return control.returned;
  });
  const service = createTicketDeliveryService(store, { read }, policy);
  return { service, state, snapshot, control, read, store };
}
afterEach(() => vi.useRealTimers());

describe('protected immutable ticket deliveries', () => {
  it('projects only public file metadata and owns its result', async () => {
    const f = fixture();
    Object.assign(f.snapshot.manifest.files[0], { repositoryUrl: 'SECRET repository', privateNotes: 'SECRET note' });
    const result = await f.service.manifest(target, client, 'delivery-a');
    expect(result).toEqual({ deliveryId: 'delivery-a', scopeVersionId: 'scope-a', files: [
      { id: 'file-a', filename: 'result.txt', mediaType: 'text/plain', byteLength: body.length, sha256 },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/private-|SECRET|object|scan|workspace|ticketId/);
    result.files[0].filename = 'mutated.txt';
    expect(f.snapshot.manifest.files[0].filename).toBe('result.txt');
    expect(f.read).not.toHaveBeenCalled();
  });

  it('reads only the exact private object outside the transaction, then rechecks access', async () => {
    const f = fixture();
    const result = await f.service.content(target, client, 'delivery-a', 'file-a');
    expect(Buffer.from(result.bytes)).toEqual(body);
    expect(f.control.calls).toEqual(['authorize', 'metadata', 'storage', 'authorize', 'metadata']);
    expect(f.read).toHaveBeenCalledWith({ ...target, pinnedAssetId: 'private-bundle', fileId: 'file-a',
      key: 'private-storage-key', version: 'private-generation', maxBytes: body.length, signal: expect.any(AbortSignal) });
    expect(JSON.stringify(result.file)).not.toContain('private-');
  });

  it.each(['disabled', 'maintenance'] as const)('keeps authorized retained result reads in %s mode', async mode => {
    const f = fixture(); f.control.mode = mode; f.state.status = 'closed'; f.state.closureReason = 'accepted';
    f.state.delivery!.acceptedByClientId = client.userId;
    await expect(f.service.content(target, client, 'delivery-a', 'file-a')).resolves.toHaveProperty('file.id', 'file-a');
  });

  it('lets an authorized PM inspect an assessed result before publication, never the client', async () => {
    const f = fixture(); f.state.delivery!.shared = false; f.snapshot.delivery.sharedAt = null;
    await expect(f.service.manifest(target, client, 'delivery-a')).rejects.toMatchObject({ status: 404 });
    await expect(f.service.manifest(target, pm, 'delivery-a')).resolves.toHaveProperty('deliveryId', 'delivery-a');
  });

  it.each(['no-access', 'revoked', 'wrong-actor', 'wrong-ticket', 'foreign-workspace', 'foreign-session', 'developer'])('denies %s before metadata or storage reads', async invalid => {
    const f = fixture(); let requestTarget = target; let subject: TicketSubject = client;
    if (invalid === 'no-access') f.control.access = false;
    if (invalid === 'revoked') f.control.active = false;
    if (invalid === 'wrong-actor') f.control.wrongActor = true;
    if (invalid === 'wrong-ticket') f.control.wrongTicket = true;
    if (invalid === 'foreign-workspace') requestTarget = { ...target, workspaceId: 'foreign' };
    if (invalid === 'foreign-session') subject = { kind: 'client', userId: client.userId, sessionId: 'foreign' };
    if (invalid === 'developer') { subject = pm; f.control.developer = true; }
    await expect(f.service.content(requestTarget, subject, 'delivery-a', 'file-a')).rejects.toMatchObject({ status: invalid === 'developer' ? 403 : 404 });
    expect(f.control.calls).toEqual(['authorize']); expect(f.read).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown-delivery', 'unknown-file', 'superseded'])('returns no bytes for %s', async invalid => {
    const f = fixture();
    if (invalid === 'missing') f.control.missing = true;
    if (invalid === 'superseded') f.state.delivery = null;
    await expect(f.service.content(target, client, invalid === 'unknown-delivery' ? 'foreign' : 'delivery-a',
      invalid === 'unknown-file' ? 'foreign' : 'file-a')).rejects.toMatchObject({ status: 404 });
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(['asset-tenant', 'asset-ticket', 'asset-pin', 'asset-scope', 'asset-revisions', 'row-pin', 'row-scope', 'row-revisions',
    'row-private', 'row-mutable', 'row-unshared', 'file-tenant', 'file-ticket', 'file-pin', 'file-private', 'file-mutable',
    'scan-pending', 'scan-digest', 'scan-date', 'scan-policy', 'filename-path', 'filename-header', 'filename-bidi', 'filename-surrogate',
    'active-html', 'active-svg', 'too-large', 'duplicate-id', 'duplicate-object', 'empty', 'not-agreed', 'not-authorized'])('refuses corrupt or unsafe %s evidence without storage I/O', async invalid => {
    const f = fixture(); const m = f.snapshot.manifest; const row = f.snapshot.delivery; const file = m.files[0] as any;
    if (invalid === 'asset-tenant') m.workspaceId = 'foreign';
    if (invalid === 'asset-ticket') m.ticketId = 'foreign';
    if (invalid === 'asset-pin') m.id = 'foreign';
    if (invalid === 'asset-scope') m.scopeVersionId = 'foreign';
    if (invalid === 'asset-revisions') m.issueRevisionIds = ['foreign'];
    if (invalid === 'row-pin') row.pinnedAssetId = 'foreign';
    if (invalid === 'row-scope') row.scopeVersionId = 'foreign';
    if (invalid === 'row-revisions') row.issueRevisionIds = ['foreign'];
    if (invalid === 'row-private') row.clientVisible = false;
    if (invalid === 'row-mutable') row.immutable = false;
    if (invalid === 'row-unshared') row.sharedAt = null;
    if (invalid === 'file-tenant') file.workspaceId = 'foreign';
    if (invalid === 'file-ticket') file.ticketId = 'foreign';
    if (invalid === 'file-pin') file.pinnedAssetId = 'foreign';
    if (invalid === 'file-private') file.clientVisible = false;
    if (invalid === 'file-mutable') file.immutable = false;
    if (invalid === 'scan-pending') file.scan.verdict = 'pending';
    if (invalid === 'scan-digest') file.scan.sha256 = '0'.repeat(64);
    if (invalid === 'scan-date') file.scan.completedAt = 'invalid';
    if (invalid === 'scan-policy') file.scan.policyVersion = '';
    if (invalid === 'filename-path') file.filename = '../secret.txt';
    if (invalid === 'filename-header') file.filename = 'file\r\nInjected.txt';
    if (invalid === 'filename-bidi') file.filename = 'file\u202etxt.exe';
    if (invalid === 'filename-surrogate') file.filename = '\ud800.txt';
    if (invalid === 'active-html') file.mediaType = 'text/html';
    if (invalid === 'active-svg') file.mediaType = 'image/svg+xml';
    if (invalid === 'too-large') file.byteLength = policy.maxFileBytes + 1;
    if (invalid === 'duplicate-id') m.files.push({ ...structuredClone(file), object: { key: 'other', version: 'other' } });
    if (invalid === 'duplicate-object') m.files.push({ ...structuredClone(file), id: 'other' });
    if (invalid === 'empty') m.files = [];
    if (invalid === 'not-agreed') f.state.agreedScopeVersionId = null;
    if (invalid === 'not-authorized') f.state.authorizedScopeVersionId = null;
    await expect(f.service.content(target, client, 'delivery-a', 'file-a')).rejects.toMatchObject({ name: 'TicketReadInvariantError' });
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(['digest', 'short', 'oversize', 'storage-error'])('suppresses %s storage failures', async failure => {
    const f = fixture();
    if (failure === 'digest') f.control.returned = Buffer.alloc(body.length);
    if (failure === 'short') f.control.returned = Buffer.alloc(body.length - 1);
    if (failure === 'oversize') f.control.returned = Buffer.alloc(body.length + 1);
    if (failure === 'storage-error') f.control.storageError = true;
    await expect(f.service.content(target, client, 'delivery-a', 'file-a')).rejects.toMatchObject({
      status: 503, code: 'ticket_delivery_unavailable', message: 'The shared result is unavailable. Try again later.',
    });
  });

  it.each(['grant', 'session', 'pin', 'generation', 'scan', 'manifest', 'superseded'])('rechecks %s changes made while storage is being read', async change => {
    const f = fixture();
    f.control.duringRead = () => {
      if (change === 'grant') f.control.active = false;
      if (change === 'session') f.control.access = false;
      if (change === 'pin') f.state.delivery!.pinnedAssetId = 'other';
      if (change === 'generation') f.snapshot.manifest.files[0].object.version = 'new-version';
      if (change === 'scan') f.snapshot.manifest.files[0].scan.policyVersion = 'new-policy';
      if (change === 'manifest') f.snapshot.manifest.files[0].filename = 'other.txt';
      if (change === 'superseded') f.state.delivery = null;
    };
    await expect(f.service.content(target, client, 'delivery-a', 'file-a')).rejects.toBeInstanceOf(Error);
    expect(f.control.calls).toContain('storage');
    expect(f.control.calls.filter(call => call === 'authorize')).toHaveLength(2);
  });

  it('copies adapter-owned bytes before reauthorization', async () => {
    const f = fixture(); const mutable = Buffer.from(body); f.control.returned = mutable;
    const original = f.store.transaction.bind(f.store); let count = 0;
    f.store.transaction = async work => { count += 1; if (count === 2) mutable.fill(0); return original(work); };
    expect(Buffer.from((await f.service.content(target, client, 'delivery-a', 'file-a')).bytes)).toEqual(body);
  });

  it('aborts a timed-out object read, returns no data and does not reauthorize late completion', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.read.mockImplementation(async () => new Promise<Uint8Array>(() => {}));
    const pending = f.service.content(target, client, 'delivery-a', 'file-a');
    const assertion = expect(pending).rejects.toMatchObject({ status: 503, code: 'ticket_delivery_unavailable' });
    await vi.advanceTimersByTimeAsync(policy.objectReadTimeoutMs + 1);
    await assertion;
    expect(f.read.mock.calls[0][0].signal.aborted).toBe(true);
    expect(f.control.calls).toEqual(['authorize', 'metadata']);
  });

  it('projects transport allowlists without storage/scanner fields', () => {
    const f = fixture();
    const result = projectTicketDeliveryManifest({ deliveryId: 'delivery-a', scopeVersionId: 'scope-a',
      object: 'SECRET', files: f.snapshot.manifest.files });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private-|object|scan/);
  });

  it.each([{ ...policy, maxFiles: 0 }, { ...policy, maxFileBytes: 33 * 1024 * 1024 },
    { ...policy, maxTotalBytes: 1 }, { ...policy, objectReadTimeoutMs: 0 }])('fails closed on invalid read budgets', badPolicy => {
    const f = fixture(); expect(() => createTicketDeliveryService(f.store, { read: f.read }, badPolicy)).toThrow();
  });
});
