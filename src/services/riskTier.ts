import { pathMatchesScope } from '../utils/pathScope.js';
import { sameRepository } from '../utils/repositoryName.js';

/**
 * How risky it is for Alpha to resolve a stuck task on its own, decided in code from paths and
 * diff facts, never by the model grading itself (BLOCKER_RESOLUTION_PLAN "Risk tiers").
 *
 * 0 mechanical: the Orchestrator may fix it.
 * 1 structural: it touches work an earlier task delivered; the Orchestrator may fix it, flagged.
 * 2 sensitive: security, data, money, privacy, dependencies or licences, secrets or env, CI or
 *   build config, deployment or hosting config, or weakened tests. The person decides.
 * 3 product: what is being built. Only the Orchestrator's `needs_owner` answer reaches it, and the
 *   person decides; paths cannot tell scope apart, so this classifier never returns it.
 */
export type RiskTier = 0 | 1 | 2 | 3;

export type SensitiveCategory =
  | 'security' | 'data' | 'money' | 'privacy' | 'dependencies' | 'secrets' | 'ci_build' | 'deployment'
  | 'tests_weakened' | 'project_pattern';

export interface RiskReason {
  tier: RiskTier;
  category: SensitiveCategory | 'accepted_work';
  source: 'path' | 'text' | 'diff';
  repository?: string;
  path?: string;
  detail: string;
}

export interface RepositoryPath { repository: string; path: string }

export interface RiskInput {
  /** The blocked task's changed files and the files a proposed fix names. */
  paths: readonly RepositoryPath[];
  /** Files earlier accepted tasks delivered; touching one is structural (tier 1). */
  acceptedPaths?: readonly RepositoryPath[];
  /** The blocker text, the failing check, findings and the proposed instructions. */
  texts?: readonly string[];
  /** Test files the task's diff weakened (testWeakening), whatever happened before: always tier 2. */
  weakenedTests?: ReadonlyArray<RepositoryPath & { detail: string }>;
  /** Extra sensitive path globs a project added to the defaults. */
  projectPatterns?: readonly string[];
}

export interface RiskClassification {
  tier: RiskTier;
  reasons: RiskReason[];
  /** Every classified path with its tier, for the record shown at approval. */
  classifiedPaths: Array<RepositoryPath & { tier: RiskTier; categories: string[] }>;
}

type PathCategory = Exclude<SensitiveCategory, 'tests_weakened' | 'project_pattern'>;

const PATH_CATEGORIES: readonly PathCategory[] = ['security', 'data', 'money', 'privacy', 'dependencies', 'secrets', 'ci_build', 'deployment'];

/** Name parts that mark a sensitive area: `src/authController.ts` has `auth`, `author.ts` does not. */
const SENSITIVE_TOKENS: Partial<Record<PathCategory, ReadonlySet<string>>> = {
  security: new Set(['auth', 'authn', 'authz', 'authenticate', 'authentication', 'authorize', 'authorization', 'session', 'sessions',
    'login', 'logout', 'signin', 'signup', 'oauth', 'oidc', 'saml', 'sso', 'jwt', 'crypto', 'encrypt', 'encryption', 'decrypt',
    'password', 'passwords', 'permission', 'permissions', 'rbac', 'acl', 'csrf', 'security']),
  data: new Set(['migration', 'migrations', 'migrate', 'schema', 'schemas', 'prisma', 'alembic', 'knexfile', 'drizzle']),
  money: new Set(['payment', 'payments', 'billing', 'invoice', 'invoices', 'checkout', 'stripe', 'paypal', 'braintree',
    'subscription', 'subscriptions', 'pricing', 'refund', 'refunds', 'payout', 'payouts', 'wallet', 'ledger']),
  privacy: new Set(['pii', 'gdpr', 'ccpa', 'privacy', 'consent', 'personal']),
  secrets: new Set(['secret', 'secrets', 'credential', 'credentials', 'env', 'dotenv', 'keystore', 'vault']),
  deployment: new Set(['k8s', 'kubernetes', 'helm', 'terraform', 'deploy', 'deployment', 'deployments', 'infra', 'charts'])
};

