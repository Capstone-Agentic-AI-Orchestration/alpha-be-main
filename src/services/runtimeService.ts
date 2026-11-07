import crossSpawn from 'cross-spawn';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeCatalogSource, RuntimeEngine } from '../models/index.js';
import { sqliteService } from './sqliteService.js';
import { enrichRuntimeUpdates } from './runtimeUpdateService.js';
import { logInfo } from '../utils/logger.js';
import { childProcessEnv } from './childProcessEnv.js';
import { reconcileDetectedRuntimes } from './runtimeReconciliation.js';
import { codexIsolationArgsFrom } from './runtimeIsolation.js';
import { codexAlphaHome, codexAlphaSignedIn } from './cliHome.js';
import {
  findClaude,
  findCodex,
  findAntigravity,
  findGemini,
  findOpenCode,
  findLMStudio,
  findOllama,
  hasLMStudioInstallation
} from './runtimeDiscovery.js';

/**
 * Run a CLI with stdin CLOSED and capture stdout.
 *
 * `exec`/`execFile` leave stdin piped and open. Several agent CLIs treat an open
 * stdin as "input is coming" and block on it: `agy models` completes in ~3.5s
 * with stdin closed, and hangs past 120s without. Claude Code warns about the
 * same thing ("no stdin data received in 3s").
 *
 * Any probe that spawns an agent CLI must go through this.
 */
function runClosedStdin(
  bin: string,
  args: string[],
  timeoutMs = 30_000,
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      // Windows installs commonly expose `.cmd` shims. cross-spawn resolves
      // those wrappers consistently, whereas Node's native spawn can report
      // ENOENT/EINVAL even when the same command works in the user's shell.
      child = crossSpawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childProcessEnv(options.env)
      });
    } catch {
      resolve({ ok: false, stdout: '', stderr: '', timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => { child.kill(); finish(false, true); }, timeoutMs);

    child.stdout?.on('data', d => { stdout += String(d); });
    child.stderr?.on('data', d => { stderr += String(d); });
    child.on('error', () => finish(false, false));
    child.on('close', code => finish(code === 0, false));
  });
}

/** What a detector reports. scanRuntimes() stamps `type` and `latencyMs`. */
type DetectedEngine = Omit<RuntimeEngine, 'type' | 'latencyMs'>;

/** One `codex exec --help` check per Codex binary and version. */
const codexApproveForMeProbes = new Map<string, Promise<boolean>>();
/** One `codex features list` check per Codex binary and version. */
const codexIsolationProbes = new Map<string, Promise<string[]>>();
/** One `opencode run --help` check per OpenCode binary and version. */
const openCodePureProbes = new Map<string, Promise<boolean>>();

/** A cache key that changes when the binary is replaced by an update. */
function binaryStamp(bin: string): string {
  let stamp = '';
  try { stamp = String(fs.statSync(bin).mtimeMs); } catch { /* a bare command name */ }
  return bin + '|' + stamp;
}

type CatalogDiscovery = {
  models: string[];
  source: RuntimeCatalogSource;
  fetchedAt?: string;
  stale?: boolean;
  error?: string;
  endpoint?: string;
};

const CODEX_CATALOG_STALE_AFTER_MS = 30 * 60 * 1000;

function catalogTimestampIsStale(fetchedAt: string | undefined): boolean {
  if (!fetchedAt) return true;
  const age = Date.now() - Date.parse(fetchedAt);
  return !Number.isFinite(age) || age > CODEX_CATALOG_STALE_AFTER_MS;
}

function catalogMetadata(catalog: CatalogDiscovery, checkedAt: string): Pick<RuntimeEngine,
  'catalogSource' | 'catalogCheckedAt' | 'catalogFetchedAt' | 'catalogStale' | 'catalogError'
> {
  return {
    catalogSource: catalog.source,
    catalogCheckedAt: checkedAt,
    catalogFetchedAt: catalog.fetchedAt,
    catalogStale: catalog.stale ?? false,
    catalogError: catalog.error
  };
}

function uniqueModelIds(values: unknown[]): string[] {
  return Array.from(new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean)
  ));
}

/**
 * Codex's local cache and an optional local OpenAI-compatible gateway are the
 * only sources of model IDs. Alpha must not invent model IDs when neither
 * source is available.
 */
const DEFAULT_OPENCODEX_BASE_URL = 'http://127.0.0.1:10100/v1';

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

function localBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return undefined;
    return value.trim().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Codex itself does not expose a stable `models` subcommand. When it has been
 * wired through OpenCodex (or another local OpenAI-compatible gateway), the
 * gateway's `/v1/models` endpoint is the authoritative catalog instead.
 *
 * Read the same user-level config that Codex uses, but only ever probe a
 * loopback URL. This prevents a runtime scan from unexpectedly calling a
 * remote endpoint or leaking credentials while still discovering the local
 * OpenCodex catalog automatically.
 */
function codexCatalogBases(): string[] {
  const configured: string[] = [
    process.env.OPENAI_BASE_URL,
    process.env.OPENAI_API_BASE,
    process.env.CODEX_OPENAI_BASE_URL
  ].filter((value): value is string => Boolean(value?.trim()));

  const configPath = path.join(codexHome(), 'config.toml');
  try {
    const config = fs.readFileSync(configPath, 'utf8');
    const match = config.match(/^\s*openai_base_url\s*=\s*["']([^"']+)["']/im);
    if (match?.[1]) configured.push(match[1]);
  } catch {
    // A missing or protected Codex config is normal on a fresh machine.
  }

  configured.push(DEFAULT_OPENCODEX_BASE_URL);

  return Array.from(
    new Set(
      configured
        .map(localBaseUrl)
        .filter((value): value is string => Boolean(value))
    )
  );
}

function catalogModelIds(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data;
  const models = (payload as { models?: unknown })?.models;
  const rows = Array.isArray(data) ? data : Array.isArray(models) ? models : Array.isArray(payload) ? payload : [];

  return Array.from(
    new Set(
      rows
        .map(item => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'id' in item) {
            const id = (item as { id?: unknown }).id;
            return typeof id === 'string' ? id : '';
          }
          return '';
        })
        .map(id => id.trim())
        .filter(Boolean)
    )
  );
}

/**
 * Codex CLI keeps the provider model catalogue in CODEX_HOME/models_cache.json.
 * It contains internal entries too, so only models visible in Codex's picker
 * and supported by the API belong in Alpha's model selector.
 */
export function codexCacheModelIds(payload: unknown): string[] {
  const rows = (payload as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return [];

  return rows
    .map((item, index) => {
      if (typeof item === 'string') return { id: item.trim(), priority: index, visible: true, supported: true };
      if (!item || typeof item !== 'object') return null;

      const model = item as {
        slug?: unknown;
        visibility?: unknown;
        supported_in_api?: unknown;
        priority?: unknown;
      };
      const id = typeof model.slug === 'string' ? model.slug.trim() : '';
      const priority = typeof model.priority === 'number' ? model.priority : index;
      const visible = model.visibility === undefined || model.visibility === 'list';
      const supported = model.supported_in_api !== false;
      return { id, priority, visible, supported };
    })
    .filter((model): model is { id: string; priority: number; visible: boolean; supported: boolean } =>
      Boolean(model?.id && model.visible && model.supported)
    )
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map(model => model.id)
    .filter((id, index, all) => all.indexOf(id) === index);
}

function readCodexModelCache(): { models: string[]; fetchedAt?: string; found: boolean } {
  try {
    const cachePath = path.join(codexHome(), 'models_cache.json');
    const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { fetched_at?: unknown };
    const fetchedAt = typeof payload.fetched_at === 'string' && !Number.isNaN(Date.parse(payload.fetched_at))
      ? new Date(payload.fetched_at).toISOString()
      : undefined;
    return { models: codexCacheModelIds(payload), fetchedAt, found: true };
  } catch {
    // Codex has not fetched a catalogue yet, or the cache is unavailable.
    return { models: [], found: false };
  }
}

async function discoverCodexCatalog(): Promise<CatalogDiscovery> {
  for (const base of codexCatalogBases()) {
    try {
      const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const models = catalogModelIds(await response.json());
      if (models.length) return { models, source: 'local_api', fetchedAt: new Date().toISOString(), endpoint: base };
    } catch {
      // The gateway is optional; continue with Codex's local cache.
    }
  }

  const cachedModels = readCodexModelCache();
  if (cachedModels.found) {
    return {
      models: cachedModels.models,
      source: 'cache',
      fetchedAt: cachedModels.fetchedAt,
      stale: catalogTimestampIsStale(cachedModels.fetchedAt),
      error: cachedModels.fetchedAt ? undefined : 'Codex cache has no fetch timestamp'
    };
  }

  return { models: [], source: 'none', error: 'No Codex model catalog is available' };
}

/** OpenCode prints one provider/model identifier per line. */
export function parseOpenCodeModelIds(output: string): string[] {
  const ansi = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
  const ids: string[] = [];
  for (const rawLine of output.replace(ansi, '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[>*•-]\s*/, '');
    const token = line.split(/\s+/)[0] || '';
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@+~-]*$/.test(token)) {
      ids.push(token);
    }
  }
  return uniqueModelIds(ids);
}

