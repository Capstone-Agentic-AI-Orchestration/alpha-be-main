import { describe, expect, it, vi } from 'vitest';

import { checkHealth, isCheckableUrl } from './healthCheck.js';

/** A backend's health, on request: only the platforms' own hosts, no redirects followed. */

const answer = (status: number) => vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

describe('checking a backend’s health', () => {
  it('calls /health on the service and reports a 2xx as healthy', async () => {
    const fetchImpl = answer(200);

    const result = await checkHealth('https://shop-be.onrender.com', '/health', fetchImpl);

    expect(result).toMatchObject({ url: 'https://shop-be.onrender.com/health', ok: true, status: 200 });
    expect((fetchImpl as any).mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
  });

  it('reports a redirect or an error status as unhealthy', async () => {
    expect((await checkHealth('https://shop-be.onrender.com', '/health', answer(302))).ok).toBe(false);
    expect((await checkHealth('https://shop-be.onrender.com', '/health', answer(503))).ok).toBe(false);
  });

  it('never requests a host that is not Render or Vercel', async () => {
    const fetchImpl = answer(200);

    const result = await checkHealth('https://internal.example.com', '/health', fetchImpl);

    expect(result).toMatchObject({ ok: false, error: 'Only Render and Vercel addresses are checked.' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isCheckableUrl('http://shop-be.onrender.com/health')).toBe(false);
    expect(isCheckableUrl('https://shop-be.onrender.com.example.com/health')).toBe(false);
  });

  it('says so when the service does not answer in time', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;

    const result = await checkHealth('https://shop-be.onrender.com', '/health', fetchImpl, 75_000);

    expect(result).toMatchObject({ ok: false, status: null, error: 'No answer within 75s.' });
  });
});
