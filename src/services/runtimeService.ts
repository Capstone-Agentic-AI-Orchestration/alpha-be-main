import crossSpawn from 'cross-spawn';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeEngine } from '../models/index.js';
import { sqliteService } from './sqliteService.js';
import { logInfo } from '../utils/logger.js';
import {
  findClaude,
  findCodex,
  findAntigravity,
  findGemini,
  findOpenCode
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
  timeoutMs = 30_000
): Promise<{ ok: boolean; stdout: string; timedOut: boolean }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      // Windows installs commonly expose `.cmd` shims. cross-spawn resolves
      // those wrappers consistently, whereas Node's native spawn can report
      // ENOENT/EINVAL even when the same command works in the user's shell.
      child = crossSpawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, stdout: '', timedOut: false });
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (ok: boolean, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, timedOut });
    };

    const timer = setTimeout(() => { child.kill(); finish(false, true); }, timeoutMs);

    child.stdout?.on('data', d => { stdout += String(d); });
    child.on('error', () => finish(false, false));
    child.on('exit', code => finish(code === 0, false));
  });
}

/** What a detector reports. scanRuntimes() stamps `type` and `latencyMs`. */
type DetectedEngine = Omit<RuntimeEngine, 'type' | 'latencyMs'>;

/**
 * Used only when neither Codex nor a local OpenAI-compatible catalog can
 * answer. The list is deliberately conservative: advertising a model that the
 * current account cannot actually run is worse than showing a short list and
 * explaining that the catalog is unavailable.
 */
const CODEX_FALLBACK_MODELS = ['gpt-5.6-sol', 'o3', 'gpt-4o'];
const DEFAULT_OPENCODEX_BASE_URL = 'http://127.0.0.1:10100/v1';

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

  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
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

async function discoverCodexCatalog(): Promise<{ models: string[]; endpoint?: string }> {
  for (const base of codexCatalogBases()) {
    try {
      const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const models = catalogModelIds(await response.json());
      if (models.length) return { models, endpoint: base };
    } catch {
      // The gateway is optional; fall back to the small known-safe list.
    }
  }
  return { models: [] };
}

