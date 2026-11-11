import crossSpawn from 'cross-spawn';
import { RuntimeService } from './runtimeService.js';
import { codexAlphaHome, codexAlphaSignedIn } from './cliHome.js';
import { childProcessEnv } from './childProcessEnv.js';
import { sqliteService } from './sqliteService.js';

export type ProviderLimitStatus = 'available' | 'signed_out' | 'unsupported' | 'unavailable';

export interface ProviderLimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
}

export interface ProviderLimits {
  provider: 'codex' | 'claude';
  name: string;
  status: ProviderLimitStatus;
  accountLabel?: string;
  plan?: string;
  windows: ProviderLimitWindow[];
  dashboardUrl: string;
  detail: string;
  lastCheckedAt: string | null;
}

export interface ProviderLimitsSnapshot {
  available: true;
  source: 'this_desktop';
  lastRefreshedAt: string | null;
  providers: ProviderLimits[];
}

const CACHE_MS = 2 * 60 * 1000;
const CODEX_DASHBOARD = 'https://chatgpt.com/settings/usage';
const CLAUDE_DASHBOARD = 'https://claude.ai/settings/usage';
let cached: ProviderLimitsSnapshot | undefined;
let cachedAt = 0;
let refreshInFlight: Promise<ProviderLimitsSnapshot> | undefined;

function durationLabel(minutes: number | undefined): string {
  if (minutes === 300) return '5-hour window';
  if (minutes === 10_080) return 'Weekly window';
  if (minutes === 1_440) return 'Daily window';
  if (minutes === 60) return 'Hourly window';
  return typeof minutes === 'number' && minutes > 0 ? `${minutes} minute window` : 'Usage window';
}

function rateLimitWindows(result: any): ProviderLimitWindow[] {
  const byId = result?.rateLimitsByLimitId;
  const snapshots: Array<[string, any]> = byId && typeof byId === 'object' && Object.keys(byId).length
    ? Object.entries(byId)
    : [['codex', result?.rateLimits]];
  const windows: ProviderLimitWindow[] = [];
  for (const [limitId, snapshot] of snapshots) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    for (const key of ['primary', 'secondary']) {
      const window = snapshot[key];
      if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
      const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
      const duration = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : undefined;
      const resetSeconds = typeof window.resetsAt === 'number' ? window.resetsAt : undefined;
      windows.push({
        id: `${limitId}-${key}`,
        label: `${snapshot.limitName || limitId} · ${durationLabel(duration)}`,
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
        resetsAt: resetSeconds && resetSeconds > 0 ? new Date(resetSeconds * 1000).toISOString() : null
      });
    }
  }
  return windows;
}

function responseErrorText(message: string, authMethod?: string): ProviderLimitStatus {
  const normalized = message.toLowerCase();
  if (/api.?key/i.test(authMethod ?? '')) return 'unsupported';
  if (/not signed in|not logged in|auth(?:entication)? required|unauthorized|401/.test(normalized)) return 'signed_out';
  if (/method not found|unknown method|unsupported method|not supported/.test(normalized)) return 'unsupported';
  return 'unavailable';
}

