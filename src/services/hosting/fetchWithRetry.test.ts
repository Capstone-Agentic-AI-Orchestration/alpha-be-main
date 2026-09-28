import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from './fetchWithRetry.js';

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the response immediately on success', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('https://example.test/logs');
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    vi.spyOn(global, 'setTimeout').mockImplementation((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    });

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: {
          get: (name: string) => (name === 'retry-after' ? '0' : null),
        },
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('https://example.test/logs');
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up and returns the last 429 response after the max attempts', async () => {
    vi.spyOn(global, 'setTimeout').mockImplementation((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === 'retry-after' ? '0' : null) },
    });

    const response = await fetchWithRetry('https://example.test/logs');
    expect(response.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-429 failures', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
    });

    const response = await fetchWithRetry('https://example.test/logs');
    expect(response.status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
