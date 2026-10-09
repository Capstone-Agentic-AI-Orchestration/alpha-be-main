import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTicketAcknowledgmentDeliveryService, startTicketAcknowledgmentDelivery } from './ticketAcknowledgmentDeliveryService.js';
import { TicketAcknowledgmentEmailError } from './ticketAcknowledgmentEmailProvider.js';
import type { PostgresTicketAcknowledgmentStore } from '../store/ticketAcknowledgmentPostgresStore.js';

const claim = { id: '00000000-0000-4000-8000-000000000001', workspaceId: 'ws-1', ticketId: 't-1',
  recipient: 'client@example.invalid', attempt: 1, leaseHash: 'a'.repeat(64), identityMatches: true,
  firstAttemptAt: '2026-10-09T00:00:00Z' };
function setup(overrides = {}) {
  const store = { claim: vi.fn().mockResolvedValue({ ...claim, ...overrides }),
    canDispatch: vi.fn().mockResolvedValue(true), finish: vi.fn().mockResolvedValue(undefined) };
  const provider = { identity: 'provider-identity', send: vi.fn().mockResolvedValue(undefined) };
  return { store, provider, service: createTicketAcknowledgmentDeliveryService(store as unknown as PostgresTicketAcknowledgmentStore, provider) };
}
afterEach(() => { vi.useRealTimers(); });

describe('durable acknowledgment delivery', () => {
  it('marks acceptance only after the provider accepts', async () => {
    const { store, provider, service } = setup();
    expect(await service.deliverNext()).toBe(true);
    expect(provider.send).toHaveBeenCalledWith(claim.recipient, claim.id);
    expect(store.finish).toHaveBeenCalledWith(claim, 'delivered');
    expect(store.claim).toHaveBeenCalledWith(provider.identity);
  });
  it('does not send after an uncertain database claim commit', async () => {
    const { store, provider, service } = setup();
    store.claim.mockRejectedValue(new Error('unknown commit'));
    await expect(service.deliverNext()).rejects.toThrow('unknown commit');
    expect(provider.send).not.toHaveBeenCalled();
  });
  it('leaves a lost delivery confirmation for lease recovery, not a new send', async () => {
    const { store, provider, service } = setup();
    store.finish.mockRejectedValue(new Error('lost confirmation'));
    await expect(service.deliverNext()).rejects.toThrow('lost confirmation');
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(store.finish).toHaveBeenCalledTimes(1);
  });
  it.each([{ identityMatches: false }, { firstAttemptAt: '' }, { attempt: 6 }])('never dispatches unsafe claims: %j', async override => {
    const { store, provider, service } = setup(override);
    await service.deliverNext();
    expect(provider.send).not.toHaveBeenCalled();
    expect(store.finish.mock.calls[0][1]).toBe('dead');
  });
  it('stops after the idempotency window or loss of scope/lease', async () => {
    const { store, provider, service } = setup();
    store.canDispatch.mockResolvedValue(false);
    await service.deliverNext();
    expect(provider.send).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(claim, 'dead', 'attempt_limit_reached');
  });
  it.each([{ retryable: true, attempt: 1, status: 'retry' }, { retryable: false, attempt: 1, status: 'dead' },
    { retryable: true, attempt: 5, status: 'dead' }])('bounds retries: %j', async row => {
    const { store, provider, service } = setup({ attempt: row.attempt });
    provider.send.mockRejectedValue(new TicketAcknowledgmentEmailError(row.retryable));
    await service.deliverNext();
    expect(store.finish.mock.calls[0].slice(1)).toEqual([row.status, 'provider_failure']);
  });
  it('does not construct/connect the store on desktop, disabled email, or incomplete sender setup', () => {
    const database = vi.fn();
    const onUnavailable = vi.fn();
    const providerFactory = vi.fn().mockReturnValue(null);
    const configuration = { isCloud: true, enabled: true, providerFactory, database, onUnavailable };
    startTicketAcknowledgmentDelivery({ ...configuration, isCloud: false })();
    startTicketAcknowledgmentDelivery({ ...configuration, enabled: false })();
    expect(providerFactory).not.toHaveBeenCalled();
    startTicketAcknowledgmentDelivery(configuration)();
    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(database).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