/** Parse Antigravity's human-readable model listing without inventing IDs. */
export function parseAntigravityModelIds(output: string): string[] {
  const ansi = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
  const ids: string[] = [];

  const collectJson = (value: unknown) => {
    const rows = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as { models?: unknown }).models)
        ? (value as { models: unknown[] }).models
        : [];
    for (const row of rows) {
      if (typeof row === 'string') ids.push(row);
      else if (row && typeof row === 'object') {
        const item = row as { id?: unknown; name?: unknown; model?: unknown };
        const id = [item.id, item.name, item.model].find(candidate => typeof candidate === 'string');
        if (typeof id === 'string') ids.push(id);
      }
    }
  };

  try {
    const trimmed = output.replace(ansi, '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) collectJson(JSON.parse(trimmed));
  } catch {
    // Fall through to the line-oriented format.
  }

  const ignored = /^(available\s+models?|models?|name|id|fetching|loading|authenticated|warning|info)\b/i;
  for (const rawLine of output.replace(ansi, '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[>*•-]\s*/, '');
    if (!line || ignored.test(line)) continue;
    const token = line.split(/\t|\s{2,}/)[0].trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._:/@+~-]*$/.test(token)) ids.push(token);
  }

  return uniqueModelIds(ids);
}

/**
 * Parse both LM Studio's native v1 response and its OpenAI-compatible legacy
 * response. Embedding models are excluded because Alpha's runtime picker is
 * for inference/chat models.
 */
export function parseLMStudioModelIds(payload: unknown): string[] {
    const root = payload && typeof payload === 'object' ? payload as { models?: unknown; data?: unknown } : {};
  const rows = Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : [];
  const ids = rows.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    const row = item as { type?: unknown; key?: unknown; id?: unknown };
    if (typeof row.type === 'string' && /^embeddings?$/i.test(row.type)) return '';
    return typeof row.key === 'string' ? row.key : typeof row.id === 'string' ? row.id : '';
  });
  return uniqueModelIds(ids);
}

async function discoverOpenCodeCatalog(bin: string, refresh = false): Promise<CatalogDiscovery> {
  let listing = await runClosedStdin(bin, refresh ? ['models', '--refresh'] : ['models'], 60_000);
  // Older OpenCode builds may not understand --refresh. Their cached listing
  // is still better than losing the catalog entirely.
  if (!listing.ok && refresh) listing = await runClosedStdin(bin, ['models'], 60_000);
  const models = parseOpenCodeModelIds(listing.stdout);
  if (listing.ok) {
    return {
      models,
      source: 'cli',
      fetchedAt: new Date().toISOString(),
      error: models.length ? undefined : 'OpenCode returned no parseable models'
    };
  }
  return { models: [], source: 'none', error: listing.timedOut ? 'OpenCode model listing timed out' : 'OpenCode model listing failed' };
}

async function discoverAnthropicCatalog(): Promise<CatalogDiscovery> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return { models: [], source: 'none', error: 'ANTHROPIC_API_KEY is not configured' };
  }

  const models: string[] = [];
  let afterId: string | undefined;
  try {
    do {
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '1000');
      if (afterId) url.searchParams.set('after_id', afterId);
      const response = await fetch(url, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return { models: [], source: 'remote_api', error: `Anthropic model catalog returned HTTP ${response.status}` };
      const payload = await response.json() as { data?: Array<{ id?: unknown }>; has_more?: boolean; last_id?: unknown };
      models.push(...(payload.data || []).map(model => model.id).filter((id): id is string => typeof id === 'string'));
      afterId = payload.has_more && typeof payload.last_id === 'string' ? payload.last_id : undefined;
    } while (afterId);
    return { models: uniqueModelIds(models), source: 'remote_api', fetchedAt: new Date().toISOString() };
  } catch {
    return { models: [], source: 'remote_api', error: 'Anthropic model catalog request failed' };
  }
}

