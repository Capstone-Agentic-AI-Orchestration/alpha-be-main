import { GitHubApiError, githubApi, type GitHubApi } from './githubApi.js';
import { getFile, getTree, RepoWorkspaceError } from './githubRepoWorkspace.js';

export type ArchitectureNodeKind = 'web' | 'api' | 'auth' | 'database' | 'jobs' | 'integration' | 'application';

export interface ArchitectureNode {
  id: string;
  label: string;
  kind: ArchitectureNodeKind;
  technology?: string;
}

export interface ArchitectureEdge {
  from: string;
  to: string;
}

export interface RepoArchitecture {
  repository: string;
  branch: string;
  commit: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  truncated: boolean;
}

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_FILES_TO_ANALYZE = 12;
const MAX_FILE_SIZE = 80_000;
const MAX_TREE_ENTRIES = 20_000;

const FRAMEWORKS: Array<[RegExp, string]> = [
  [/\bnext\b/, 'Next.js'],
  [/\b(?:react|react-dom)\b/, 'React'],
  [/\bvue\b/, 'Vue'],
  [/\b@sveltejs\/kit|\bsvelte\b/, 'Svelte'],
  [/\bexpress\b/, 'Express'],
  [/\b@nestjs\/core|\bnestjs\b/, 'NestJS'],
  [/\bfastify\b/, 'Fastify'],
  [/\bkoa\b/, 'Koa'],
  [/\bhono\b/, 'Hono'],
  [/\bfastapi\b/, 'FastAPI'],
  [/\bflask\b/, 'Flask'],
  [/\bdjango\b/, 'Django'],
  [/\bspring-boot|springframework\b/, 'Spring Boot'],
  [/\bgin-gonic\/gin\b/, 'Go'],
];

const AUTH_PROVIDERS: Array<[RegExp, string]> = [
  [/\b@supabase\/supabase-js\b|\bsupabase\b/, 'Supabase Auth'],
  [/\bnext-auth\b|\bauth\.js\b/, 'Auth.js'],
  [/\bbetter-auth\b/, 'Better Auth'],
  [/\b@clerk\/|\bclerk\b/, 'Clerk'],
  [/\bpassport\b/, 'Passport'],
  [/\bfirebase-admin|\bfirebase\/auth\b/, 'Firebase Auth'],
  [/\bauth0\b/, 'Auth0'],
  [/\boauth\b|\bopenid-client\b/, 'OAuth'],
];

