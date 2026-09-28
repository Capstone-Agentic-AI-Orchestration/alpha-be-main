import { describe, expect, it, vi } from 'vitest';

import { isDeployReady, previewsFor } from './hostingPreviews.js';
import type { HostingStatus } from './hostingService.js';

/** What each branch can show: decided before anything is framed, and without waking a backend. */

function status(role: 'frontend' | 'backend', environments: HostingStatus['environments']): HostingStatus {
  return {
    repo: 'example-org/shop',
    role,
    platform: role === 'backend' ? 'render' : 'vercel',
    configured: true,
    state: 'ready',
    environments,
    envVars: [],
    github: { secrets: [], variables: [] }
  };
}

const env = (branch: 'main' | 'uat' | 'dev', url: string | null, deployStatus: string | null) => ({
  branch,
  url,
  dashboardUrl: null,
  latestDeploy: deployStatus ? { status: deployStatus, createdAt: null, url: null } : null
});

describe('previews', () => {
  it('asks the embed probe about a live frontend branch, and passes its verdict on', async () => {
    const probe = { check: vi.fn(async () => ({ embeddable: true, reason: null })) };

    const result = await previewsFor(status('frontend', [env('main', 'https://shop.vercel.app', 'READY')]), probe);

    expect(probe.check).toHaveBeenCalledWith('https://shop.vercel.app');
    expect(result.previews).toEqual([
      { branch: 'main', url: 'https://shop.vercel.app', surface: 'page', deployStatus: 'READY', ready: true, embeddable: true, reason: null }
    ]);
  });

  it('never frames a branch that is not live yet, or has no stable address', async () => {
    const probe = { check: vi.fn() };

    const result = await previewsFor(
      status('frontend', [env('uat', 'https://shop-git-uat.vercel.app', 'BUILDING'), env('dev', null, null)]),
      probe
    );

    expect(probe.check).not.toHaveBeenCalled();
    expect(result.previews.map(p => [p.branch, p.embeddable, p.reason])).toEqual([
      ['uat', null, 'The latest deploy is not live yet.'],
      ['dev', false, 'This branch has no stable address yet.']
    ]);
  });

  /** Probing would wake a sleeping free-tier service just because the panel opened. */
  it('offers a backend’s health instead of a page, without touching it', async () => {
    const probe = { check: vi.fn() };

    const result = await previewsFor(status('backend', [env('main', 'https://shop-be.onrender.com', 'live')]), probe);

    expect(probe.check).not.toHaveBeenCalled();
    expect(result.previews[0]).toMatchObject({ surface: 'health', ready: true, embeddable: false });
  });

  it('reads both platforms’ words for a live deploy', () => {
    expect(['READY', 'live'].map(isDeployReady)).toEqual([true, true]);
    expect(['BUILDING', 'build_failed', null].map(isDeployReady)).toEqual([false, false, false]);
  });
});