/** Ask Codex's supported local app-server API; Alpha never reads its auth files. */
export function readCodexLimits(timeoutMs = 10_000): Promise<ProviderLimits> {
  const now = new Date().toISOString();
  const executable = RuntimeService.codexPath();
  if (!executable) return Promise.resolve({
    provider: 'codex', name: 'Codex', status: 'unsupported', windows: [], dashboardUrl: CODEX_DASHBOARD,
    detail: 'Codex CLI is not installed on this machine.', lastCheckedAt: now
  });
  const authMethod = sqliteService.getRuntimes().find(item => item.id === 'codex')?.account?.authMethod;
  if (/api.?key/i.test(authMethod ?? '')) return Promise.resolve({
    provider: 'codex', name: 'Codex', status: 'unsupported', accountLabel: authMethod, windows: [],
    dashboardUrl: 'https://platform.openai.com/usage',
    detail: 'This Codex runtime uses API-key billing. ChatGPT plan limits do not apply; review API usage in the OpenAI platform dashboard.',
    lastCheckedAt: now
  });

  return new Promise(resolve => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      const overlay = codexAlphaSignedIn() ? { CODEX_HOME: codexAlphaHome() } : {};
      child = crossSpawn(executable, ['app-server', '--listen', 'stdio://'], {
        cwd: process.cwd(),
        env: childProcessEnv(overlay),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      });
    } catch {
      resolve({ provider: 'codex', name: 'Codex', status: 'unavailable', windows: [], dashboardUrl: CODEX_DASHBOARD,
        detail: 'Codex app-server could not be started.', lastCheckedAt: now });
      return;
    }
    if (!child.stdin || !child.stdout) {
      child.kill();
      resolve({ provider: 'codex', name: 'Codex', status: 'unavailable', windows: [], dashboardUrl: CODEX_DASHBOARD,
        detail: 'Codex app-server could not open its JSONL transport.', lastCheckedAt: now });
      return;
    }
    const stdin = child.stdin;
    const stdout = child.stdout;

    let buffer = '';
    let settled = false;
    let initialized = false;
    const finish = (result: ProviderLimits) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const send = (message: Record<string, unknown>) => stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish({
      provider: 'codex', name: 'Codex', status: 'unavailable', windows: [], dashboardUrl: CODEX_DASHBOARD,
      detail: 'Codex did not return usage limits before the check timed out.', lastCheckedAt: now
    }), timeoutMs);
    timer.unref?.();

    child.on('error', error => {
      const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unsupported' : 'unavailable';
      finish({ provider: 'codex', name: 'Codex', status, windows: [], dashboardUrl: CODEX_DASHBOARD,
        detail: status === 'unsupported' ? 'Codex CLI is not installed on this machine.' : 'Codex app-server could not be started.', lastCheckedAt: now });
    });
    child.on('exit', () => {
      if (!settled) finish({ provider: 'codex', name: 'Codex', status: 'unavailable', windows: [], dashboardUrl: CODEX_DASHBOARD,
        detail: 'Codex app-server ended before returning usage limits.', lastCheckedAt: now });
    });
    stdout.on('data', chunk => {
      buffer += String(chunk);
      if (buffer.length > 1024 * 1024) {
        finish({ provider: 'codex', name: 'Codex', status: 'unavailable', windows: [], dashboardUrl: CODEX_DASHBOARD,
          detail: 'Codex app-server returned an unexpectedly large response.', lastCheckedAt: now });
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) {
            finish({ provider: 'codex', name: 'Codex', status: 'unsupported', windows: [], dashboardUrl: CODEX_DASHBOARD,
              detail: 'This Codex version does not support the app-server handshake.', lastCheckedAt: now });
            return;
          }
          if (!initialized) {
            initialized = true;
            send({ method: 'initialized', params: {} });
            send({ method: 'account/rateLimits/read', id: 2, params: {} });
          }
        } else if (message.id === 2) {
          if (message.error) {
            const authMethod = sqliteService.getRuntimes().find(item => item.id === 'codex')?.account?.authMethod;
            const status = responseErrorText(String(message.error.message ?? ''), authMethod);
            finish({ provider: 'codex', name: 'Codex', status, windows: [], dashboardUrl: CODEX_DASHBOARD,
              detail: status === 'signed_out' ? 'Sign in to Codex, then refresh usage limits.' : status === 'unsupported'
                ? 'This Codex version does not expose rate limits through app-server.'
                : 'Codex rate limits are temporarily unavailable.', lastCheckedAt: now });
            return;
          }
          const windows = rateLimitWindows(message.result);
          finish({
            provider: 'codex', name: 'Codex', status: windows.length ? 'available' : 'unavailable',
            plan: typeof message.result?.rateLimits?.planType === 'string' ? message.result.rateLimits.planType : undefined,
            windows, dashboardUrl: CODEX_DASHBOARD,
            detail: windows.length ? 'Read from Codex app-server. It may include plan-level windows, not per-model API billing.'
              : 'Codex returned no rate-limit windows for this account.',
            lastCheckedAt: now
          });
        }
      }
    });

    stdin.on('error', () => finish({ provider: 'codex', name: 'Codex', status: 'unavailable', windows: [], dashboardUrl: CODEX_DASHBOARD,
      detail: 'Codex app-server closed its input before returning usage limits.', lastCheckedAt: now }));
    send({
      method: 'initialize', id: 1,
      params: { clientInfo: { name: 'alpha_desktop', title: 'Alpha Desktop', version: '2.0.0' } }
    });
  });
}

function claudeLimits(): ProviderLimits {
  const now = new Date().toISOString();
  const runtime = sqliteService.getRuntimes().find(item => item.id === 'claude');
  const authMethod = runtime?.account?.authMethod;
  if (!RuntimeService.claudePath()) {
    return { provider: 'claude', name: 'Claude Code', status: 'unsupported', windows: [], dashboardUrl: CLAUDE_DASHBOARD,
      detail: 'Claude Code CLI is not installed on this machine.', lastCheckedAt: now };
  }
  if ((authMethod && /not signed in|sign-in not confirmed/i.test(authMethod)) || (runtime?.status === 'degraded' && Boolean(authMethod))) {
    return { provider: 'claude', name: 'Claude Code', status: 'signed_out', windows: [], dashboardUrl: CLAUDE_DASHBOARD,
      detail: 'Claude Code does not appear to be signed in on this machine.', lastCheckedAt: now };
  }
  if (!runtime || runtime.status === 'offline' || !authMethod) {
    return { provider: 'claude', name: 'Claude Code', status: 'unavailable', windows: [], dashboardUrl: CLAUDE_DASHBOARD,
      detail: 'Claude Code account status could not be confirmed. Refresh runtimes and try again.', lastCheckedAt: now };
  }
  const dashboardUrl = /api.?key/i.test(authMethod) ? 'https://console.anthropic.com/settings/usage' : CLAUDE_DASHBOARD;
  return { provider: 'claude', name: 'Claude Code', status: 'unsupported', accountLabel: authMethod,
    plan: runtime.account?.plan, windows: [], dashboardUrl,
    detail: 'Claude Code does not expose subscription quota windows through a supported read-only CLI interface. Check limits in Claude settings.',
    lastCheckedAt: now };
}

export async function getProviderLimits(force = false): Promise<ProviderLimitsSnapshot> {
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const [codex] = await Promise.all([readCodexLimits()]);
    const providers = [codex, claudeLimits()];
    const checked = providers.map(provider => provider.lastCheckedAt).filter((value): value is string => Boolean(value)).sort();
    const snapshot: ProviderLimitsSnapshot = {
      available: true,
      source: 'this_desktop',
      lastRefreshedAt: checked.at(-1) ?? new Date().toISOString(),
      providers
    };
    cached = snapshot;
    cachedAt = Date.now();
    return snapshot;
  })().finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}
