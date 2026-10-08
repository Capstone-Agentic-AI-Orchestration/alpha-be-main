import { afterEach, describe, expect, it, vi } from 'vitest';

async function fixture(role = 'pm', relay = false) {
  vi.resetModules();
  const relayRequest = vi.fn(async (_req: any, res: any) => { if (relay) res.status(503).json({ error: 'Cloud unavailable' }); return relay; });
  vi.doMock('./ticketRequestAuth.js', () => ({
    relayPmTicketRequest: relayRequest,
    opaqueTicketRequestValue: (value: unknown) => typeof value === 'string' && value.length > 0 && value.trim() === value,
    pmTicketSubject: (_req: any, res: any) => {
      if (role !== 'pm') { res.status(403).json({ error: 'PM required' }); return null; }
      return { kind: 'internal', userId: 'pm-server', authentication: { kind: 'session', sessionId: 'session-server' } };
    },
  }));
  const { createTicketPmDeliveryCandidatesRouter } = await import('./ticketPmDeliveryCandidatesController.js');
  const file = { id: 'file-a', filename: 'result.txt', mediaType: 'text/plain' as const, byteLength: 4, sha256: 'a'.repeat(64) };
  const list = vi.fn(async (..._args: unknown[]): Promise<any> => ({ items: [{ id: 'delivery-a', scopeVersionId: 'scope-a', summary: 'Prepared result', fileCount: 1, storage: 'PRIVATE' }], nextCursor: null, notes: 'PRIVATE' }));
  const manifest = vi.fn(async (..._args: unknown[]) => ({ deliveryId: 'delivery-a', scopeVersionId: 'scope-a', files: [file] }));
  const content = vi.fn(async (..._args: unknown[]) => ({ file, bytes: Buffer.from('done') }));
  const router = createTicketPmDeliveryCandidatesRouter({ list, manifest, content });
  async function request(query: Record<string, unknown> = {}, routeIndex: number | null = null) {
    const stack = (router as any).stack;
    const handler = routeIndex === null ? stack[0].route.stack[0].handle : stack[1].handle.stack[routeIndex].route.stack[0].handle;
    return new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve, reject) => {
      const headers: Record<string, string> = {};
      const res = { statusCode: 200, setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
        status(value: number) { this.statusCode = value; return this; }, json(body: unknown) { resolve({ status: this.statusCode, body, headers }); return this; } };
      handler({ workspace: { workspaceId: 'workspace-server', role }, params: { ticketId: 'ticket-a', deliveryId: 'delivery-a', fileId: 'file-a' }, query }, res, reject);
    });
  }
  return { request, list, manifest, content, router };
}
afterEach(() => vi.doUnmock('./ticketRequestAuth.js'));
describe('PM prepared-result transport', () => {
  it('uses the authenticated workspace and projects only candidate metadata', async () => {
    const f = await fixture(); const result = await f.request({ limit: '5', after: 'cursor-a' });
    expect(f.list).toHaveBeenCalledWith({ workspaceId: 'workspace-server', ticketId: 'ticket-a' },
      { kind: 'internal', userId: 'pm-server', authentication: { kind: 'session', sessionId: 'session-server' } }, { limit: 5, after: 'cursor-a' });
    expect(JSON.stringify(result.body)).not.toContain('PRIVATE'); expect(result.headers['cache-control']).toBe('no-store, private');
  });
  it.each(['client', 'dev'])('denies %s before listing candidates', async role => {
    const f = await fixture(role); expect((await f.request()).status).toBe(403); expect(f.list).not.toHaveBeenCalled();
  });
  it('preserves cloud-relay refusal without a local fallback', async () => {
    const f = await fixture('pm', true); expect((await f.request()).status).toBe(503); expect(f.list).not.toHaveBeenCalled();
  });
  it.each([{ workspaceId: 'attacker' }, { limit: ['5'] }, { after: { ticketId: 'other' } }])('rejects malformed or scope-injection query %j', async query => {
    const f = await fixture(); expect((await f.request(query)).status).toBe(400); expect(f.list).not.toHaveBeenCalled();
  });
  it('reuses bounded PM content inspection only under the candidate namespace', async () => {
    const f = await fixture();
    const child = (f.router as any).stack[1].handle;
    expect(child.stack[0].route.path).toBe('/:ticketId/delivery-candidates/:deliveryId');
    expect((await f.request({}, 1)).body.bytesBase64).toBe(Buffer.from('done').toString('base64'));
  });
  it.each(['duplicate', 'wrong-cursor', 'unsafe-count'])('refuses corrupt %s list responses', async invalid => {
    const f = await fixture(); const row: any = { id: 'delivery-a', scopeVersionId: 'scope-a', summary: 'Result', fileCount: 1 };
    f.list.mockResolvedValue({ items: invalid === 'duplicate' ? [row, row] : [{ ...row, fileCount: invalid === 'unsafe-count' ? 101 : 1 }], nextCursor: invalid === 'wrong-cursor' ? 'foreign' : null });
    await expect(f.request()).rejects.toMatchObject({ name: 'TicketReadInvariantError' });
  });
});