/**
 * Claude Code's Claude.ai subscription login does not provide an Anthropic API
 * key, so `/v1/models` cannot enumerate its account-backed model access. Keep
 * the CLI's supported model IDs available for that auth mode, as earlier
 * runtime scans did. API-key logins continue to use the live API catalog.
 */
const CLAUDE_CODE_SUBSCRIPTION_MODELS = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-haiku-4-5'
];

export function claudeCatalogForAuth(
  catalog: CatalogDiscovery,
  authMethod: unknown
): CatalogDiscovery {
  if (catalog.models.length || authMethod !== 'claude.ai') return catalog;
  return {
    models: [...CLAUDE_CODE_SUBSCRIPTION_MODELS],
    source: 'cli'
  };
}

async function discoverGeminiCatalog(): Promise<CatalogDiscovery> {
  const apiKey = (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)?.trim();
  if (!apiKey) {
    return { models: [], source: 'none', error: 'GEMINI_API_KEY or GOOGLE_API_KEY is not configured' };
  }

  const models: string[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await fetch(url, {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return { models: [], source: 'remote_api', error: `Gemini model catalog returned HTTP ${response.status}` };
      const payload = await response.json() as {
        models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
        nextPageToken?: unknown;
      };
      for (const model of payload.models || []) {
        const name = typeof model.name === 'string' ? model.name.replace(/^models\//, '') : '';
        const methods = Array.isArray(model.supportedGenerationMethods)
          ? model.supportedGenerationMethods
          : [];
        if (name && (!methods.length || methods.includes('generateContent'))) models.push(name);
      }
      pageToken = typeof payload.nextPageToken === 'string' && payload.nextPageToken ? payload.nextPageToken : undefined;
    } while (pageToken);
    return { models: uniqueModelIds(models), source: 'remote_api', fetchedAt: new Date().toISOString() };
  } catch {
    return { models: [], source: 'remote_api', error: 'Gemini model catalog request failed' };
  }
}

export class RuntimeService {
  /**
   * Scan host workstation for installed and authenticated AI CLI tools
   */
  async scanRuntimes(options: { refreshCatalog?: boolean } = {}): Promise<RuntimeEngine[]> {
    /**
     * Each detector reports identity and status; `type` and a measured
     * `latencyMs` are stamped here so every detector reports the same shape.
     *
     * 'cloud' vs 'local' describes where INFERENCE happens, not the process:
     * the CLIs run on this machine but call a hosted model.
     */
    const timed = async (
      kind: 'local' | 'cloud',
      probe: () => Promise<DetectedEngine>
    ): Promise<RuntimeEngine> => {
      const started = Date.now();
      const engine = await probe();
      return { ...engine, type: kind, latencyMs: Date.now() - started };
    };

    const detectedRuntimes: RuntimeEngine[] = [
      await timed('cloud', () => this.detectClaude()),
      await timed('cloud', () => this.detectCodex()),
      await timed('cloud', () => this.detectAntigravity()),
      await timed('cloud', () => this.detectGemini()),
      await timed('local', () => this.detectOpenCode(options.refreshCatalog === true)),
      await timed('local', () => this.detectOllama()),
      await timed('local', () => this.detectLMStudio())
    ];

    const installedLocalIds = new Set<string>();
    if (findOllama()) installedLocalIds.add('ollama');
    if (hasLMStudioInstallation()) installedLocalIds.add('lmstudio');
    const runtimes = reconcileDetectedRuntimes(detectedRuntimes, sqliteService.getRuntimes(), installedLocalIds);
    sqliteService.removeUndetectedLocalRuntimes(['ollama', 'lmstudio'].filter(id => !runtimes.some(runtime => runtime.id === id)));

    const enriched = await enrichRuntimeUpdates(runtimes);
    sqliteService.saveRuntimes(enriched);
    logInfo('Runtime scan completed', { runtimes: enriched.map(r => ({ id: r.id, status: r.status })) });
    return enriched;
  }

  /** Refresh one runtime without forcing unrelated providers to be probed. */
  async refreshRuntime(id: string, options: { refreshCatalog?: boolean } = {}): Promise<RuntimeEngine> {
    const started = Date.now();
    let engine: DetectedEngine;
    let type: RuntimeEngine['type'];

    switch (id) {
      case 'claude':
        engine = await this.detectClaude();
        type = 'cloud';
        break;
      case 'codex':
        engine = await this.detectCodex();
        type = 'cloud';
        break;
      case 'antigravity':
        engine = await this.detectAntigravity();
        type = 'cloud';
        break;
      case 'gemini':
        engine = await this.detectGemini();
        type = 'cloud';
        break;
      case 'opencode':
        engine = await this.detectOpenCode(options.refreshCatalog === true);
        type = 'local';
        break;
      case 'ollama':
        engine = await this.detectOllama();
        type = 'local';
        break;
      case 'lmstudio':
        engine = await this.detectLMStudio();
        type = 'local';
        break;
      default:
        throw new Error(`Unknown runtime: ${id}`);
    }

    const previous = sqliteService.getRuntimes().find(runtime => runtime.id === id);
    const localMissing = id === 'ollama' ? !findOllama() : id === 'lmstudio' ? !hasLMStudioInstallation() : false;
    if (localMissing && !engine.catalogFetchedAt && !previous?.catalogFetchedAt) throw new Error('This local runtime has not been detected. Run a full host scan first.');
    const preserveCatalog = !engine.models.length && !engine.catalogFetchedAt && Boolean(previous?.models.length);
    const runtime: RuntimeEngine = {
      ...(previous || { id }),
      ...engine,
      isDefault: previous?.isDefault ?? engine.isDefault,
      ...(preserveCatalog ? {
        models: previous!.models,
        catalogSource: 'cache' as const,
        catalogFetchedAt: previous!.catalogFetchedAt,
        catalogStale: true
      } : {}),
      type,
      latencyMs: Date.now() - started
    };
    const [enriched] = await enrichRuntimeUpdates([runtime]);
    sqliteService.saveRuntimes([enriched]);
    return enriched;
  }

  static claudePath(): string {
    return findClaude();
  }

  static codexPath(): string {
    return findCodex();
  }

  /**
   * Whether this machine's Codex CLI accepts `--approve-for-me`.
   *
   * Codex builds from 0.163 have it, but the npm release (0.144) rejects it
   * with "unexpected argument" and exit code 2 before the agent does anything,
   * which failed every Codex build task on a machine with that release first
   * on PATH. Read from `codex exec --help`, once per binary and modified time;
   * a check that could not run is not cached, so the next run asks again.
   */
  static codexSupportsApproveForMe(): Promise<boolean> {
    const bin = RuntimeService.codexPath();
    let stamp = '';
    try { stamp = String(fs.statSync(bin).mtimeMs); } catch { /* a bare command name */ }
    const key = bin + '|' + stamp;
    let probe = codexApproveForMeProbes.get(key);
    if (!probe) {
      probe = runClosedStdin(bin, ['exec', '--help'], 15_000).then(result => {
        if (!result.ok) codexApproveForMeProbes.delete(key);
        return result.ok && /--approve-for-me\b/.test(result.stdout + result.stderr);
      });
      codexApproveForMeProbes.set(key, probe);
    }
    return probe;
  }

  /**
   * `--disable` flags that keep a Codex agent away from the operator's apps,
   * plugins, memories, hooks and browser or computer control.
   *
   * Read from `codex features list` because codex exits on an unknown feature
   * name, and the names change between releases. A check that could not run
   * is not cached and yields no flags, so the turn still starts.
   */
  static codexIsolationArgs(): Promise<string[]> {
    const bin = RuntimeService.codexPath();
    const key = binaryStamp(bin);
    let probe = codexIsolationProbes.get(key);
    if (!probe) {
      probe = runClosedStdin(bin, ['features', 'list'], 15_000).then(result => {
        if (!result.ok) codexIsolationProbes.delete(key);
        return result.ok ? codexIsolationArgsFrom(result.stdout) : [];
      });
      codexIsolationProbes.set(key, probe);
    }
    return probe;
  }

  /** Whether this machine's OpenCode accepts `run --pure` (no external plugins). */
  static openCodeSupportsPure(): Promise<boolean> {
    const bin = RuntimeService.opencodePath();
    const key = binaryStamp(bin);
    let probe = openCodePureProbes.get(key);
    if (!probe) {
      probe = runClosedStdin(bin, ['run', '--help'], 15_000).then(result => {
        if (!result.ok) openCodePureProbes.delete(key);
        return result.ok && /--pure\b/.test(result.stdout + result.stderr);
      });
      openCodePureProbes.set(key, probe);
    }
    return probe;
  }

  static agyPath(): string {
    return findAntigravity();
  }

  static geminiPath(): string {
    return findGemini();
  }

  static opencodePath(): string {
    return findOpenCode();
  }

  private async detectClaude(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const bin = RuntimeService.claudePath();
    const catalog = await discoverAnthropicCatalog();
    const versionProbe = await runClosedStdin(bin, ['--version'], 15_000);
    if (!versionProbe.ok) {
      return {
        id: 'claude',
        name: 'Claude Code CLI',
        provider: 'Anthropic',
        status: 'offline',
        models: catalog.models,
        ...catalogMetadata(catalog, now),
        detectedAt: now
      };
    }

    const version = versionProbe.stdout.trim();
    const authProbe = await runClosedStdin(bin, ['auth', 'status'], 15_000);
    try {
      const auth = JSON.parse(authProbe.stdout);
      const accountCatalog = claudeCatalogForAuth(catalog, auth.authMethod);
      return {
        id: 'claude',
        name: 'Claude Code CLI',
        provider: 'Anthropic',
        status: auth.loggedIn ? 'online' : 'degraded',
        version,
        isDefault: true,
        models: accountCatalog.models,
        ...catalogMetadata(accountCatalog, now),
        account: {
          email: auth.email,
          org: auth.orgName,
          authMethod: auth.authMethod === 'claude.ai' ? 'Claude account' : 'Anthropic API key',
          billing: auth.authMethod === 'claude.ai' ? 'subscription' : 'api',
          plan: auth.subscriptionType
        },
        detectedAt: now
      };
    } catch {
      return {
        id: 'claude',
        name: 'Claude Code CLI',
        provider: 'Anthropic',
        status: 'degraded',
        version,
        isDefault: true,
        models: catalog.models,
        ...catalogMetadata(catalog, now),
        detectedAt: now
      };
    }
  }

  private async detectCodex(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const bin = RuntimeService.codexPath();
    const catalog = await discoverCodexCatalog();
    const models = catalog.models;
    const versionProbe = await runClosedStdin(bin, ['--version'], 15_000);
    if (!versionProbe.ok) {
      return {
        id: 'codex',
        name: 'OpenAI Codex CLI',
        provider: 'OpenAI',
        status: 'offline',
        models,
        endpoint: catalog.endpoint,
        detectedAt: now
      };
    }

    const version = versionProbe.stdout.trim();
    // Agents use Alpha's own Codex home once someone signed in there, so that
    // sign-in is the one that decides whether Codex agents can run.
    const alphaHomeEnv = codexAlphaSignedIn() ? { env: { CODEX_HOME: codexAlphaHome() } } : {};
    const authProbe = await runClosedStdin(bin, ['login', 'status'], 15_000, alphaHomeEnv);
    const authOutput = `${authProbe.stdout}\n${authProbe.stderr}`.trim();
    const authText = authOutput.toLowerCase();
    const accountLogin = /logged in using chatgpt|logged in with chatgpt/.test(authText);
    const apiKeyLogin = /logged in using (?:an? )?api key|logged in with (?:an? )?api key/.test(authText);
    const signedOut = /not logged in|authentication failed|auth(?:entication)? required/.test(authText);

    // Older Codex versions may not expose login status consistently. `doctor`
    // remains a fallback, but only positive auth evidence marks the runtime ready.
    let doctorText = '';
    if (!accountLogin && !apiKeyLogin && !signedOut) {
      const doctorProbe = await runClosedStdin(bin, ['doctor'], 30_000, alphaHomeEnv);
      doctorText = `${doctorProbe.stdout}\n${doctorProbe.stderr}`.toLowerCase();
    }
    const doctorAccountLogin = /stored auth mode\s*[: ]+chatgpt|stored chatgpt tokens\s*[: ]+true/.test(doctorText);
    const doctorApiKeyLogin = /stored auth mode\s*[: ]+(?:api[_ -]?key|apikey)|stored api key\s*[: ]+true/.test(doctorText);
    const doctorSignedOut = /not logged in|authentication failed|auth(?:entication)? required/.test(doctorText);
    const isAccountLogin = accountLogin || doctorAccountLogin;
    const isApiKeyLogin = apiKeyLogin || doctorApiKeyLogin;
    return {
      id: 'codex',
      name: 'OpenAI Codex CLI',
      provider: 'OpenAI',
      status: isAccountLogin || isApiKeyLogin ? 'online' : 'degraded',
      version,
      models,
      endpoint: catalog.endpoint,
      account: isAccountLogin
        ? {
            authMethod: 'ChatGPT account',
            billing: 'account',
            note: 'Codex confirms ChatGPT account sign-in, but does not report the account plan.'
          }
        : isApiKeyLogin
          ? { authMethod: 'OpenAI API key', billing: 'api' }
          : {
              authMethod: signedOut || doctorSignedOut ? 'Not signed in' : 'Sign-in not confirmed',
              billing: 'unknown',
              note: 'Run `codex login` and scan runtimes again.'
            },
      ...catalogMetadata(catalog, now),
      detectedAt: now
    };
  }

  private async detectAntigravity(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const base: DetectedEngine = {
      id: 'antigravity',
      name: 'Google Antigravity',
      provider: 'Antigravity',
      status: 'offline',
      models: [],
      catalogSource: 'none',
      catalogCheckedAt: now,
      detectedAt: now
    };

    const bin = RuntimeService.agyPath();
    // Alpha's catalog scan is metadata-only. Antigravity has its own
    // background self-updater, so disable that updater for these probes.
    const probeOptions = { env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } };
    const probe = await runClosedStdin(bin, ['--version'], 15_000, probeOptions);
    if (!probe.ok) return base;
    const version = probe.stdout.trim();

    // `agy models` performs a live fetch, so it doubles as the auth probe.
    const listing = await runClosedStdin(bin, ['models'], 60_000, probeOptions);

    if (listing.ok) {
      const models = parseAntigravityModelIds(listing.stdout);
      const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
      let usesGeminiApiKey = false;
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { modelProvider?: unknown };
        usesGeminiApiKey = settings.modelProvider === 'gemini' && Boolean(process.env.GEMINI_API_KEY?.trim());
      } catch {
        // A missing settings file means the CLI uses its account sign-in flow.
      }
      return {
        ...base,
        status: models.length ? 'online' : 'degraded',
        version,
        models,
        account: usesGeminiApiKey
          ? { authMethod: 'Gemini API key', billing: 'api' }
          : {
              authMethod: 'Antigravity account',
              billing: 'account',
              note: 'The model scan confirms account access; Antigravity does not report the exact plan tier here.'
            },
        catalogSource: 'cli',
        catalogFetchedAt: now,
        catalogError: models.length ? undefined : 'Antigravity returned no models'
      };
    }

    // A timeout is not evidence of being signed out — `--version` answered a
    // moment ago. Saying 'degraded' would tell the user to log in when the real
    // problem is a slow fetch. Keep the last known models.
    const cachedModels =
      sqliteService.getRuntimes().find(r => r.id === 'antigravity')?.models ?? [];
    return {
      ...base,
      status: listing.timedOut ? 'online' : 'degraded',
      version,
      models: cachedModels,
      catalogSource: cachedModels.length ? 'cache' : 'none',
      catalogStale: true,
      catalogError: listing.timedOut ? 'Antigravity model listing timed out' : 'Antigravity model listing failed'
    };
  }

  private async detectGemini(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const bin = RuntimeService.geminiPath();
    const catalog = await discoverGeminiCatalog();
    const probe = await runClosedStdin(bin, ['--version'], 15_000);
    if (probe.ok && catalog.models.length) {
      return {
        id: 'gemini',
        name: 'Google Gemini CLI',
        provider: 'Google Gemini',
        status: 'online',
        version: probe.stdout.trim(),
        models: catalog.models,
        account: {
          authMethod: process.env.GOOGLE_API_KEY?.trim() ? 'Google API key' : 'Gemini API key',
          billing: 'api'
        },
        ...catalogMetadata(catalog, now),
        detectedAt: now
      };
    }
    return {
      id: 'gemini',
      name: 'Google Gemini CLI',
      provider: 'Google Gemini',
      status: probe.ok ? 'degraded' : 'offline',
      version: probe.ok ? probe.stdout.trim() : undefined,
      models: catalog.models,
      ...(probe.ok ? {
        account: {
          authMethod: 'Gemini API key not verified',
          billing: 'unknown' as const,
          note: 'Alpha uses Antigravity CLI for Google Gemini agents. Configure a working Gemini API key for this separate CLI runtime.'
        }
      } : {}),
      ...catalogMetadata(catalog, now),
      detectedAt: now
    };
  }

  private async detectOpenCode(refreshCatalog = false): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const bin = RuntimeService.opencodePath();
    const probe = await runClosedStdin(bin, ['--version'], 15_000);
    if (probe.ok) {
      const catalog = await discoverOpenCodeCatalog(bin, refreshCatalog);
      return {
        id: 'opencode',
        name: 'OpenCode CLI',
        provider: 'OpenCode',
        status: 'online',
        version: probe.stdout.trim(),
        models: catalog.models,
        ...catalogMetadata(catalog, now),
        detectedAt: now
      };
    }
    return {
      id: 'opencode',
      name: 'OpenCode CLI',
      provider: 'OpenCode',
      status: 'offline',
      models: [],
      catalogSource: 'none',
      catalogCheckedAt: now,
      catalogError: 'OpenCode CLI is not installed',
      detectedAt: now
    };
  }

  private async detectOllama(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    try {
      const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const data = await res.json() as any;
        const models = uniqueModelIds((data.models || []).map((m: any) => m.name || m.model));
        let version: string | undefined;
        try {
          const versionResponse = await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(1000) });
          if (versionResponse.ok) {
            const versionPayload = await versionResponse.json() as { version?: unknown };
            version = typeof versionPayload.version === 'string' ? versionPayload.version : undefined;
          }
        } catch {
          // Version is optional; the model catalog remains authoritative.
        }
        return {
          id: 'ollama',
          name: 'Ollama Local Engine',
          provider: 'Ollama',
          status: 'online',
          version,
          models,
          catalogSource: 'local_api',
          catalogCheckedAt: now,
          catalogFetchedAt: now,
          catalogError: models.length ? undefined : 'Ollama returned no installed models',
          detectedAt: now
        };
      }
      return {
        id: 'ollama',
        name: 'Ollama Local Engine',
        provider: 'Ollama',
        status: 'degraded',
        models: [],
        catalogSource: 'none',
        catalogCheckedAt: now,
        catalogError: `Ollama model catalog returned HTTP ${res.status}`,
        detectedAt: now
      };
    } catch {
      return {
        id: 'ollama',
        name: 'Ollama Local Engine',
        provider: 'Ollama',
        status: 'offline',
        models: [],
        catalogSource: 'none',
        catalogCheckedAt: now,
        catalogError: 'Ollama model catalog is unavailable',
        detectedAt: now
      };
    }
  }

  private async detectLMStudio(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const cli = findLMStudio();
    const versionProbe = fs.existsSync(cli)
      ? await runClosedStdin(cli, ['--version'], 15_000)
      : { ok: false, stdout: '', stderr: '', timedOut: false };
    const version = versionProbe.ok ? versionProbe.stdout.trim() : undefined;
    const baseUrl = 'http://127.0.0.1:1234';
    const headers = process.env.LM_API_TOKEN?.trim()
      ? { Authorization: `Bearer ${process.env.LM_API_TOKEN.trim()}` }
      : undefined;
    try {
      // Native v1 lists all downloaded models. Fall back to the older native v0
      // endpoint, then the OpenAI-compatible endpoint for very old installs.
      let endpoint = `${baseUrl}/api/v1/models`;
      let res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(1000) });
      if (res.status === 404 || res.status === 405) {
        endpoint = `${baseUrl}/api/v0/models`;
        res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(1000) });
      }
      if ((res.status === 404 || res.status === 405) && endpoint.endsWith('/api/v0/models')) {
        endpoint = `${baseUrl}/v1/models`;
        res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(1000) });
      }
      if (res.ok) {
        const models = parseLMStudioModelIds(await res.json());
        return {
          id: 'lmstudio',
          name: 'LM Studio Engine',
          provider: 'LM Studio',
          status: 'online',
          version,
          models,
          endpoint: `${baseUrl}/v1`,
          catalogSource: 'local_api',
          catalogCheckedAt: now,
          catalogFetchedAt: now,
          catalogError: models.length ? undefined : 'LM Studio returned no installed chat models',
          detectedAt: now
        };
      }
      return {
        id: 'lmstudio',
        name: 'LM Studio Engine',
        provider: 'LM Studio',
        status: 'degraded',
        version,
        models: [],
        catalogSource: 'none',
        catalogCheckedAt: now,
        catalogError: `LM Studio model catalog returned HTTP ${res.status}`,
        detectedAt: now
      };
    } catch {
      return {
        id: 'lmstudio',
        name: 'LM Studio Engine',
        provider: 'LM Studio',
        status: 'offline',
        version,
        models: [],
        catalogSource: 'none',
        catalogCheckedAt: now,
        catalogError: 'LM Studio model catalog is unavailable',
        detectedAt: now
      };
    }
  }
}

export const runtimeService = new RuntimeService();
