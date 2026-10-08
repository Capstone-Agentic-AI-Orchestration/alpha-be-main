import { describe, expect, it } from 'vitest';
import { DatabaseCommitError } from '../store/database.js';
import { deliveryArtifact, deliveryTarget, registrationInput, ticketDeliveryWorkflowFixture } from '../test/ticketDeliveryWorkflowFixture.js';

describe('immutable delivery registration', () => {
  it('registers an owned protected candidate without assessment, client publication, workflow mutation or notification', async () => {
    const f = ticketDeliveryWorkflowFixture(); const before = structuredClone(f.data.state);
    const result = await f.register();
    expect(result).toEqual({ ticketId: 'ticket-a', operationId: 'register-result', deliveryId: 'delivery-1', version: 5, status: 'in_progress' });
    expect(f.data.state).toEqual(before);
    expect(f.data.deliveries.get(result.deliveryId)?.delivery).toMatchObject({ immutable: true, sharedAt: null, publicSummary: registrationInput.publicSummary });
    expect(f.data.signals).toEqual([]);
    expect(f.control.calls).toEqual(['artifact-authorize', 'find', 'evidence', 'bundle', 'insert', 'audit', 'operation']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|scope|bundle|verification|revision/);
  });
  it.each(['insert', 'audit', 'operation'])('rolls back the candidate and outcome on %s failure', async stage => {
    const f = ticketDeliveryWorkflowFixture(); const before = structuredClone(f.data); f.control.failAt = stage;
    await expect(f.register()).rejects.toThrow(`Injected ${stage} failure`);
    expect(f.data).toEqual(before);
  });
  it('rolls back on version CAS failure', async () => {
    const f = ticketDeliveryWorkflowFixture(); f.control.cas = false;
    await expect(f.register()).rejects.toMatchObject({ code: 'ticket_version_conflict' });
    expect(f.data.deliveries.size).toBe(0); expect(f.data.audits).toEqual([]);
  });
  it('recovers an unknown commit without registering another delivery', async () => {
    const f = ticketDeliveryWorkflowFixture(); f.control.commitUnknown = true;
    await expect(f.register()).rejects.toBeInstanceOf(DatabaseCommitError);
    await expect(f.registration.lookup(deliveryTarget, deliveryArtifact, registrationInput.operationId)).resolves.toHaveProperty('deliveryId', 'delivery-1');
    await expect(f.register()).resolves.toHaveProperty('deliveryId', 'delivery-1');
    expect(f.data.deliveries.size).toBe(1); expect(f.data.audits).toHaveLength(1);
  });
  it('deduplicates simultaneous registration retries', async () => {
    const f = ticketDeliveryWorkflowFixture(); const outcomes = await Promise.all([f.register(), f.register()]);
    expect(outcomes[0]).toEqual(outcomes[1]); expect(f.data.deliveries.size).toBe(1);
  });
  it('rejects changed payloads under the same operation ID', async () => {
    const f = ticketDeliveryWorkflowFixture(); await f.register();
    await expect(f.register({ ...registrationInput, publicSummary: 'Different summary' })).rejects.toMatchObject({ code: 'ticket_operation_conflict' });
    expect(f.data.deliveries.size).toBe(1);
  });
  it('refuses a second operation for an already registered bundle', async () => {
    const f = ticketDeliveryWorkflowFixture(); await f.register();
    await expect(f.register({ ...registrationInput, operationId: 'another-operation' })).rejects.toMatchObject({ code: 'delivery_already_registered' });
  });
  it.each(['disabled', 'maintenance', undefined] as const)('refuses %s writes but permits authorized recovery', async mode => {
    const f = ticketDeliveryWorkflowFixture(); await f.register(); f.control.mode = mode;
    await expect(f.register()).rejects.toMatchObject({ status: 503 });
    await expect(f.registration.lookup(deliveryTarget, deliveryArtifact, registrationInput.operationId)).resolves.toHaveProperty('deliveryId', 'delivery-1');
  });
  it.each(['revoked', 'foreign-source', 'foreign-tenant', 'unverified'])('refuses %s authority before parsing', async invalid => {
    const f = ticketDeliveryWorkflowFixture();
    if (invalid === 'revoked') f.control.artifactAccess = false;
    if (invalid === 'foreign-source') f.control.source.ticketId = 'other';
    if (invalid === 'foreign-tenant') f.control.source.workspaceId = 'other';
    if (invalid === 'unverified') f.control.source.authorized = false;
    await expect(f.register({ facts: 'injected' })).rejects.toMatchObject({ status: 404 });
    expect(f.control.calls).toEqual(['artifact-authorize']);
  });
  it.each(['raw-objects', 'facts', 'actor', 'pinnedAssetId', 'deliveryId', 'sharedAt'])('rejects caller-controlled %s fields', async field => {
    const f = ticketDeliveryWorkflowFixture();
    await expect(f.register({ ...registrationInput, [field]: 'injected' })).rejects.toMatchObject({ status: 400 });
    expect(f.data.deliveries.size).toBe(0);
  });
  it.each(['missing-ready', 'ready-owner', 'ready-hash-only', 'ready-future', 'old-source', 'wrong-bundle', 'failed-review', 'active-run', 'wrong-scope', 'held', 'withdrawal'])('refuses %s provenance without registering files', async invalid => {
    const f = ticketDeliveryWorkflowFixture();
    if (invalid === 'missing-ready') f.control.readiness = null as any;
    if (invalid === 'ready-owner') f.control.readiness.key.ticketId = 'other';
    if (invalid === 'ready-hash-only') f.control.readiness.manifest.issueRevisions[0].revisionId = 'other';
    if (invalid === 'ready-future') f.control.readiness.receipt.version = 6;
    if (invalid === 'old-source') f.control.source.issueRevisionId = 'old';
    if (invalid === 'wrong-bundle') f.control.artifactManifest.id = 'other';
    if (invalid === 'failed-review') f.control.facts.issues![1].requiredReviewsPassed = false;
    if (invalid === 'active-run') f.control.facts.issues![1].hasActiveRun = true;
    if (invalid === 'wrong-scope') f.control.facts.issues![0].scopeVersionId = 'other';
    if (invalid === 'held') f.data.state.status = 'on_hold';
    if (invalid === 'withdrawal') f.data.state.withdrawalRequested = true;
    await expect(f.register()).rejects.toMatchObject({ status: 409 });
    expect(f.data.deliveries.size).toBe(0);
  });
  it.each(['foreign-file', 'foreign-manifest', 'unscanned', 'digest-mismatch', 'html', 'oversize', 'duplicate', 'path-name'])('refuses unsafe %s assets', async invalid => {
    const f = ticketDeliveryWorkflowFixture(); const m = f.control.artifactManifest; const file = m.files[0] as any;
    if (invalid === 'foreign-file') file.workspaceId = 'other';
    if (invalid === 'foreign-manifest') m.ticketId = 'other';
    if (invalid === 'unscanned') file.scan.verdict = 'pending';
    if (invalid === 'digest-mismatch') file.scan.sha256 = 'b'.repeat(64);
    if (invalid === 'html') file.mediaType = 'text/html';
    if (invalid === 'oversize') file.byteLength = 1025;
    if (invalid === 'duplicate') m.files.push(structuredClone(file));
    if (invalid === 'path-name') file.filename = '../secret';
    await expect(f.register()).rejects.toMatchObject({ name: 'TicketReadInvariantError' });
    expect(f.data.deliveries.size).toBe(0);
  });
  it('owns and strips extra private artifact columns', async () => {
    const f = ticketDeliveryWorkflowFixture(); Object.assign(f.control.artifactManifest.files[0], { notes: 'PRIVATE-note' });
    const result = await f.register(); const file = f.data.deliveries.get(result.deliveryId)!.manifest.files[0];
    expect(file).not.toHaveProperty('notes');
    f.control.artifactManifest.files[0].filename = 'changed.txt';
    expect(file.filename).toBe('result.txt');
  });
  it('rechecks artifact authority for receipt recovery', async () => {
    const f = ticketDeliveryWorkflowFixture(); await f.register(); f.control.artifactAccess = false;
    await expect(f.registration.lookup(deliveryTarget, deliveryArtifact, registrationInput.operationId)).rejects.toMatchObject({ status: 404 });
  });
});