// --- Sensitive paths -------------------------------------------------------------------------
// Matched against the file name in lower case. Exact names first, then short patterns for name
// families (versioned configs, `.env.*`, key files).

const DEPENDENCY_FILES = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'bun.lock', 'bun.lockb', 'pyproject.toml', 'poetry.lock', 'pipfile', 'pipfile.lock', 'go.mod', 'go.sum',
  'cargo.toml', 'cargo.lock', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock', 'pom.xml',
  'build.gradle', 'build.gradle.kts', '.npmrc', '.yarnrc', '.yarnrc.yml', 'copying'
];
const DEPENDENCY_NAME_PATTERNS = [
  /^requirements[\w.-]*\.txt$/, // requirements.txt, requirements-dev.txt
  /^licen[cs]e(\.\w+)?$/, // LICENSE, LICENCE.md
  /^notice(\.\w+)?$/
];

const SECRET_NAME_PATTERNS = [
  /^\.env(\..*)?$/, // .env, .env.production
  /\.(pem|key|p12|pfx|jks)$/ // keys and certificate stores
];

const CI_BUILD_FILES = [
  '.gitlab-ci.yml', 'jenkinsfile', 'azure-pipelines.yml', 'azure-pipelines.yaml', 'bitbucket-pipelines.yml',
  '.eslintignore', 'makefile', 'turbo.json', 'nx.json', '.nvmrc', '.node-version'
];
const CI_BUILD_NAME_PATTERNS = [
  /^[tj]sconfig(\.[\w-]+)?\.json$/, // tsconfig.json, tsconfig.build.json, jsconfig.json
  /^(vite|vitest|jest|webpack|rollup|babel)\.config\.[cm]?[jt]s$/,
  /^(next|nuxt|svelte|astro|playwright|cypress)\.config\.[cm]?[jt]s$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^prettier\.config\.[cm]?[jt]s$/,
  /^\.babelrc(\.\w+)?$/,
  /^\.eslintrc(\.\w+)?$/,
  /^\.prettierrc(\.\w+)?$/
];
const CI_BUILD_DIRECTORIES = ['.github/', '.circleci/', '.husky/', '.buildkite/'];

const DEPLOYMENT_FILES = [
  '.dockerignore', 'compose.yml', 'compose.yaml', 'procfile', 'vercel.json', 'netlify.toml', 'render.yml', 'render.yaml',
  'fly.toml', 'app.yaml', 'serverless.yml', 'serverless.yaml', 'wrangler.toml', 'nginx.conf'
];
const DEPLOYMENT_NAME_PATTERNS = [
  /^dockerfile(\..*)?$/, // Dockerfile, Dockerfile.dev
  /^docker-compose(\.[\w-]+)?\.ya?ml$/, // docker-compose.yml, docker-compose.prod.yaml
  /\.tf$/, // Terraform
  /\.tfvars?$/
];
const DEPLOYMENT_DIRECTORIES = ['.platform/'];

const DATA_NAME_PATTERNS = [/\.sql$/];

interface PathRule {
  files?: readonly string[];
  namePatterns?: readonly RegExp[];
  directories?: readonly string[];
}

/** Whole-file rules per category, on top of the name parts in SENSITIVE_TOKENS. */
const SENSITIVE_PATH_RULES: Partial<Record<PathCategory, PathRule>> = {
  data: { namePatterns: DATA_NAME_PATTERNS },
  dependencies: { files: DEPENDENCY_FILES, namePatterns: DEPENDENCY_NAME_PATTERNS },
  secrets: { namePatterns: SECRET_NAME_PATTERNS },
  ci_build: { files: CI_BUILD_FILES, namePatterns: CI_BUILD_NAME_PATTERNS, directories: CI_BUILD_DIRECTORIES },
  deployment: { files: DEPLOYMENT_FILES, namePatterns: DEPLOYMENT_NAME_PATTERNS, directories: DEPLOYMENT_DIRECTORIES }
};

