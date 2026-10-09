import { describe, expect, it } from 'vitest';
import { createTicketIntakeOriginRateGuard } from './ticketIntakeOriginRateGuard.js';

const instant = new Date('2026-10-10T04:00:00Z');
const entry = { id: 'entry-a', slug: 'alpha-workspace', workspaceId: 'workspace-a', companyLabel: 'Alpha',
  published: true, mode: 'enabled' as const,
  policy: { version: 'v1', perSourceMax: 10, perEntryMax: 100, windowSeconds: 60 } };
const request = { origin: 'https://alpha.example', remoteAddress: '203.0.113.45' };
const rateKey = new Uint8Array(32).fill(7);

describe('public inquiry origin and rate admission', () => {
  it('admits the exact configured HTTPS origin and HMACs the server-resolved source', async () => {
    const guard = createTicketIntakeOriginRateGuard({ rateKey, originAllowed: origin => origin === request.origin }, () => instant);
    const admission = await guard.admitRequest(entry, request);

    expect(admission).toMatchObject({
      entryId: entry.id,
      issuedAt: instant.toISOString(),
      expiresAt: new Date(instant.getTime() + 300_000).toISOString(),
    });
    expect(admission?.rateSubjectKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(admission)).not.toContain(request.remoteAddress);
  });

  it('uses distinct source buckets without exposing either source address', async () => {
    const guard = createTicketIntakeOriginRateGuard({ rateKey, originAllowed: () => true }, () => instant);
    const first = await guard.admitRequest(entry, request);
    const second = await guard.admitRequest(entry, { ...request, remoteAddress: '203.0.113.46' });
    expect(first?.rateSubjectKey).not.toBe(second?.rateSubjectKey);
    expect(first?.rateSubjectKey).toHaveLength(64);
    expect(second?.rateSubjectKey).toHaveLength(64);
  });

  it.each([
    { origin: 'http://alpha.example' },
    { origin: 'https://alpha.example/path' },
    { origin: 'https://evil.example' },
    { origin: null },
    { remoteAddress: null },
  ])('fails closed for invalid request context: %j', async override => {
    const guard = createTicketIntakeOriginRateGuard({ rateKey, originAllowed: origin => origin === request.origin }, () => instant);
    expect(await guard.admitRequest(entry, { ...request, ...override })).toBeNull();
  });

  it('fails closed if the server key is too short or the clock is invalid', async () => {
    expect(await createTicketIntakeOriginRateGuard({ rateKey: new Uint8Array(31), originAllowed: () => true }, () => instant)
      .admitRequest(entry, request)).toBeNull();
    expect(await createTicketIntakeOriginRateGuard({ rateKey, originAllowed: () => true }, () => new Date(Number.NaN))
      .admitRequest(entry, request)).toBeNull();
  });
});
