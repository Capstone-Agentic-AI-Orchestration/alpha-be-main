import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Scaffolding a repository with its CI, and a paired frontend/backend project.
 *
 * GitHub and the CI template are faked; cloud mode keeps no working copy, so
 * nothing is cloned or written to disk. Render and Vercel are not mocked --
 * `RENDER_API_KEY`/`VERCEL_TOKEN` are unset in every test run (there is no
 * `.env` in CI, and this suite does not set them), so `hostingService`
 * answers `state: 'unavailable'` without making a single HTTP call. That is
 * also the real behaviour for anyone running this backend without those
 * keys, which is exactly what "the repo is still created" means to test.
 */

type Provisioned = { name: string; files: Array<{ path: string; content: string }> };

async function load(options: { failFor?: string } = {}) {
  process.env.ALPHA_MODE = 'cloud';
  vi.resetModules();
  const provisioned: Provisioned[] = [];
  const deleted: string[] = [];

  vi.doMock('./githubRepoProvisioning.js', () => ({
    provisionRepository: async (input: { org: string; name: string; files: Provisioned['files'] }) => {
      if (input.name === options.failFor) throw new Error(`GitHub refused ${input.name}`);
      provisioned.push({ name: input.name, files: input.files });
      return {
        url: `https://github.com/${input.org}/${input.name}`,
        nameWithOwner: `${input.org}/${input.name}`,
        commitSha: 'sha',
        branches: ['dev', 'uat', 'main'],
        protectedBranches: []
      };
    }
  }));
  vi.doMock('./ciWorkflows.js', () => ({
    buildCiWorkflows: async ({ stack }: { stack: string }) => {
      const target = stack === 'react' || stack === 'nextjs' ? 'vercel' : 'render';
      return {
        files: [{ path: '.github/workflows/ci.yml', content: `# ci for ${stack}\n` }],
        deployTarget: target,
        requiredSecrets: [],
        deployVariable: null,
        source: `alphaorch-workflow@v1:${stack}`
      };
    }
  }));
  vi.doMock('./githubApi.js', () => ({
    githubApi: () => ({
      delete: async (path: string) => {
        deleted.push(path);
      }
    })
  }));

  const service = await import('./repoScaffoldService.js');
  return { service, provisioned, deleted };
}

afterEach(() => {
  delete process.env.ALPHA_MODE;
  vi.doUnmock('./githubRepoProvisioning.js');
  vi.doUnmock('./ciWorkflows.js');
  vi.doUnmock('./githubApi.js');
  vi.resetModules();
});

const base = { projectKey: 'SHOP', org: 'acme' };

describe('a scaffolded repository', () => {
  it('is committed with its CI and a README that says where hosting is set up', async () => {
    const { service, provisioned } = await load();

    const result = await service.createScaffoldedRepository({ ...base, repoName: 'shop-api', stack: 'nestjs' });

    const files = provisioned[0].files;
    expect(files.map(file => file.path)).toContain('.github/workflows/ci.yml');
    const readme = files.find(file => file.path === 'README.md')!.content;
    expect(readme).toContain('## CI/CD');
    expect(readme).toContain('**Render**');
    expect(readme).toContain('is set up automatically by Alpha');
    expect(result).toMatchObject({
      nameWithOwner: 'acme/shop-api',
      deployTarget: 'render',
      requiredSecrets: [],
      deployVariable: null
    });
    expect(result.localPath).toBeUndefined();
  });

  it('runs hosting setup by default and reports it as unavailable with no Render/Vercel keys configured', async () => {
    const { service } = await load();

    const result = await service.createScaffoldedRepository({ ...base, repoName: 'shop-api', stack: 'nestjs' });

    expect(result.hosting).toMatchObject({ repo: 'acme/shop-api', role: 'backend', platform: 'render', state: 'unavailable' });
  });

  it('does not attempt hosting, and says so in the README, when deploy: false', async () => {
    const { service, provisioned } = await load();

    const result = await service.createScaffoldedRepository({ ...base, repoName: 'shop-api', stack: 'nodejs', deploy: false });

    const readme = provisioned[0].files.find(file => file.path === 'README.md')!.content;
    expect(readme).toContain('was not set up for this repository');
    expect(result.hosting).toBeUndefined();
    // The CI's own shape is unaffected by `deploy` now -- there is no deploy
    // job left in it to gate either way.
    expect(result).toMatchObject({ deployTarget: 'render', requiredSecrets: [], deployVariable: null });
  });
});

describe('a paired project', () => {
  it('creates <name>-be then <name>-fe, each with its own pipeline', async () => {
    const { service, provisioned } = await load();

    const repos = await service.createPairedProject({
      ...base,
      repoName: 'shop',
      frontendStack: 'react',
      backendStack: 'nestjs'
    });

    expect(provisioned.map(repo => repo.name)).toEqual(['shop-be', 'shop-fe']);
    expect(repos.map(repo => [repo.nameWithOwner, repo.deployTarget])).toEqual([
      ['acme/shop-be', 'render'],
      ['acme/shop-fe', 'vercel']
    ]);
    // Neither side has real credentials in this test environment, but both
    // still get a hosting answer -- and the frontend already knows its pair.
    expect(repos[0].hosting).toMatchObject({ state: 'unavailable', partner: null });
    expect(repos[1].hosting).toMatchObject({ state: 'unavailable', partner: 'acme/shop-be' });
  });

  it('deletes the backend again when the frontend cannot be created', async () => {
    const { service, deleted } = await load({ failFor: 'shop-fe' });

    await expect(
      service.createPairedProject({ ...base, repoName: 'shop', frontendStack: 'nextjs', backendStack: 'nodejs' })
    ).rejects.toThrow(/GitHub refused shop-fe/);
    expect(deleted).toEqual(['/repos/acme/shop-be']);
  });

  it('refuses stacks on the wrong side before creating anything', async () => {
    const { service, provisioned } = await load();

    await expect(
      service.createPairedProject({ ...base, repoName: 'shop', frontendStack: 'nestjs', backendStack: 'nodejs' })
    ).rejects.toThrow(/Invalid frontend stack/);
    await expect(
      service.createPairedProject({ ...base, repoName: 'shop', frontendStack: 'react', backendStack: 'nextjs' })
    ).rejects.toThrow(/Invalid backend stack/);
    expect(provisioned).toEqual([]);
  });
});
