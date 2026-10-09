import { describe, expect, it, vi } from 'vitest';
import { createTicketIntakeTurnstileGuard } from './ticketIntakeTurnstileGuard.js';
const instant = new Date('2026-10-09T10:00:00Z');
const entry = { id: 'entry', slug: 'alpha-workspace', workspaceId: 'ws', companyLabel: 'Alpha', published: true,
  mode: 'enabled' as const, policy: { version: 'v1', perSourceMax: 10, perEntryMax: 100, windowSeconds: 60 } };
const request = { origin: 'https://alpha.example', remoteAddress: '127.0.0.1' };
const valid = { success: true, hostname: 'alpha.example', action: 'ticket_inquiry', cdata: entry.slug,
  challenge_ts: new Date(instant.getTime() - 1000).toISOString() };
function guard(result: unknown = valid) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
  return { fetcher, service: createTicketIntakeTurnstileGuard({ secret: 'test-only-secret', rateKey: new Uint8Array(32).fill(7),
    originAllowed: origin => origin === request.origin }, fetcher, () => instant) };
}
describe('real intake provider boundary', () => {
  it.each(['1x0000000000000000000000000000000AA', '2x0000000000000000000000000000000AA', '3x0000000000000000000000000000000AA'])('rejects public dummy keys without contacting the provider: %s', async secret => {
    const fetcher = vi.fn();
    const service = createTicketIntakeTurnstileGuard({ secret, rateKey: new Uint8Array(32).fill(7), originAllowed: () => true }, fetcher, () => instant);
    expect(await service.resolveVerifiedRequest('proof', entry, request)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('validates provider proof, binds hostname/action/entry, and hashes the address', async () => {
    const { fetcher, service } = guard();
    const proof = await service.resolveVerifiedRequest('a'.repeat(1000), entry, request);
    expect(proof).toMatchObject({ entryId: entry.id });
    expect(proof?.rateSubjectKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(proof)).not.toContain('127.0.0.1');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds provider clock skew and never returns a future proof', async () => {
    const service = guard({ ...valid, challenge_ts: new Date(instant.getTime() + 20).toISOString() }).service;
    expect(await service.resolveVerifiedRequest('proof', entry, request)).toMatchObject({ issuedAt: instant.toISOString() });
    const ahead = guard({ ...valid, challenge_ts: new Date(instant.getTime() + 5001).toISOString() }).service;
    expect(await ahead.resolveVerifiedRequest('proof', entry, request)).toBeNull();
  });
  it.each([{ success: false }, { hostname: 'evil.example' }, { action: 'login' }, { cdata: 'foreign' },
    { challenge_ts: '2026-10-09T09:00:00Z' }, { challenge_ts: '2026-10-09T10:01:00Z' }])('fails closed on invalid provider response %j', async change => {
    expect(await guard({ ...valid, ...change }).service.resolveVerifiedRequest('proof', entry, request)).toBeNull();
  });
  it('rejects foreign origins, absent address and oversized proof before network', async () => {
    const { service, fetcher } = guard();
    expect(await service.resolveVerifiedRequest('proof', entry, { ...request, origin: 'https://evil.example' })).toBeNull();
    expect(await service.resolveVerifiedRequest('proof', entry, { ...request, remoteAddress: null })).toBeNull();
    expect(await service.resolveVerifiedRequest('a'.repeat(2049), entry, request)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
