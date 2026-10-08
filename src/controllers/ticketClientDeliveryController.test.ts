import { afterEach, describe, expect, it, vi } from 'vitest';

async function api(cloud = true, validPolicy = true) {
  vi.resetModules();
  vi.doMock('../config/env.js', () => ({ IS_CLOUD: cloud }));
  vi.doMock('./ticketRequestAuth.js', () => ({ opaqueTicketRequestValue: (value: unknown) =>
    typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value }));
  const { createTicketClientApiRouter } = await import('./ticketClientApiController.js');
  const subject = { kind: 'client', userId: 'client-a', sessionId: 'session-a' };
  const file = { id: 'file-a', filename: 'résultat (final).txt', mediaType: 'text/plain', byteLength: 4, sha256: 'a'.repeat(64),
    object: { key: 'SECRET-key' }, privateNotes: 'SECRET-notes' };
  const authenticate = vi.fn(async (..._args: unknown[]): Promise<any> => ({ kind: 'authenticated', subject }));
  const deliveryManifest = vi.fn(async (..._args: unknown[]): Promise<any> => ({
    deliveryId: 'delivery-a', scopeVersionId: 'scope-a', files: [file], repositoryUrl: 'SECRET-repository',
  }));
  const deliveryContent = vi.fn(async (..._args: unknown[]): Promise<any> => ({ file, bytes: Buffer.from('done') }));
  const router = createTicketClientApiRouter({ authenticate, deliveryManifest, deliveryContent } as any,
    { secure: true, allowedOrigins: validPolicy ? ['https://alpha.example'] : ['http://unsafe.example'] });
  const manifestPath = '/workspaces/:workspaceId/tickets/:ticketId/deliveries/:deliveryId';
  async function request(content = false, overrides: Record<string, unknown> = {}) {
    const path = content ? `${manifestPath}/files/:fileId` : manifestPath;
    const handler = (router as any).stack.find((item: any) => item.route?.path === path).route.stack[0].handle;
    return new Promise<{ status: number; headers: Record<string, string>; body: any }>((resolve, reject) => {
      const headers: Record<string, string> = {};
      const req = { params: { workspaceId: 'workspace-a', ticketId: 'ticket-a', deliveryId: 'delivery-a', fileId: 'file-a' },
        headers: { cookie: '__Secure-alpha_client_session=verified-cookie' }, query: {}, get: () => undefined, ...overrides };
      const res = { statusCode: 200,
        setHeader(name: string, value: string) { headers[name.toLowerCase()] = String(value); return this; },
        status(value: number) { this.statusCode = value; return this; },
        json(body: unknown) { resolve({ status: this.statusCode, headers, body }); return this; },
        end(body: unknown) { resolve({ status: this.statusCode, headers, body }); return this; },
      };
      handler(req, res, reject);
    });
  }
  return { request, subject, authenticate, deliveryManifest, deliveryContent, file };
}
afterEach(() => { vi.doUnmock('../config/env.js'); vi.doUnmock('./ticketRequestAuth.js'); });

describe('isolated client delivery HTTP boundary', () => {
  it('reauthenticates the dedicated client cookie and allowlists manifest fields', async () => {
    const f = await api(); const result = await f.request();
    expect(f.authenticate).toHaveBeenCalledWith('verified-cookie', undefined, undefined, false);
    expect(f.deliveryManifest).toHaveBeenCalledWith({ workspaceId: 'workspace-a', ticketId: 'ticket-a' }, f.subject, 'delivery-a');
    expect(result.body.files[0]).toEqual({ id: 'file-a', filename: f.file.filename, mediaType: 'text/plain', byteLength: 4, sha256: 'a'.repeat(64) });
    expect(JSON.stringify(result.body)).not.toMatch(/SECRET|object|privateNotes|repository/);
    expect(result.headers['cache-control']).toBe('no-store, private');
  });

  it('returns only a non-cacheable attachment, never an inline executable or storage URL', async () => {
    const f = await api(); const result = await f.request(true);
    expect(result.status).toBe(200); expect(result.body).toEqual(Buffer.from('done'));
    expect(f.deliveryContent).toHaveBeenCalledWith({ workspaceId: 'workspace-a', ticketId: 'ticket-a' }, f.subject, 'delivery-a', 'file-a');
    expect(result.headers).toMatchObject({
      'content-type': 'application/octet-stream', 'content-length': '4', 'cache-control': 'no-store, private',
      'pragma': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "sandbox; default-src 'none'", 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin',
    });
    expect(result.headers['content-disposition']).toBe('attachment; filename="delivery-file"; filename*=UTF-8\'\'r%C3%A9sultat%20%28final%29.txt');
    expect(result.headers.location).toBeUndefined(); expect(result.headers.etag).toBeUndefined();
  });

  it.each([false, true])('rejects signed-out callers before reading data (content=%s)', async content => {
    const f = await api(); f.authenticate.mockResolvedValue({ kind: 'expired' });
    expect((await f.request(content)).status).toBe(401);
    expect(f.deliveryManifest).not.toHaveBeenCalled(); expect(f.deliveryContent).not.toHaveBeenCalled();
  });

  it.each([[false, true], [true, false]])('keeps unavailable cloud/policy configurations closed (%s, %s)', async (cloud, policy) => {
    const f = await api(cloud, policy); expect((await f.request(true)).status).toBe(503);
    expect(f.authenticate).not.toHaveBeenCalled(); expect(f.deliveryContent).not.toHaveBeenCalled();
  });

  it('rejects malformed route IDs without reaching delivery storage', async () => {
    const f = await api();
    expect((await f.request(true, { params: { workspaceId: 'workspace-a', ticketId: 'ticket-a', deliveryId: 'delivery-a', fileId: ' ' } })).status).toBe(404);
    expect(f.deliveryContent).not.toHaveBeenCalled();
  });

  it('rejects a manifest for a different delivery', async () => {
    const f = await api(); f.deliveryManifest.mockResolvedValue({ deliveryId: 'other', scopeVersionId: 'scope-a', files: [f.file] });
    await expect(f.request()).rejects.toMatchObject({ name: 'TicketReadInvariantError' });
  });

  it.each(['wrong-file', 'html', 'injected-filename', 'wrong-length', 'non-bytes'])('rejects invalid %s content before sending bytes', async invalid => {
    const f = await api();
    const file: any = { ...f.file }; let bytes: unknown = Buffer.from('done');
    if (invalid === 'wrong-file') file.id = 'other';
    if (invalid === 'html') file.mediaType = 'text/html';
    if (invalid === 'injected-filename') file.filename = 'file\r\nHeader';
    if (invalid === 'wrong-length') file.byteLength = 5;
    if (invalid === 'non-bytes') bytes = 'done';
    f.deliveryContent.mockResolvedValue({ file, bytes });
    await expect(f.request(true)).rejects.toMatchObject({ name: 'TicketReadInvariantError' });
  });
});
