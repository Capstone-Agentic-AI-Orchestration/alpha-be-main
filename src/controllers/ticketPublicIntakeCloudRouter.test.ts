import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionalSql } from '../store/database.js';
import { createTicketPublicIntakeCloudRouter } from './ticketPublicIntakeCloudRouter.js';

const { loadPublishedEntry } = vi.hoisted(() => ({ loadPublishedEntry: vi.fn() }));
vi.mock('../store/ticketPublicIntakePostgresStore.js', () => ({
  PostgresTicketPublicIntakeStore: class { loadPublishedEntry = loadPublishedEntry; },
}));

const configuration = {
  sessionSecret: 'synthetic-session-secret-at-least-32-characters',
  turnstileSecret: 'synthetic-secret', turnstileSiteKey: 'synthetic-public-key',
  originAllowed: () => true,
};
function getConfiguration(overrides: Partial<typeof configuration> = {}) {
  const router = createTicketPublicIntakeCloudRouter({} as TransactionalSql, { ...configuration, ...overrides });
  const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/:slug/config').route.stack[0].handle;
  return new Promise<{ status: number; body: unknown; headers: Record<string, string> }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
      status(status: number) { this.statusCode = status; return this; },
      json(body: unknown) { resolve({ status: this.statusCode, body, headers }); return this; },
    };
    handler({ params: { slug: 'published-entry' } }, res, reject);
  });
}
beforeEach(() => { loadPublishedEntry.mockReset(); loadPublishedEntry.mockResolvedValue({ published: true, mode: 'enabled' }); });

describe('production inquiry configuration boundary', () => {
  it('publishes only the public site key and prevents caching', async () => {
    const result = await getConfiguration();
    expect(result.body).toEqual({ enabled: true, siteKey: configuration.turnstileSiteKey });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(result)).not.toContain(configuration.turnstileSecret);
    expect(JSON.stringify(result)).not.toContain(configuration.sessionSecret);
    expect(loadPublishedEntry).toHaveBeenCalledWith('published-entry');
  });
  it.each([
    { turnstileSecret: '' }, { turnstileSiteKey: '' }, { sessionSecret: 'too-short' },
    { turnstileSecret: '1x0000000000000000000000000000000AA' },
    { turnstileSecret: '2x0000000000000000000000000000000AA' },
    { turnstileSecret: '3x0000000000000000000000000000000AA' },
    { turnstileSiteKey: '1x00000000000000000000AA' },
  ])('keeps submission disabled for missing or dummy credentials: %j', async overrides => {
    expect((await getConfiguration(overrides)).body).toEqual({ enabled: false, siteKey: null });
  });
  it('honors the persisted entry write switch', async () => {
    loadPublishedEntry.mockResolvedValue({ published: true, mode: 'disabled' });
    expect((await getConfiguration()).body).toEqual({ enabled: false, siteKey: null });
  });
  it('does not expose configuration for unpublished entries', async () => {
    loadPublishedEntry.mockResolvedValue(null);
    expect((await getConfiguration()).status).toBe(404);
  });
});
