import { describe, expect, it, vi } from 'vitest';

import { createTicketPublicIntakeUnavailableRouter } from './ticketPublicIntakeUnavailableRouter.js';

function invoke(method: string, path: string) {
  const router = createTicketPublicIntakeUnavailableRouter();
  const handler = (router as any).stack[0].handle;
  const headers: Record<string, string> = {};
  const next = vi.fn();

  return new Promise<{ status: number; headers: Record<string, string>; body: unknown }>((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
      status(value: number) { this.statusCode = value; return this; },
      json(body: unknown) { resolve({ status: this.statusCode, headers, body }); return this; },
    };
    try {
      handler({ method, originalUrl: path }, res, (error?: unknown) => error ? reject(error) : next());
    } catch (error) {
      reject(error);
    }
  }).then(response => ({ ...response, next }));
}

describe('unavailable public ticket intake boundary', () => {
  it.each([
    ['GET', '/api/public/ticket-intakes/alpha'],
    ['POST', '/api/public/ticket-intakes/alpha'],
  ])('fails closed for %s %s before internal authentication', async (method, path) => {
    const response = await invoke(method, path);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Public ticket intake is not enabled in this Alpha environment.' });
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.next).not.toHaveBeenCalled();
  });
});
