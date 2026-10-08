import { afterEach, describe, expect, it, vi } from 'vitest';

async function api(role = 'pm', relay = false) {
  vi.resetModules();
  const relayRequest = vi.fn(async (_req: any, res: any) => { if (relay) res.status(503).json({ error: 'Cloud unavailable' }); return relay; });
  vi.doMock('./ticketRequestAuth.js', () => ({
    relayPmTicketRequest: relayRequest,
    opaqueTicketRequestValue: (value: unknown) => typeof value === 'string' && value.trim() === value && value.length > 0,
    pmTicketSubject: (req: any, res: any) => {
      if (req.workspace?.role !== 'pm') { res.status(403).json({ error: 'PM required' }); return null; }
      return { kind: 'internal', userId: 'pm-server', authentication: { kind: 'session', sessionId: 'session-server' } };
    },
  }));
  const { createTicketPmDeliveryRouter } = await import('./ticketPmDeliveryController.js');
  const file = { id: 'file-a', filename: 'result.txt', mediaType: 'text/plain', byteLength: 4, sha256: 'a'.repeat(64),
    object: { key: 'SECRET' }, privateNotes: 'SECRET' };
  const manifest = vi.fn(async (..._args: unknown[]): Promise<any> => ({ deliveryId: 'delivery-a', scopeVersionId: 'scope-a', files: [file], repository: 'SECRET' }));
  const content = vi.fn(async (..._args: unknown[]): Promise<any> => ({ file, bytes: Buffer.from('done') }));
  const router = createTicketPmDeliveryRouter({ manifest, content });
  async function request(binary = false, overrides: Record<string, unknown> = {}) {
    const handler = (router as any).stack[binary ? 1 : 0].route.stack[0].handle;
    return new Promise<{ status: number; headers: Record<string, string>; body: any }>((resolve, reject) => {
      const headers: Record<string, string> = {};
      const req = { params: { ticketId: 'ticket-a', deliveryId: 'delivery-a', fileId: 'file-a' },
        workspace: { workspaceId: 'workspace-server', role }, query: {}, headers: {}, ...overrides };
      const res = { statusCode: 200,
        setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
        status(value: number) { this.statusCode = value; return this; },
        json(body: unknown) { resolve({ status: this.statusCode, headers, body }); return this; },
      };
      handler(req, res, reject);
    });
  }
  return { request, manifest, content, file, relayRequest };
}
afterEach(() => vi.doUnmock('./ticketRequestAuth.js'));
describe('PM delivery inspection transport', () => {
  it('uses only the authenticated workspace/PM, with safe metadata and no client cookies', async () => {
    const f = await api(); const result = await f.request(false, { query: { workspaceId: 'attacker' }, headers: { 'X-Workspace-Id': 'attacker' } });
    expect(f.manifest).toHaveBeenCalledWith({ workspaceId: 'workspace-server', ticketId: 'ticket-a' },
      { kind: 'internal', userId: 'pm-server', authentication: { kind: 'session', sessionId: 'session-server' } }, 'delivery-a');
    expect(result.headers['cache-control']).toBe('no-store, private'); expect(JSON.stringify(result.body)).not.toContain('SECRET');
  });
  it('returns a bounded allowlisted JSON content envelope for the existing desktop relay', async () => {
    const f = await api(); const result = await f.request(true);
    expect(result.body.bytesBase64).toBe(Buffer.from('done').toString('base64'));
    expect(result.body.file.id).toBe('file-a'); expect(JSON.stringify(result.body)).not.toContain('SECRET');
    expect(result.headers['referrer-policy']).toBe('no-referrer');
  });
  it.each([false, true])('fails closed on the existing relay without falling back to local storage (%s)', async binary => {
    const f = await api('pm', true); expect((await f.request(binary)).status).toBe(503);
    expect(f.manifest).not.toHaveBeenCalled(); expect(f.content).not.toHaveBeenCalled();
  });
  it.each(['dev', 'client'])('denies %s before application reads', async role => {
    const f = await api(role); expect((await f.request(true)).status).toBe(403);
    expect(f.content).not.toHaveBeenCalled();
  });
  it('refuses a mismatched result ID and malformed file ID', async () => {
    const f = await api(); f.manifest.mockResolvedValue({ deliveryId: 'foreign', scopeVersionId: 'scope-a', files: [f.file] });
    await expect(f.request()).rejects.toMatchObject({ name: 'TicketReadInvariantError' });
    expect((await f.request(true, { params: { ticketId: 'ticket-a', deliveryId: 'delivery-a', fileId: ' ' } })).status).toBe(404);
    expect(f.content).not.toHaveBeenCalled();
  });
  it.each(['wrong-id', 'html', 'oversize', 'length', 'not-bytes'])('refuses %s before serializing bytes', async invalid => {
    const f = await api(); const file: any = { ...f.file }; let bytes: unknown = Buffer.from('done');
    if (invalid === 'wrong-id') file.id = 'foreign';
    if (invalid === 'html') file.mediaType = 'text/html';
    if (invalid === 'oversize') file.byteLength = 33 * 1024 * 1024;
    if (invalid === 'length') file.byteLength = 5;
    if (invalid === 'not-bytes') bytes = 'done';
    f.content.mockResolvedValue({ file, bytes });
    await expect(f.request(true)).rejects.toMatchObject({ name: 'TicketReadInvariantError' });
  });
});
