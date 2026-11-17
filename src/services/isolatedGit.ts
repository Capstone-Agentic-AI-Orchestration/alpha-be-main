import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Inherited variables that would point git somewhere else or weaken TLS. The daemon's own
 * environment is trusted, but none of these belong in a command that carries a token.
 * GIT_SSL_NO_VERIFY in particular turns verification off when merely present, even empty.
 */
const INHERITED_GIT_OVERRIDES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL', 'GIT_SSL_NO_VERIFY', 'GIT_PROXY_COMMAND', 'GIT_SSH_COMMAND', 'GIT_ASKPASS',
  'GIT_TEMPLATE_DIR', 'GIT_EXEC_PATH'
];

/** Environment for a git command run in an isolated repository, with `config` injected above every config file. */
export function isolatedGitEnv(globalConfigFile: string, config: Array<[string, string]>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (INHERITED_GIT_OVERRIDES.includes(key.toUpperCase()) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/i.test(key)) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  // The user-level config is as reachable to an agent as the repository's; only the
  // system config (administrator-owned, and where Git for Windows keeps its CA bundle) stays.
  env.GIT_CONFIG_GLOBAL = globalConfigFile;
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export type IsolatedGit = (args: string[]) => Promise<string>;

/**
 * Run token-bearing git commands against `sourceRepoDir`'s commits without trusting any
 * of its configuration.
 *
 * An agent's working copy shares the project checkout's git config, so anything an agent
 * can write there (a proxy, a CA, TLS off, a URL rewrite, a hooks path) would apply to a
 * command run in either. Instead, each call gets a fresh bare repository that Alpha owns:
 * it borrows the source's objects through `objects/info/alternates`, has no hooks, and
 * reads no user-level config. It is deleted afterwards.
 */
export async function withIsolatedRepository<T>(
  sourceRepoDir: string,
  config: Array<[string, string]>,
  use: (git: IsolatedGit, repositoryDir: string) => Promise<T>
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-git-'));
  try {
    const repositoryDir = path.join(root, 'repository.git');
    const globalConfigFile = path.join(root, 'empty.gitconfig');
    fs.writeFileSync(globalConfigFile, '');
    // Only a location is read from the source, never with the token in the environment.
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: sourceRepoDir, env: isolatedGitEnv(globalConfigFile, []), windowsHide: true
    });
    const objects = path.join(path.resolve(sourceRepoDir, stdout.trim()), 'objects');
    if (!fs.existsSync(objects)) throw new Error(`${sourceRepoDir} has no git object store.`);
    const env = isolatedGitEnv(globalConfigFile, config);
    await execFileAsync('git', ['init', '--bare', '--quiet', repositoryDir], { cwd: root, env: isolatedGitEnv(globalConfigFile, []), windowsHide: true });
    fs.writeFileSync(path.join(repositoryDir, 'objects', 'info', 'alternates'), `${objects.replace(/\\/g, '/')}\n`);
    const git: IsolatedGit = async args => (await execFileAsync('git', ['--git-dir', repositoryDir, ...args], {
      cwd: root, env, timeout: 180_000, windowsHide: true, maxBuffer: 1024 * 1024
    })).stdout;
    return await use(git, repositoryDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
