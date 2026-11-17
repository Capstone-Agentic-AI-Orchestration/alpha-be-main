import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isolatedGitEnv, withIsolatedRepository } from './isolatedGit.js';
import { githubAuthConfig } from './githubService.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.invalid', ...args
], { cwd, stdio: 'pipe' }).toString().trim();

/**
 * Token-bearing git commands used to run inside the project checkout, whose config an agent
 * can write through its working copy. These tests plant that config and check that none of
 * it reaches the isolated repository the token is used in.
 */
describe('isolated git for token-bearing commands', () => {
  let directory = '';
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  function hostileCheckout() {
    directory = fs.mkdtempSync(path.join(process.cwd(), '.tmp-isolated-git-'));
    const origin = path.join(directory, 'origin.git');
    const checkout = path.join(directory, 'project');
    git(directory, 'init', '--bare', '--initial-branch=main', origin);
    fs.mkdirSync(checkout);
    git(checkout, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(checkout, 'README.md'), 'work\n');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-m', 'accepted work');
    // What an agent could write into the shared .git/config from its working copy.
    git(checkout, 'config', 'http.https://github.com/.sslVerify', 'false');
    git(checkout, 'config', 'http.proxy', 'http://127.0.0.1:9');
    git(checkout, 'config', 'http.sslCAInfo', path.join(directory, 'attacker-ca.pem'));
    git(checkout, 'config', 'url.https://attacker.invalid/.insteadOf', 'https://github.com/');
    git(checkout, 'config', 'core.hooksPath', path.join(directory, 'hooks'));
    return { origin, checkout, commit: git(checkout, 'rev-parse', 'HEAD') };
  }

  it('reads none of the checkout config and forces TLS verification for github.com', async () => {
    const { checkout } = hostileCheckout();
    // Control: run in the checkout itself, the planted config wins even over a generic override.
    expect(git(checkout, '-c', 'http.sslVerify=true', 'config', '--get-urlmatch', 'http.sslVerify', 'https://github.com/')).toBe('false');
    const config = githubAuthConfig('test-token');
    await withIsolatedRepository(checkout, config, async run => {
      const get = (...args: string[]) => run(['config', ...args]).then(out => out.trim(), () => null);
      expect(await get('--get-urlmatch', 'http.sslVerify', 'https://github.com/')).toBe('true');
      expect(await get('--get', 'http.proxy')).toBeNull();
      // Unset on Linux; on Windows the system config supplies Git's own CA bundle.
      expect((await get('--get', 'http.sslCAInfo')) ?? '').not.toContain('attacker-ca');
      expect(await get('--get-regexp', '^url\\.')).toBeNull();
      expect(await get('--get', 'core.hooksPath')).toBeNull();
    });
  });

  it('pushes the checkout commits through borrowed objects, then cleans up', async () => {
    const { origin, checkout, commit } = hostileCheckout();
    let repositoryDir = '';
    await withIsolatedRepository(checkout, [], async (run, dir) => {
      repositoryDir = dir;
      await run(['push', '--no-verify', origin, `+${commit}:refs/alpha-checkpoints/build`]);
    });
    expect(git(origin, 'rev-parse', 'refs/alpha-checkpoints/build')).toBe(commit);
    expect(fs.existsSync(repositoryDir)).toBe(false);
  });

  it('fetches into the isolated repository, then hands the commits to the checkout without the token', async () => {
    const { origin, checkout, commit } = hostileCheckout();
    git(checkout, 'push', origin, `${commit}:refs/alpha-checkpoints/build`);
    const fresh = path.join(directory, 'fresh');
    git(directory, 'init', '--initial-branch=main', fresh);
    await withIsolatedRepository(fresh, [], async (run, dir) => {
      await run(['fetch', '--no-tags', origin, '+refs/alpha-checkpoints/build:refs/alpha-checkpoints/build']);
      git(fresh, 'fetch', '--no-tags', dir, '+refs/alpha-checkpoints/build:refs/alpha-checkpoints/build');
    });
    expect(git(fresh, 'rev-parse', 'refs/alpha-checkpoints/build')).toBe(commit);
  });

  it('drops inherited variables that redirect git or turn TLS off', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { GIT_SSL_NO_VERIFY: '', GIT_DIR: '/elsewhere', GIT_CONFIG_PARAMETERS: "'http.sslverify'='false'",
        GIT_CONFIG_KEY_5: 'http.proxy' });
      const env = isolatedGitEnv('/alpha/empty.gitconfig', githubAuthConfig('test-token'));
      expect(env).not.toHaveProperty('GIT_SSL_NO_VERIFY');
      expect(env).not.toHaveProperty('GIT_DIR');
      expect(env).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
      expect(env).not.toHaveProperty('GIT_CONFIG_KEY_5');
      expect(env.GIT_CONFIG_GLOBAL).toBe('/alpha/empty.gitconfig');
      expect(env.GIT_CONFIG_COUNT).toBe('3');
      expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    } finally {
      process.env = saved;
    }
  });
});