function matchesPathRule(rule: PathRule | undefined, lowerPath: string, name: string): boolean {
  if (!rule) return false;
  return (rule.files?.includes(name) ?? false) ||
    (rule.namePatterns?.some(pattern => pattern.test(name)) ?? false) ||
    (rule.directories?.some(directory => lowerPath.startsWith(directory)) ?? false);
}

// --- Sensitive text --------------------------------------------------------------------------
// Words in the blocker, the failing check or a proposed fix that mark a sensitive decision.

/**
 * A request phrased as a verb, up to a few filler words, then an object: "skip the failing test",
 * "add a new npm package", "relax the lint rules". Verbs and objects may be two words.
 */
interface PhraseRule {
  verbs: readonly string[];
  fillers: readonly string[];
  maxFillers: number;
  objects: readonly string[];
}

const WEAKEN_TESTS: PhraseRule = {
  verbs: [
    'skip', 'skips', 'skipped', 'skipping', 'remove', 'removes', 'removed', 'removing',
    'delete', 'deletes', 'deleted', 'deleting', 'disable', 'disables', 'disabled', 'disabling',
    'comment out', 'comments out', 'commented out', 'commenting out'
  ],
  fillers: ['the', 'a', 'an', 'this', 'that', 'these', 'failing', 'broken', 'flaky', 'old', 'existing'],
  maxFillers: 3,
  objects: ['test', 'tests', 'assertion', 'assertions', 'spec', 'specs']
};
const LOWER_COVERAGE: PhraseRule = {
  verbs: ['lower', 'lowers', 'lowered', 'lowering'], fillers: ['the'], maxFillers: 1, objects: ['coverage']
};
const CHANGE_DEPENDENCIES: PhraseRule = {
  verbs: [
    'add', 'adds', 'added', 'adding', 'install', 'installs', 'installed', 'installing',
    'upgrade', 'upgrades', 'upgraded', 'upgrading', 'downgrade', 'downgrades', 'downgraded', 'downgrading',
    'remove', 'removes', 'removed', 'removing', 'replace', 'replaces', 'replaced', 'replacing'
  ],
  fillers: ['a', 'an', 'the', 'new', 'npm'],
  maxFillers: 3,
  objects: ['dependency', 'dependencies', 'package', 'library']
};
const LOOSEN_CHECKS: PhraseRule = {
  verbs: [
    'disable', 'disables', 'disabled', 'disabling', 'loosen', 'loosens', 'loosened', 'loosening',
    'relax', 'relaxes', 'relaxed', 'relaxing'
  ],
  fillers: ['the'],
  maxFillers: 1,
  objects: ['lint', 'check', 'checks', 'rule', 'rules', 'typecheck', 'typechecks', 'type check', 'type checks']
};

interface TextRule {
  patterns?: readonly RegExp[];
  phrases?: readonly PhraseRule[];
}