export class RuntimeService {
  /**
   * Scan host workstation for installed and authenticated AI CLI tools
   */
  async scanRuntimes(): Promise<RuntimeEngine[]> {
    /**
     * Each detector reports identity and status; `type` and a measured
     * `latencyMs` are stamped here so the five of them cannot disagree.
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

    const runtimes: RuntimeEngine[] = [
      await timed('cloud', () => this.detectClaude()),
      await timed('cloud', () => this.detectCodex()),
      await timed('cloud', () => this.detectAntigravity()),
      await timed('cloud', () => this.detectGemini()),
      await timed('local', () => this.detectOpenCode()),
      await timed('local', () => this.detectOllama()),
      await timed('local', () => this.detectLMStudio())
    ];

    // Save to SQLite
    sqliteService.saveRuntimes(runtimes);
    logInfo('Runtime scan completed', { runtimes: runtimes.map(r => ({ id: r.id, status: r.status })) });
    return runtimes;
  }

  static claudePath(): string {
    return findClaude();
  }

  static codexPath(): string {
    return findCodex();
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
    const versionProbe = await runClosedStdin(bin, ['--version'], 15_000);
    if (!versionProbe.ok) {
      return {
        id: 'claude',
        name: 'Claude Code CLI',
        provider: 'Anthropic',
        status: 'offline',
        models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
        detectedAt: now
      };
    }

    const version = versionProbe.stdout.trim();
    const authProbe = await runClosedStdin(bin, ['auth', 'status'], 15_000);
    try {
      const auth = JSON.parse(authProbe.stdout);
      return {
        id: 'claude',
        name: 'Claude Code CLI',
        provider: 'Anthropic',
        status: auth.loggedIn ? 'online' : 'degraded',
        version,
        isDefault: true,
        models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
        account: {
          email: auth.email,
          org: auth.orgName,
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
        models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
        detectedAt: now
      };
    }
  }

  private async detectCodex(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const bin = RuntimeService.codexPath();
    const catalog = await discoverCodexCatalog();
    const models = catalog.models.length ? catalog.models : CODEX_FALLBACK_MODELS;
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
    const doctorProbe = await runClosedStdin(bin, ['doctor'], 30_000);
    const doctorOut = doctorProbe.stdout.toLowerCase();
    const isHealthy = doctorProbe.ok && !doctorOut.includes('error') && !doctorOut.includes('not logged in');
    return {
      id: 'codex',
      name: 'OpenAI Codex CLI',
      provider: 'OpenAI',
      // A versioned CLI that cannot answer its optional doctor command is still
      // installed; report it as online rather than pretending it is absent.
      status: doctorProbe.ok ? (isHealthy ? 'online' : 'degraded') : 'online',
      version,
      models,
      endpoint: catalog.endpoint,
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
      detectedAt: now
    };

    const bin = RuntimeService.agyPath();
    const probe = await runClosedStdin(bin, ['--version'], 15_000);
    if (!probe.ok) return base;
    const version = probe.stdout.trim();

    // `agy models` performs a live fetch, so it doubles as the auth probe.
    const listing = await runClosedStdin(bin, ['models'], 60_000);

    if (listing.ok) {
      const models = listing.stdout
        .split('\n')
        .map(l => l.trim().split('\t')[0])
        .filter(id => id && !id.toLowerCase().startsWith('fetching'));
      return { ...base, status: models.length ? 'online' : 'degraded', version, models };
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
      models: cachedModels
    };
  }

  private async detectGemini(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const bin = RuntimeService.geminiPath();
    const probe = await runClosedStdin(bin, ['--version'], 15_000);
    if (probe.ok) {
      return {
        id: 'gemini',
        name: 'Google Gemini CLI',
        provider: 'Google Gemini',
        status: 'online',
        version: probe.stdout.trim(),
        models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
        detectedAt: now
      };
    }
    return {
      id: 'gemini',
      name: 'Google Gemini CLI',
      provider: 'Google Gemini',
      status: 'offline',
      models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
      detectedAt: now
    };
  }

  private async detectOpenCode(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const bin = RuntimeService.opencodePath();
    const probe = await runClosedStdin(bin, ['--version'], 15_000);
    if (probe.ok) {
      return {
        id: 'opencode',
        name: 'OpenCode CLI',
        provider: 'OpenCode',
        status: 'online',
        version: probe.stdout.trim(),
        models: ['opencode-coder', 'deepseek-coder', 'qwen2.5-coder'],
        detectedAt: now
      };
    }
    return {
      id: 'opencode',
      name: 'OpenCode CLI',
      provider: 'OpenCode',
      status: 'offline',
      models: ['opencode-coder', 'deepseek-coder', 'qwen2.5-coder'],
      detectedAt: now
    };
  }

  private async detectOllama(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    try {
      const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const data = await res.json() as any;
        const models = (data.models || []).map((m: any) => m.name || m.model);
        return {
          id: 'ollama',
          name: 'Ollama Local Engine',
          provider: 'Ollama',
          status: 'online',
          models: models.length > 0 ? models : ['llama3.2', 'qwen2.5-coder'],
          detectedAt: now
        };
      }
      return { id: 'ollama', name: 'Ollama Local Engine', provider: 'Ollama', status: 'degraded', models: ['llama3.2'], detectedAt: now };
    } catch {
      return { id: 'ollama', name: 'Ollama Local Engine', provider: 'Ollama', status: 'offline', models: ['llama3.2'], detectedAt: now };
    }
  }

  private async detectLMStudio(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    try {
      const res = await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const data = await res.json() as any;
        const models = (data.data || []).map((m: any) => m.id);
        return {
          id: 'lmstudio',
          name: 'LM Studio Engine',
          provider: 'LM Studio',
          status: 'online',
          models: models.length > 0 ? models : ['local-model'],
          detectedAt: now
        };
      }
      return { id: 'lmstudio', name: 'LM Studio Engine', provider: 'LM Studio', status: 'degraded', models: ['local-model'], detectedAt: now };
    } catch {
      return { id: 'lmstudio', name: 'LM Studio Engine', provider: 'LM Studio', status: 'offline', models: ['local-model'], detectedAt: now };
    }
  }
}

export const runtimeService = new RuntimeService();
