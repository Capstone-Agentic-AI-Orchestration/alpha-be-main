import { afterEach, describe, expect, it, vi } from 'vitest';

async function withUnavailableRouter(relayResult: boolean, work: (handler: any, relay: ReturnType<typeof vi.fn>) => Promise<void>) {
  vi.resetModules();
  const relay = vi.fn(async (_req: unknown, res: any) => {
    if (relayResult) res.status(502).json({ error: 'Could not reach the Alpha cloud.' });
    return relayResult;
  });
  vi.doMock('./ticketRequestAuth.js', () => ({ relayPmTicketRequest: relay }));
  const { createTicketUnavailableRouter } = await import('./ticketUnavailableRouter.js');
  const router = createTicketUnavailableRouter();
  try { await work((router as any).stack[0].handle, relay); }
  finally {
    vi.doUnmock('./ticketRequestAuth.js');
    vi.resetModules();
  }
}

async function invoke(handler: any) {
  const headers: Record<string, string> = {};
  return new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
      status(value: number) { this.statusCode = value; return this; },
      json(body: unknown) { resolve({ status: this.statusCode, headers, body }); return this; },
    };
    handler({ method: 'GET', originalUrl: '/api/tickets', workspace: { workspaceId: 'ws-test' } }, res, reject);
  });
}

afterEach(() => vi.doUnmock('./ticketRequestAuth.js'));

describe('unavailable ticket API boundary', () => {
  it('returns a private no-store unavailable response when relay is not available', async () => {
    await withUnavailableRouter(false, async (handler, relay) => {
      const response = await invoke(handler);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Ticket reads are not enabled for this Alpha environment.' });
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(relay).toHaveBeenCalledTimes(1);
    });
  });

  it('preserves a desktop-to-cloud relay response without local fallback', async () => {
    await withUnavailableRouter(true, async (handler, relay) => {
      const response = await invoke(handler);
      expect(response.status).toBe(502);
      expect(response.body).toEqual({ error: 'Could not reach the Alpha cloud.' });
      expect(relay).toHaveBeenCalledTimes(1);
    });
  });
});
