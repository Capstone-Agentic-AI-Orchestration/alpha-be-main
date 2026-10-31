import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Who may talk to the desktop daemon.
 *
 * The daemon listens on loopback, which keeps other machines out but not other
 * things on this one: any web page the person has open can send requests to
 * 127.0.0.1, and a page whose hostname is made to resolve to 127.0.0.1 (DNS
 * rebinding) can even read the answers, because to the browser it is the same
 * origin. Three checks close that:
 *
 *   - Host. A rebound page still sends its own hostname in Host, so a daemon
 *     that answers only loopback names refuses it.
 *   - Token. The installed app makes a random secret per launch and hands it
 *     to its own window over IPC. Nothing else on the machine is told it.
 *   - WebSocket handshake. Browsers let any page open a socket to any address,
 *     so the stream checks Origin and the token before accepting.
 *
 * The token is optional so a daemon run from source keeps working with no
 * setup; the installed app always sets one.
 */

/** The token for this process: the desktop's in-memory one, else ALPHA_LOCAL_TOKEN. */
export function localAccessToken(): string | undefined {
  const fromShell = (globalThis as { __alphaLocalToken?: unknown }).__alphaLocalToken;
  if (typeof fromShell === 'string' && fromShell.length >= 32) return fromShell;
  const fromEnv = process.env.ALPHA_LOCAL_TOKEN?.trim();
  return fromEnv || undefined;
}

/** Constant-time comparison, so response timing says nothing about the secret. */
export function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0:0:0:0:0:0:0:1']);

/** Whether a Host header names this machine's loopback interface. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  // [::1]:3001, 127.0.0.1:3001, localhost:3001, or the bare name.
  const name = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0];
  return LOOPBACK_NAMES.has(name);
}

/** Whether the daemon is bound to loopback, which is when the Host check applies. */
export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_NAMES.has(host.trim().toLowerCase());
}

/** Refuse requests addressed to any name other than loopback (DNS rebinding). */
export function requireLoopbackHost(req: Request, res: Response, next: NextFunction): void {
  if (isLoopbackHostHeader(req.headers.host)) return next();
  res.status(421).json({ error: 'This address is not served here.' });
}

/**
 * Routes that carry their own, narrower credential and are called by something
 * other than the app window.
 *
 * The alpha-hosting MCP server is a child of an agent CLI. It authenticates
 * each call with its run's token, which reaches only that run's repositories
 * (see agentBridgeController). Giving it the full local token instead would
 * hand the whole API to every agent.
 */
const OWN_CREDENTIAL_ROUTES = [/^\/agent-bridge\/hosting\//];

/** Express middleware for /api: the token, except on /health and run-token routes. */
export function requireLocalToken(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/health') return next();
    if (OWN_CREDENTIAL_ROUTES.some(route => route.test(req.path)) && req.header('X-Alpha-Run-Token')) return next();
    if (tokenMatches(req.header('X-Alpha-Token'), expected)) return next();
    res.status(401).json({ error: 'Missing or invalid X-Alpha-Token' });
  };
}

/** The subprotocol the app asks for; the token rides in a second entry. */
export const STREAM_PROTOCOL = 'alpha.v1';
const TOKEN_PROTOCOL_PREFIX = 'alpha.token.';

/**
 * The token from Sec-WebSocket-Protocol.
 *
 * A browser cannot set headers on a WebSocket, and a query string ends up in
 * logs and history, so the token is offered as a subprotocol the server never
 * selects. Only alpha.v1 is echoed back.
 */
export function streamTokenFromProtocols(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const entry = raw.split(',').map(p => p.trim()).find(p => p.startsWith(TOKEN_PROTOCOL_PREFIX));
  return entry ? entry.slice(TOKEN_PROTOCOL_PREFIX.length) : undefined;
}

export interface StreamHandshake {
  origin?: string;
  host?: string;
  protocols?: string | string[];
}

/** Whether to accept a WebSocket upgrade, and why not when refused. */
export function verifyStreamHandshake(
  handshake: StreamHandshake,
  options: { token?: string; checkHost: boolean; originAllowed: (origin: string) => boolean }
): { ok: true } | { ok: false; reason: 'host' | 'origin' | 'token' } {
  if (options.checkHost && !isLoopbackHostHeader(handshake.host)) return { ok: false, reason: 'host' };
  if (handshake.origin && !options.originAllowed(handshake.origin)) return { ok: false, reason: 'origin' };
  if (options.token && !tokenMatches(streamTokenFromProtocols(handshake.protocols), options.token)) {
    return { ok: false, reason: 'token' };
  }
  return { ok: true };
}
