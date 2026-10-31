import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

import {
  STREAM_PROTOCOL,
  isLoopbackHostHeader,
  localAccessToken,
  requireLocalToken,
  requireLoopbackHost,
  streamTokenFromProtocols,
  verifyStreamHandshake
} from './localAccess.js';

const TOKEN = 'a'.repeat(64);
const servers: http.Server[] = [];

async function listen(app: http.RequestListener, withStream = false): Promise<number> {
  const server = http.createServer(app);
  if (withStream) {
    new WebSocketServer({
      server,
      verifyClient: (info: { origin?: string; req: http.IncomingMessage }) =>
        verifyStreamHandshake(
          { origin: info.origin, host: info.req.headers.host, protocols: info.req.headers['sec-websocket-protocol'] },
          { token: TOKEN, checkHost: true, originAllowed: origin => origin === 'file://' }
        ).ok,
      handleProtocols: protocols => (protocols.has(STREAM_PROTOCOL) ? STREAM_PROTOCOL : false)
    });
  }
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, res => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
}

function connect(port: number, protocols: string[], headers: Record<string, string> = {}): Promise<string> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, protocols, { headers });
    ws.on('open', () => { const chosen = ws.protocol; ws.close(); resolve(`open:${chosen}`); });
    ws.on('unexpected-response', (_req, res) => resolve(`refused:${res.statusCode}`));
    ws.on('error', () => resolve('error'));
  });
}

afterEach(async () => {
  delete (globalThis as { __alphaLocalToken?: unknown }).__alphaLocalToken;
  await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))));
});

describe('local daemon access', () => {
  it('prefers the shell token held in memory over the environment', () => {
    const before = process.env.ALPHA_LOCAL_TOKEN;
    process.env.ALPHA_LOCAL_TOKEN = 'from-env';
    (globalThis as { __alphaLocalToken?: unknown }).__alphaLocalToken = TOKEN;
    expect(localAccessToken()).toBe(TOKEN);
    delete (globalThis as { __alphaLocalToken?: unknown }).__alphaLocalToken;
    expect(localAccessToken()).toBe('from-env');
    if (before === undefined) delete process.env.ALPHA_LOCAL_TOKEN; else process.env.ALPHA_LOCAL_TOKEN = before;
  });

  it('accepts only loopback names in Host', () => {
    for (const host of ['127.0.0.1:4000', 'localhost:4000', '[::1]:4000', 'LOCALHOST']) expect(isLoopbackHostHeader(host)).toBe(true);
    for (const host of ['evil.example:4000', '127.0.0.1.evil.example', '', undefined]) expect(isLoopbackHostHeader(host)).toBe(false);
  });

  it('refuses API calls without the token, and a rebound Host even with it', async () => {
    const app = express();
    app.use(requireLoopbackHost);
    app.use('/api', requireLocalToken(TOKEN));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/projects', (_req, res) => res.json([]));
    app.post('/api/agent-bridge/hosting/status', (_req, res) => res.json({ reached: true }));
    const port = await listen(app);

    expect(await request(port, '/api/health')).toBe(200);
    expect(await request(port, '/api/projects')).toBe(401);
    expect(await request(port, '/api/projects', { 'X-Alpha-Token': 'wrong' })).toBe(401);
    expect(await request(port, '/api/projects', { 'X-Alpha-Token': TOKEN })).toBe(200);
    expect(await request(port, '/api/projects', { 'X-Alpha-Token': TOKEN, Host: 'rebound.example:80' })).toBe(421);
  });

  it('lets the hosting bridge through only with a run token, which the route then checks', async () => {
    const app = express();
    app.use('/api', requireLocalToken(TOKEN));
    app.post('/api/agent-bridge/hosting/status', (_req, res) => res.json({ reached: true }));
    app.post('/api/runs/r1/hosting-approvals/x/approve', (_req, res) => res.json({ reached: true }));
    const port = await listen(app);
    const post = (path: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(await post('/api/agent-bridge/hosting/status', {})).toBe(401);
    expect(await post('/api/agent-bridge/hosting/status', { 'X-Alpha-Run-Token': 'run' })).toBe(200);
    // Approving a production change is a person's action and still needs the app's token.
    expect(await post('/api/runs/r1/hosting-approvals/x/approve', { 'X-Alpha-Run-Token': 'run' })).toBe(401);
  });

  it('reads the token from the subprotocol list', () => {
    expect(streamTokenFromProtocols(`alpha.v1, alpha.token.${TOKEN}`)).toBe(TOKEN);
    expect(streamTokenFromProtocols('alpha.v1')).toBeUndefined();
    expect(streamTokenFromProtocols(undefined)).toBeUndefined();
  });

  it('accepts the app stream and refuses other pages, wrong tokens and rebound hosts', async () => {
    const port = await listen((_req, res) => res.end(), true);
    const good = [STREAM_PROTOCOL, `alpha.token.${TOKEN}`];

    // The token entry is never echoed back; only the protocol name is.
    expect(await connect(port, good, { Origin: 'file://' })).toBe(`open:${STREAM_PROTOCOL}`);
    expect(await connect(port, [STREAM_PROTOCOL], { Origin: 'file://' })).toBe('refused:401');
    expect(await connect(port, [STREAM_PROTOCOL, 'alpha.token.wrong'], { Origin: 'file://' })).toBe('refused:401');
    expect(await connect(port, good, { Origin: 'https://evil.example' })).toBe('refused:401');
    expect(await connect(port, good, { Origin: 'file://', Host: 'rebound.example' })).toBe('refused:401');
  });
});
