import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryRepository } from './orchestrationDelivery.js';
const mocks = vi.hoisted(() => ({ render: vi.fn(), vercel: vi.fn() }));
vi.mock('./hosting/hostingService.js', () => ({ renderClient: mocks.render, vercelClient: mocks.vercel }));
import { verifyDeliveryDeployment } from './orchestrationDeliveryHosting.js';

const sha = 'a'.repeat(40);
const target = { repository: 'acme/shop', uatHead: sha } as DeliveryRepository;
function frontend(overrides: object = {}) {
  return { findProjectByName: vi.fn(async () => ({ id: 'project', link: { org: 'acme', repo: 'shop' } })),
    listDeployments: vi.fn(async () => [{ meta: { githubCommitSha: sha, githubCommitRef: 'uat' }, readyState: 'READY', url: 'shop.vercel.app', ...overrides }]) };
}
beforeEach(() => { mocks.render.mockReturnValue(null); mocks.vercel.mockReturnValue(frontend()); });
describe('UAT provider and smoke evidence', () => {
  it('requires exact provider SHA/branch and performs a bounded HTTPS smoke request', async () => {
    const fetcher = vi.fn(async () => new Response('<html>app</html>', { headers: { 'content-type': 'text/html' } }));
    const result = await verifyDeliveryDeployment(target, fetcher as typeof fetch);
    expect(result).toMatchObject({ sha, status: 'READY', url: 'https://shop.vercel.app/' });
    expect(result.verifiedAt).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith(new URL('https://shop.vercel.app/'), expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });
  it.each([
    { meta: { githubCommitSha: 'b'.repeat(40), githubCommitRef: 'uat' } },
    { meta: { githubCommitSha: sha, githubCommitRef: 'dev' } },
    { readyState: 'ERROR' }
  ])('blocks mismatched or failed deployments: %j', async evidence => {
    mocks.vercel.mockReturnValue(frontend(evidence)); const fetcher = vi.fn();
    await expect(verifyDeliveryDeployment(target, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not claim verification while deployment is building', async () => {
    mocks.vercel.mockReturnValue(frontend({ readyState: 'BUILDING' })); const fetcher = vi.fn();
    expect((await verifyDeliveryDeployment(target, fetcher)).verifiedAt).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('blocks hosting projects linked to another repository', async () => {
    const provider = frontend(); provider.findProjectByName.mockResolvedValue({ id: 'project', link: { org: 'someone', repo: 'else' } });
    mocks.vercel.mockReturnValue(provider);
    await expect(verifyDeliveryDeployment(target, vi.fn())).rejects.toThrow(/different repository/);
  });
  it.each([new Response('', { status: 503 }), new Response('{}', { headers: { 'content-type': 'application/json' } })])('requires successful HTML responses for frontend smoke checks', async response => {
    await expect(verifyDeliveryDeployment(target, vi.fn(async () => response) as typeof fetch)).rejects.toThrow();
  });
  it('checks the matching Render UAT service health endpoint', async () => {
    mocks.render.mockReturnValue({ findServiceByName: vi.fn(async () => ({ id: 'svc', branch: 'uat', repo: 'https://github.com/acme/shop.git',
      serviceDetails: { url: 'https://shop-uat.onrender.com' } })), listDeploys: vi.fn(async () => [{ commit: { id: sha }, status: 'live' }]) });
    expect(await verifyDeliveryDeployment(target, vi.fn(async () => new Response('{}')) as typeof fetch)).toMatchObject({ sha, url: 'https://shop-uat.onrender.com/health' });
  });
});