const DATABASES: Array<[RegExp, string]> = [
  [/\bpostgresql?\b|\bpg\b|\bpostgres-js\b|provider\s*=\s*["']postgresql["']/, 'PostgreSQL'],
  [/\bmysql2?\b|\bmariadb\b|provider\s*=\s*["']mysql["']/, 'MySQL'],
  [/\bmongodb\b|\bmongoose\b|provider\s*=\s*["']mongodb["']/, 'MongoDB'],
  [/\bsqlite\b|better-sqlite3|provider\s*=\s*["']sqlite["']/, 'SQLite'],
  [/\bredis\b|ioredis\b/, 'Redis'],
  [/\bdrizzle-orm\b/, 'Database'],
  [/\bprisma\b|@prisma\/client/, 'Database'],
  [/\bsqlalchemy\b/, 'Database'],
];

const JOB_QUEUES: Array<[RegExp, string]> = [
  [/\bbullmq\b|\bbull\b/, 'BullMQ'],
  [/\bcelery\b/, 'Celery'],
  [/\bsidekiq\b/, 'Sidekiq'],
  [/\bapscheduler\b|\bcron\b/, 'Scheduled jobs'],
  [/\bagenda\b/, 'Agenda'],
  [/\btemporalio\b|\btemporal\b/, 'Temporal'],
];

const INTEGRATIONS: Array<[RegExp, string]> = [
  [/@octokit\/|\boctokit\b|@actions\/github|github-api\.ts/, 'GitHub API'],
  [/\bstripe\b/, 'Stripe API'],
  [/@aws-sdk\/|\baws-sdk\b/, 'AWS services'],
  [/\bslack-web-api\b|@slack\//, 'Slack API'],
  [/\bsendgrid\b|\bresend\b/, 'Email API'],
  [/\btwilio\b/, 'Twilio API'],
  [/\bgoogleapis\b/, 'Google APIs'],
  [/\bopenai\b|\banthropic\b/, 'AI API'],
];

function readRepositoryFiles(files: string[]): string[] {
  const rootFirst = (a: string, b: string) => {
    const depth = (path: string) => path.split('/').length;
    return depth(a) - depth(b) || a.localeCompare(b);
  };
  const eligible = files.filter(path => {
    const name = path.split('/').pop()?.toLowerCase() ?? '';
    return name === 'readme.md' || name === 'package.json' || name === 'pyproject.toml' ||
      name === 'requirements.txt' || name === 'go.mod' || name === 'cargo.toml' ||
      name === 'composer.json' || name === 'pom.xml' || name === 'docker-compose.yml' ||
      name === 'schema.prisma' || name === 'drizzle.config.ts';
  }).sort(rootFirst);
  return eligible.slice(0, MAX_FILES_TO_ANALYZE);
}

function dependencyNames(fileContents: Map<string, string>): string[] {
  const names = new Set<string>();
  for (const [path, content] of fileContents) {
    if (path.toLowerCase().endsWith('package.json')) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const values = parsed[section];
          if (values && typeof values === 'object') {
            Object.keys(values).forEach(name => names.add(name.toLowerCase()));
          }
        }
      } catch {
        // A malformed package manifest should not make the whole repo unreadable.
      }
    }
    if (path.toLowerCase().endsWith('requirements.txt')) {
      content.split(/\r?\n/).forEach(line => {
        const name = line.trim().split(/[<=>[;\s]/, 1)[0];
        if (name && !name.startsWith('#')) names.add(name.toLowerCase());
      });
    }
    if (path.toLowerCase().endsWith('cargo.toml')) {
      for (const match of content.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)) names.add(match[1]!.toLowerCase());
    }
    if (path.toLowerCase().endsWith('go.mod')) {
      content.split(/\r?\n/).forEach(line => {
        const match = /^\s*([^\s]+)\s+v\d/.exec(line);
        if (match) names.add(match[1]!.toLowerCase());
      });
    }
  }
  return [...names];
}

function technologyFor(names: string[], patterns: Array<[RegExp, string]>): string | undefined {
  const joined = names.join('\n');
  return patterns.find(([pattern]) => pattern.test(joined))?.[1];
}

function hasWebPath(paths: string[]): boolean {
  const directories = /(?:^|\/)(?:frontend|client|web|ui)(?:\/|$)/;
  const pageComponents = /(?:^|\/)(?:pages|components)\/.*\.(?:tsx|jsx|vue|svelte)$/;
  return paths.some(path => directories.test(path) || pageComponents.test(path));
}

function hasServerPath(paths: string[]): boolean {
  return paths.some(path => /(?:^|\/)(?:api|server|backend|controllers|routes|handlers)(?:\/|$)/.test(path));
}

function fallbackTechnology(paths: string[]): string | undefined {
  if (paths.some(path => path.endsWith('.py'))) return 'Python';
  if (paths.some(path => path.endsWith('.go'))) return 'Go';
  if (paths.some(path => /\.(?:ts|tsx|js|jsx)$/.test(path))) return 'JavaScript / TypeScript';
  return undefined;
}

function applicationNodes(paths: string[], names: string[]): ArchitectureNode[] {
  const nodes: ArchitectureNode[] = [];
  const clientTechnology = technologyFor(names, FRAMEWORKS.slice(0, 4));
  const apiTechnology = technologyFor(names, FRAMEWORKS.slice(4));

  if (clientTechnology || hasWebPath(paths)) {
    nodes.push({ id: 'web', label: 'Web client', kind: 'web', ...(clientTechnology ? { technology: clientTechnology } : {}) });
  }
  if (apiTechnology || hasServerPath(paths)) {
    nodes.push({ id: 'api', label: 'API server', kind: 'api', ...(apiTechnology ? { technology: apiTechnology } : {}) });
  }
  if (!nodes.length) {
    const language = fallbackTechnology(paths);
    nodes.push({ id: 'application', label: 'Application', kind: 'application', ...(language ? { technology: language } : {}) });
  }
  return nodes;
}

function authNode(paths: string[], names: string[]): ArchitectureNode | undefined {
  const technology = technologyFor(names, AUTH_PROVIDERS);
  const hasAuthFiles = paths.some(path => /(?:^|\/)(?:auth|authentication|oauth)(?:\/|\.|$)/.test(path));
  if (!technology && !hasAuthFiles) return undefined;
  return { id: 'auth', label: 'Auth', kind: 'auth', ...(technology ? { technology } : {}) };
}

function databaseNode(paths: string[], names: string[], contentByPath: Map<string, string>): ArchitectureNode | undefined {
  const databaseConfig = [...contentByPath]
    .filter(([path]) => /(?:schema\.prisma|docker-compose|drizzle\.config)/i.test(path))
    .map(([, content]) => content)
    .join('\n');
  let technology = technologyFor([...names, databaseConfig], DATABASES);
  const hasDatabasePaths = /(?:(?:^|\/)(?:migrations?|prisma|drizzle)(?:\/|$)|schema\.sql$)/.test(paths.join('\n'));
  if (!technology && hasDatabasePaths) technology = 'Database';
  return technology ? { id: 'database', label: technology, kind: 'database' } : undefined;
}

function jobsNode(paths: string[], names: string[]): ArchitectureNode | undefined {
  const technology = technologyFor(names, JOB_QUEUES);
  const hasJobsFiles = paths.some(path => /(?:^|\/)(?:jobs?|workers?|queues?|cron)(?:\/|\.|$)/.test(path));
  if (!technology && !hasJobsFiles) return undefined;
  return { id: 'jobs', label: 'Background jobs', kind: 'jobs', ...(technology ? { technology } : {}) };
}

function integrationNodes(signals: string): ArchitectureNode[] {
  return INTEGRATIONS
    .filter(([pattern]) => pattern.test(signals))
    .slice(0, 2)
    .map(([, label], index): ArchitectureNode => ({ id: `integration-${index + 1}`, label, kind: 'integration' }));
}

function architectureEdges(nodes: ArchitectureNode[], integrations: ArchitectureNode[]): ArchitectureEdge[] {
  const edges: ArchitectureEdge[] = [];
  const app = nodes.find(node => node.kind === 'api') ?? nodes.find(node => node.kind === 'web') ?? nodes[0]!;
  for (const target of nodes.filter(node => ['auth', 'database', 'jobs'].includes(node.kind))) {
    edges.push({ from: app.id, to: target.id });
  }
  const integrationSource = nodes.find(node => node.kind === 'jobs') ?? nodes.find(node => node.kind === 'api') ?? app;
  for (const target of integrations) edges.push({ from: integrationSource.id, to: target.id });
  return edges;
}

function limitArchitecture(nodes: ArchitectureNode[], edges: ArchitectureEdge[]): Pick<RepoArchitecture, 'nodes' | 'edges'> {
  if (nodes.length <= 8) return { nodes, edges };
  const kept = nodes.slice(0, 8);
  const ids = new Set(kept.map(node => node.id));
  return { nodes: kept, edges: edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
}

function detectArchitecture(files: string[], contentByPath: Map<string, string>): Pick<RepoArchitecture, 'nodes' | 'edges'> {
  const paths = files.map(path => path.toLowerCase());
  const names = dependencyNames(contentByPath);
  const signals = `${names.join('\n')}\n${paths.join('\n')}`;
  const integrations = integrationNodes(signals);
  const nodes = [
    ...applicationNodes(paths, names),
    authNode(paths, names),
    databaseNode(paths, names, contentByPath),
    jobsNode(paths, names),
    ...integrations,
  ].filter((node): node is ArchitectureNode => node !== undefined);
  return limitArchitecture(nodes, architectureEdges(nodes, integrations));
}

async function readSelectedFile(
  repo: string,
  path: string,
  commit: string,
  entries: Array<{ path: string; size?: number }>,
  api: GitHubApi,
): Promise<readonly [string, string] | null> {
  const entry = entries.find(item => item.path === path);
  if (entry?.size !== undefined && entry.size > MAX_FILE_SIZE) return null;
  try {
    const file = await getFile(repo, path, commit, api);
    return file.content === null ? null : [path, file.content];
  } catch (error) {
    // Optional manifests can disappear from an unusual GitHub tree response.
    // Auth, rate-limit and network failures still reach the caller.
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

async function readSelectedFiles(
  repo: string,
  selected: string[],
  entries: Array<{ path: string; size?: number }>,
  commit: string,
  api: GitHubApi,
): Promise<Map<string, string>> {
  const rows = await Promise.all(selected.map(path => readSelectedFile(repo, path, commit, entries, api)));
  return new Map(rows.filter((row): row is readonly [string, string] => row !== null));
}

async function currentBranchCommit(repo: string, api: GitHubApi): Promise<{ branch: string; commit: string }> {
  const metadata = await api.get<{ default_branch?: string }>(`/repos/${repo}`);
  const branch = metadata.default_branch;
  if (!branch) throw new RepoWorkspaceError('GitHub did not return a default branch for this repository.', 502);

  const reference = await api.get<{ object?: { sha?: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const commit = reference.object?.sha;
  if (!commit) throw new RepoWorkspaceError(`GitHub did not return the current commit for ${branch}.`, 502);
  return { branch, commit };
}

/**
 * Build a current-branch architecture view from bounded repository metadata.
 * GitHub reads use Alpha's per-request identity; no repository token or source
 * content leaves this service.
 */
export async function getRepoArchitecture(repo: string, api: GitHubApi = githubApi()): Promise<RepoArchitecture> {
  if (!REPO.test(repo)) throw new RepoWorkspaceError(`Repository must be "owner/name", got "${repo}".`, 400);
  const { branch, commit } = await currentBranchCommit(repo, api);
  const tree = await getTree(repo, commit, api);
  const files = tree.entries.filter(entry => entry.type === 'file').map(entry => entry.path).slice(0, MAX_TREE_ENTRIES);
  const selected = readRepositoryFiles(files);
  const contentByPath = await readSelectedFiles(repo, selected, tree.entries, commit, api);
  const diagram = detectArchitecture(files, contentByPath);

  return {
    repository: repo,
    branch,
    commit,
    ...diagram,
    truncated: tree.truncated || tree.entries.length > MAX_TREE_ENTRIES,
  };
}
