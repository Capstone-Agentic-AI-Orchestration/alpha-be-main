import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The create-repository panel warns a plain member that the org may stop them.
 * It warned every member, even in orgs that let members create repositories, and
 * the warning was then read as the reason an unrelated creation had failed. The
 * org list now says what the org's rule actually is, when GitHub shows it.
 */
describe('an organization\'s rule for members creating repositories', () => {
  const asked: string[] = [];
  async function load(answer: (path: string) => unknown) {
    vi.resetModules();
    asked.length = 0;
    vi.doMock('./githubApi.js', async importOriginal => ({
      ...(await importOriginal<typeof import('./githubApi.js')>()),
      githubApi: () => ({ get: async (path: string) => { asked.push(path); return answer(path); } }),
    }));
    return (await import('./githubService.js')).withMemberRepoPolicy;
  }
  afterEach(() => { vi.doUnmock('./githubApi.js'); });

  it('reads the rule for a member, allowed or not', async () => {
    const allowed = await load(() => ({ members_can_create_repositories: true }));
    expect(await allowed({ login: 'acme', role: 'member' })).toEqual({ login: 'acme', role: 'member', membersCanCreateRepositories: true });
    const blocked = await load(() => ({ members_can_create_repositories: false }));
    expect(await blocked({ login: 'acme', role: 'member' })).toEqual({ login: 'acme', role: 'member', membersCanCreateRepositories: false });
    expect(asked).toEqual(['/orgs/acme']);
  });

  it('does not ask about orgs the person owns', async () => {
    const policy = await load(() => ({ members_can_create_repositories: false }));
    expect(await policy({ login: 'acme', role: 'admin' })).toEqual({ login: 'acme', role: 'admin' });
    expect(asked).toEqual([]);
  });

  it('leaves the rule unknown when GitHub hides it or the lookup fails', async () => {
    const hidden = await load(() => ({ login: 'acme' }));
    expect(await hidden({ login: 'acme', role: 'member' })).toEqual({ login: 'acme', role: 'member' });
    const failing = await load(() => { throw new Error('GitHub 404'); });
    expect(await failing({ login: 'acme', role: 'member' })).toEqual({ login: 'acme', role: 'member' });
  });
});