const SENSITIVE_TEXT: Record<Exclude<SensitiveCategory, 'project_pattern'>, TextRule> = {
  security: { patterns: [
    /\bauth(entication|orization|enticate|orize)?\b/i, /\bsessions?\b/i, /\blog[ -]?in\b/i, /\bsign[ -]?in\b/i,
    /\bpasswords?\b/i, /\bcredentials?\b/i, /\b(oauth|jwt|rbac|csrf)\b/i, /\b(en|de)crypt\w*/i, /\bcryptograph\w*/i,
    /\bpermissions?\b/i, /\baccess control\b/i
  ] },
  data: { patterns: [
    /\bmigrations?\b/i, /\bdatabase schema\b/i, /\bschema change\b/i, /\bdrop (table|column|database)\b/i,
    /\btruncate\b/i, /\bdelete (all|every|existing) (rows|records|data|users)\b/i, /\bdata loss\b/i
  ] },
  money: { patterns: [
    /\bpayments?\b/i, /\bbilling\b/i, /\binvoices?\b/i, /\bcheckout\b/i, /\b(stripe|paypal)\b/i, /\brefunds?\b/i,
    /\bpricing\b/i, /\bsubscriptions?\b/i, /\bcharge (the )?(card|customer)\b/i
  ] },
  privacy: { patterns: [/\bpersonal data\b/i, /\bpersonally identifiable\b/i, /\b(pii|gdpr|ccpa)\b/i, /\bprivacy\b/i, /\bconsent\b/i] },
  dependencies: { patterns: [/\bnew dependency\b/i, /\blicen[cs]es?\b/i], phrases: [CHANGE_DEPENDENCIES] },
  secrets: { patterns: [
    /\bsecrets?\b/i, /\bapi[ _-]?keys?\b/i, /\baccess tokens?\b/i, /\bprivate keys?\b/i,
    /\benvironment variables?\b/i, /\benv vars?\b/i, /(^|[\s"'`(])\.env\b/i
  ] },
  ci_build: { patterns: [
    /\bci pipeline\b/i, /\bgithub actions?\b/i, /\bworkflow file\b/i, /\btsconfig\b/i, /\beslint (config|rules?)\b/i,
    /\blint rules?\b/i, /\bbuild config(uration)?\b/i
  ], phrases: [LOOSEN_CHECKS] },
  deployment: { patterns: [
    /\bdeploy(ment|ing|s|ed)?\b/i, /\bhosting\b/i, /\bdocker(file)?\b/i, /\b(kubernetes|helm|terraform)\b/i,
    /\b(vercel|netlify)\b/i, /\bproduction environment\b/i
  ] },
  tests_weakened: { phrases: [WEAKEN_TESTS, LOWER_COVERAGE] }
};

/** The length of the word list at `index` that matches one of `candidates` (one or two words), or 0. */
function wordsAt(words: readonly string[], index: number, candidates: readonly string[]): number {
  for (const candidate of candidates) {
    const parts = candidate.split(' ');
    if (parts.every((part, offset) => words[index + offset] === part)) return parts.length;
  }
  return 0;
}

function matchesPhrase(words: readonly string[], rule: PhraseRule): boolean {
  for (let index = 0; index < words.length; index += 1) {
    const verb = wordsAt(words, index, rule.verbs);
    if (!verb) continue;
    let next = index + verb;
    for (let fillers = 0; fillers < rule.maxFillers && rule.fillers.includes(words[next]); fillers += 1) next += 1;
    if (wordsAt(words, next, rule.objects)) return true;
  }
  return false;
}

function matchesTextRule(text: string, words: readonly string[], rule: TextRule): boolean {
  return (rule.patterns?.some(pattern => pattern.test(text)) ?? false) ||
    (rule.phrases?.some(phrase => matchesPhrase(words, phrase)) ?? false);
}

const CATEGORY_LABELS: Record<SensitiveCategory, string> = {
  security: 'security (auth, sessions, crypto, permissions)',
  data: 'data (migrations, schema, deletes)',
  money: 'money (payments, billing)',
  privacy: 'privacy (personal data)',
  dependencies: 'dependencies or licences',
  secrets: 'secrets or environment',
  ci_build: 'CI or build configuration',
  deployment: 'deployment or hosting configuration',
  tests_weakened: 'removed or weakened tests',
  project_pattern: 'a path this project marked sensitive'
};

export function sensitiveCategoryLabel(category: SensitiveCategory): string {
  return CATEGORY_LABELS[category];
}

/** Lower-case name parts of a path: separators, dots, dashes, underscores and camelCase humps. */
export function pathTokens(filePath: string): string[] {
  return filePath.replace(/\\/g, '/')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[/._\-\s]+/)
    .map(token => token.toLowerCase())
    .filter(Boolean);
}

/** The sensitive categories a repository path falls in, from the defaults and the project's patterns. */
export function sensitivePathCategories(filePath: string, projectPatterns: readonly string[] = []): SensitiveCategory[] {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const lower = normalized.toLowerCase();
  const name = lower.split('/').pop() ?? lower;
  const tokens = new Set(pathTokens(normalized));
  const categories: SensitiveCategory[] = [];
  for (const category of PATH_CATEGORIES) {
    const byToken = [...SENSITIVE_TOKENS[category] ?? []].some(token => tokens.has(token));
    if (byToken || matchesPathRule(SENSITIVE_PATH_RULES[category], lower, name)) categories.push(category);
  }
  if (projectPatterns.some(pattern => pathMatchesScope(normalized, pattern, true))) categories.push('project_pattern');
  return categories;
}

/** The sensitive categories a piece of text names. */
export function sensitiveTextCategories(text: string): SensitiveCategory[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return (Object.keys(SENSITIVE_TEXT) as Array<keyof typeof SENSITIVE_TEXT>)
    .filter(category => matchesTextRule(text, words, SENSITIVE_TEXT[category]));
}

function samePath(a: RepositoryPath, b: RepositoryPath): boolean {
  return sameRepository(a.repository, b.repository) && a.path.replace(/\\/g, '/') === b.path.replace(/\\/g, '/');
}

/** One path's tier and the reasons for it: sensitive areas first, then earlier accepted work. */
function classifyPath(item: RepositoryPath, input: RiskInput): { reasons: RiskReason[]; classified: RiskClassification['classifiedPaths'][number] } {
  const sensitive = sensitivePathCategories(item.path, input.projectPatterns);
  const reasons: RiskReason[] = sensitive.map(category => ({ tier: 2 as const, category, source: 'path' as const,
    repository: item.repository, path: item.path, detail: `${item.path} is ${sensitiveCategoryLabel(category)}` }));
  const accepted = input.acceptedPaths?.some(other => samePath(other, item)) ?? false;
  if (accepted) {
    reasons.push({ tier: 1, category: 'accepted_work', source: 'path', repository: item.repository, path: item.path,
      detail: `${item.path} was delivered by an earlier accepted task` });
  }
  let tier: RiskTier = 0;
  if (sensitive.length) tier = 2;
  else if (accepted) tier = 1;
  return { reasons, classified: { ...item, tier, categories: reasons.map(reason => reason.category) } };
}

/** The sensitive decisions the texts name, once per category. */
function textReasons(texts: readonly string[]): RiskReason[] {
  const categories = new Set(texts.flatMap(text => sensitiveTextCategories(text)));
  return [...categories].map(category => ({ tier: 2 as const, category, source: 'text' as const,
    detail: `The problem or fix mentions ${sensitiveCategoryLabel(category)}` }));
}

export function classifyRisk(input: RiskInput): RiskClassification {
  const reasons: RiskReason[] = [];
  const classifiedPaths: RiskClassification['classifiedPaths'] = [];
  const unique = input.paths.filter((item, index) => input.paths.findIndex(other => samePath(other, item)) === index);
  for (const item of unique) {
    const result = classifyPath(item, input);
    reasons.push(...result.reasons);
    classifiedPaths.push(result.classified);
  }
  for (const weakened of input.weakenedTests ?? []) {
    reasons.push({ tier: 2, category: 'tests_weakened', source: 'diff', repository: weakened.repository, path: weakened.path,
      detail: `${weakened.path}: ${weakened.detail}` });
  }
  reasons.push(...textReasons(input.texts ?? []));
  const tier = reasons.reduce<RiskTier>((highest, reason) => Math.max(highest, reason.tier) as RiskTier, 0);
  return { tier, reasons, classifiedPaths };
}
