import { describe, expect, it } from 'vitest';
import { deliveryBody, deliveryClient, deliveryPm, deliveryTarget, ticketDeliveryWorkflowFixture } from '../test/ticketDeliveryWorkflowFixture.js';

describe('PM delivery candidate inspection and assessment lifecycle', () => {
  it('keeps registration, protected PM inspection, assessment and client sharing distinct', async () => {
    const f = ticketDeliveryWorkflowFixture(); const result = await f.register();
    expect((await f.assessment.list(deliveryTarget, deliveryPm)).items).toEqual([
      { id: result.deliveryId, scopeVersionId: 'scope-a', summary: 'The reviewed result for the agreed work.', fileCount: 1 },
    ]);
    await expect(f.deliveries.manifest(deliveryTarget, deliveryClient, result.deliveryId)).rejects.toMatchObject({ status: 404 });
    const inspected = await f.assessment.content(deliveryTarget, deliveryPm, result.deliveryId, 'file-a');
    expect(Buffer.from(inspected.bytes)).toEqual(deliveryBody);
    expect(f.data.state.delivery).toBeNull(); expect(f.data.signals).toEqual([]);
    await f.commands.execute(deliveryTarget, deliveryPm, { schemaVersion: 1, operationId: 'assessment', expectedVersion: 5, command: { type: 'assess_delivery', deliveryId: result.deliveryId } });
    expect(f.data.state).toMatchObject({ version: 6, nextAction: 'share_result', delivery: { shared: false, assessedByPmId: 'pm-a' } });
    await expect(f.assessment.manifest(deliveryTarget, deliveryPm, result.deliveryId)).rejects.toMatchObject({ status: 404 });
    await expect(f.deliveries.manifest(deliveryTarget, deliveryClient, result.deliveryId)).rejects.toMatchObject({ status: 404 });
    await f.commands.execute(deliveryTarget, deliveryPm, { schemaVersion: 1, operationId: 'sharing', expectedVersion: 6, command: { type: 'share_delivery', deliveryId: result.deliveryId } });
    expect(f.data.state.status).toBe('ready_for_review');
    await expect(f.deliveries.content(deliveryTarget, deliveryClient, result.deliveryId, 'file-a')).resolves.toHaveProperty('file.id', 'file-a');
  });
  it('projects only candidate metadata, not private provenance or storage locations', async () => {
    const f = ticketDeliveryWorkflowFixture(); await f.register();
    expect(JSON.stringify(await f.assessment.list(deliveryTarget, deliveryPm))).not.toMatch(/PRIVATE|pinned|revision|object|verification|runId/);
    expect(JSON.stringify(await f.assessment.manifest(deliveryTarget, deliveryPm, 'delivery-1'))).not.toMatch(/PRIVATE|pinned|revision|object|verification|runId/);
  });
  it.each(['client', 'developer', 'revoked-pm', 'wrong-workspace', 'wrong-session'])('denies %s before candidate access', async invalid => {
    const f = ticketDeliveryWorkflowFixture(); await f.register(); f.control.calls = [];
    let subject = deliveryPm; let target = deliveryTarget;
    if (invalid === 'client') subject = deliveryClient;
    if (invalid === 'developer') f.control.developer = true;
    if (invalid === 'revoked-pm') f.control.pmActive = false;
    if (invalid === 'wrong-workspace') target = { ...target, workspaceId: 'other' };
    if (invalid === 'wrong-session') subject = { kind: 'internal', userId: deliveryPm.userId, authentication: { kind: 'session', sessionId: 'other' } };
    await expect(f.assessment.manifest(target, subject, 'delivery-1')).rejects.toMatchObject({ status: ['client', 'developer', 'revoked-pm'].includes(invalid) ? 403 : 404 });
    expect(f.control.calls).toEqual(['authorize']);
  });
  it.each(['disabled', 'maintenance', undefined] as const)('fails closed on %s candidate inspection', async mode => {
    const f = ticketDeliveryWorkflowFixture(); await f.register(); f.control.mode = mode;
    await expect(f.assessment.list(deliveryTarget, deliveryPm)).rejects.toMatchObject({ status: 503 });
  });
  it.each(['missing', 'held', 'withdrawal', 'failed-review', 'active-run', 'old-revision', 'unsafe-project', 'wrong-ready-manifest'])('refuses %s candidate evidence', async invalid => {
    const f = ticketDeliveryWorkflowFixture(); await f.register();
    if (invalid === 'missing') f.data.deliveries.clear();
    if (invalid === 'held') f.data.state.status = 'on_hold';
    if (invalid === 'withdrawal') f.data.state.withdrawalRequested = true;
    if (invalid === 'failed-review') f.control.facts.issues![0].requiredReviewsPassed = false;
    if (invalid === 'active-run') f.control.facts.issues![1].hasActiveRun = true;
    if (invalid === 'old-revision') f.control.facts.issues![0].revisionId = 'newer';
    if (invalid === 'unsafe-project') f.control.facts.project!.nonProductionSafe = false;
    if (invalid === 'wrong-ready-manifest') f.control.readiness.manifest.issueRevisions[0].revisionId = 'foreign';
    await expect(f.assessment.manifest(deliveryTarget, deliveryPm, 'delivery-1')).rejects.toThrow();
    expect(f.control.calls).not.toContain('storage');
  });
  it.each(['revoked', 'revised', 'assessed', 'scan-invalidated', 'manifest-mutated'])('rechecks %s while object bytes are being read', async invalid => {
    const f = ticketDeliveryWorkflowFixture(); await f.register();
    f.control.duringRead = () => {
      if (invalid === 'revoked') f.control.pmActive = false;
      if (invalid === 'revised') f.control.facts.issues![0].revisionId = 'newer';
      if (invalid === 'assessed') f.data.state.delivery = { id: 'delivery-1', scopeVersionId: 'scope-a', pinnedAssetId: 'private-bundle-a', issueRevisionIds: ['revision-a', 'revision-b'], assessedByPmId: 'pm-a', shared: false, acceptedByClientId: null };
      if (invalid === 'scan-invalidated') (f.data.deliveries.get('delivery-1')!.manifest.files[0].scan as any).verdict = 'quarantined';
      if (invalid === 'manifest-mutated') f.data.deliveries.get('delivery-1')!.delivery.publicSummary = 'Changed';
    };
    await expect(f.assessment.content(deliveryTarget, deliveryPm, 'delivery-1', 'file-a')).rejects.toThrow();
  });
  it('refuses corrupt bytes and does not expose storage failures', async () => {
    const f = ticketDeliveryWorkflowFixture(); await f.register(); f.control.storageBody = Buffer.alloc(deliveryBody.length);
    await expect(f.assessment.content(deliveryTarget, deliveryPm, 'delivery-1', 'file-a')).rejects.toMatchObject({ status: 503, code: 'ticket_delivery_unavailable' });
    f.control.storageError = true;
    await expect(f.assessment.content(deliveryTarget, deliveryPm, 'delivery-1', 'file-a')).rejects.not.toThrow('PRIVATE');
  });
  it('revalidates the registered scan evidence when approval is written after inspection', async () => {
    const f = ticketDeliveryWorkflowFixture(); await f.register();
    await f.assessment.content(deliveryTarget, deliveryPm, 'delivery-1', 'file-a');
    (f.data.deliveries.get('delivery-1')!.manifest.files[0].scan as any).verdict = 'quarantined';
    const before = structuredClone(f.data);
    await expect(f.commands.execute(deliveryTarget, deliveryPm, { schemaVersion: 1, operationId: 'unsafe-approval', expectedVersion: 5,
      command: { type: 'assess_delivery', deliveryId: 'delivery-1' } })).rejects.toMatchObject({ name: 'TicketReadInvariantError' });
    expect(f.data).toEqual(before);
  });
  it('pages scoped candidates with bounded limits and stable ordering', async () => {
    const f = ticketDeliveryWorkflowFixture(); await f.register();
    const extra = structuredClone(f.data.deliveries.get('delivery-1')!); extra.delivery.id = 'delivery-2';
    f.data.deliveries.set('delivery-2', extra);
    const first = await f.assessment.list(deliveryTarget, deliveryPm, { limit: 1 });
    expect(first.items.map(item => item.id)).toEqual(['delivery-1']); expect(first.nextCursor).toBe('delivery-1');
    const second = await f.assessment.list(deliveryTarget, deliveryPm, { limit: 1, after: first.nextCursor });
    expect(second.items.map(item => item.id)).toEqual(['delivery-2']); expect(second.nextCursor).toBeNull();
    await expect(f.assessment.list(deliveryTarget, deliveryPm, { limit: 21 })).rejects.toMatchObject({ status: 400 });
  });
});
