import crossSpawn from 'cross-spawn';
import { RuntimeService, runClosedStdin } from './runtimeService.js';
import { cliHomeEnv, codexAlphaHome, codexAlphaSignedIn, openCodeIsolationEnv } from './cliHome.js';
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
  provider: 'codex' | 'claude' | 'antigravity' | 'opencode';
  name: string;
  status: ProviderLimitStatus;
  accountLabel?: string;
  plan?: string;
  windows: ProviderLimitWindow[];
  dashboardUrl: string;
  detail: string;
  lastCheckedAt: string | null;
  /** Local spending for providers without plan limits, such as OpenCode. */
  spend?: { days: number; costUsd: number; sessions: number; inputTokens: number; outputTokens: number };
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
        label: snapshot.limitName ? `${snapshot.limitName} · ${durationLabel(duration)}` : durationLabel(duration),
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

const clampPercent = (value: number) => Math.max(0, Math.min(100, Math.round(value * 10) / 10));
const isoOrNull = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Plan windows from Claude Code's experimental SDK get_usage response (utilization is 0-100). */
export function claudeUsageWindows(rateLimits: any): ProviderLimitWindow[] {
  if (!rateLimits || typeof rateLimits !== 'object') return [];
  const windows: ProviderLimitWindow[] = [];
  const add = (id: string, label: string, window: any) => {
    if (!window || typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) return;
    const usedPercent = clampPercent(window.utilization);
    windows.push({ id, label, usedPercent, remainingPercent: clampPercent(100 - usedPercent), resetsAt: isoOrNull(window.resets_at) });
  };
  const named: Array<[string, string]> = [
    ['five_hour', '5-hour window'], ['seven_day', 'Weekly window'], ['seven_day_opus', 'Weekly · Opus'],
    ['seven_day_sonnet', 'Weekly · Sonnet'], ['seven_day_oauth_apps', 'Weekly · connected apps']
  ];
  for (const [key, label] of named) add('claude-' + key, label, rateLimits[key]);
  if (Array.isArray(rateLimits.model_scoped)) {
    rateLimits.model_scoped.forEach((window: any, index: number) =>
      add('claude-model-' + index, String(window?.display_name || 'Model') + ' · Weekly', window));
  }
  return windows;
}

/**
 * Ask Claude Code for the same data as its /usage screen through the SDK
 * control protocol. No prompt is sent, so no model turn or quota is used, and
 * the session is not saved.
 */
function claudeGetUsage(bin: string, timeoutMs: number): Promise<any | null> {
  return new Promise(resolve => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(bin, [
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'
      ], { stdio: ['pipe', 'pipe', 'ignore'], env: childProcessEnv(), windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    if (!child.stdin || !child.stdout) { child.kill(); resolve(null); return; }
    const stdin = child.stdin;
    let buffer = '';
    let settled = false;
    const finish = (value: any | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.end();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    const send = (message: Record<string, unknown>) => stdin.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    stdin.on('error', () => finish(null));
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      if (buffer.length > 1024 * 1024) { finish(null); return; }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.type !== 'control_response') continue;
        const response = message.response;
        if (response?.request_id === 'alpha-init') {
          send({ type: 'control_request', request_id: 'alpha-usage', request: { subtype: 'get_usage', skip_behaviors: true } });
        } else if (response?.request_id === 'alpha-usage') {
          finish(response.subtype === 'success' ? response.response ?? null : null);
        }
      }
    });
    send({ type: 'control_request', request_id: 'alpha-init', request: { subtype: 'initialize' } });
  });
}

export async function readClaudeLimits(timeoutMs = 30_000): Promise<ProviderLimits> {
  const now = new Date().toISOString();
  const base = { provider: 'claude' as const, name: 'Claude Code', windows: [], dashboardUrl: CLAUDE_DASHBOARD, lastCheckedAt: now };
  const bin = RuntimeService.claudePath();
  const auth = await runClosedStdin(bin, ['auth', 'status'], 15_000);
  let status: any;
  try { status = JSON.parse(auth.stdout); } catch { status = undefined; }
  if (!status) {
    const installed = Boolean(auth.stdout || auth.stderr || auth.timedOut);
    return { ...base, status: installed ? 'unavailable' : 'unsupported',
      detail: installed ? 'Claude Code account status could not be read. Try again.' : 'Claude Code CLI is not installed on this machine.' };
  }
  if (!status.loggedIn) {
    return { ...base, status: 'signed_out', detail: 'Claude Code is signed out on this computer. Run "claude auth login", then refresh.' };
  }
  if (status.authMethod !== 'claude.ai') {
    return { ...base, status: 'unsupported', accountLabel: 'Anthropic API key', dashboardUrl: 'https://console.anthropic.com/settings/usage',
      detail: 'This Claude Code sign-in uses API billing, so plan limits do not apply. Review spending in the Anthropic Console.' };
  }
  const usage = await claudeGetUsage(bin, timeoutMs);
  const plan = typeof usage?.subscription_type === 'string' ? usage.subscription_type
    : typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined;
  if (!usage) {
    return { ...base, status: 'unavailable', accountLabel: 'Claude account', plan,
      detail: 'Claude Code did not return usage before the check timed out. This Claude Code version may not support usage checks.' };
  }
  const windows = usage.rate_limits_available ? claudeUsageWindows(usage.rate_limits) : [];
  return { ...base, status: windows.length ? 'available' : 'unsupported', accountLabel: 'Claude account', plan, windows,
    detail: windows.length ? 'Read from Claude Code, the same figures as its /usage screen.'
      : 'Claude Code reported no plan limits for this sign-in.' };
}

const ANTIGRAVITY_SPANS: Record<string, string> = { weekly: 'Weekly', '5h': '5-hour window', daily: 'Daily', hourly: 'Hourly' };

/** Quota buckets from Antigravity's "/usage" command (remaining_fraction is 0-1). */
export function antigravityUsageWindows(result: any): ProviderLimitWindow[] {
  const groups = result?.command?.data?.groups;
  if (!Array.isArray(groups)) return [];
  const windows: ProviderLimitWindow[] = [];
  for (const group of groups) {
    if (!Array.isArray(group?.buckets)) continue;
    for (const bucket of group.buckets) {
      if (typeof bucket?.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction)) continue;
      const remainingPercent = clampPercent(bucket.remaining_fraction * 100);
      const span = ANTIGRAVITY_SPANS[String(bucket.window)] ?? String(bucket.name || 'Usage window');
      windows.push({
        id: 'antigravity-' + String(bucket.id || windows.length),
        label: String(group.name || 'Antigravity') + ' · ' + span,
        usedPercent: clampPercent(100 - remainingPercent),
        remainingPercent,
        resetsAt: isoOrNull(bucket.reset_time)
      });
    }
  }
  return windows;
}

/** Antigravity answers "/usage" locally in print mode, without a model turn. */
export async function readAntigravityLimits(timeoutMs = 75_000): Promise<ProviderLimits> {
  const now = new Date().toISOString();
  const base = { provider: 'antigravity' as const, name: 'Google Antigravity', windows: [], dashboardUrl: '', lastCheckedAt: now };
  const run = await runClosedStdin(RuntimeService.agyPath(), ['-p', '/usage', '--output-format', 'json', '--print-timeout', '60s'], timeoutMs,
    { env: { ...cliHomeEnv('antigravity'), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } });
  let result: any;
  const line = run.stdout.split(/\r?\n/).reverse().find(text => text.trim().startsWith('{'));
  try { result = line ? JSON.parse(line) : undefined; } catch { result = undefined; }
  const output = (run.stdout + ' ' + run.stderr + ' ' + String(result?.response ?? '')).toLowerCase();
  if (!result && !run.stdout && !run.stderr && !run.timedOut) {
    return { ...base, status: 'unsupported', detail: 'Antigravity CLI is not installed on this machine.' };
  }
  if (/sign.?in|log.?in|not authenticated|unauthorized|401/.test(output) && !antigravityUsageWindows(result).length) {
    return { ...base, status: 'signed_out', detail: 'Antigravity is signed out on this computer. Sign in to Antigravity, then refresh.' };
  }
  const windows = antigravityUsageWindows(result);
  if (!windows.length) {
    return { ...base, status: 'unavailable', detail: run.timedOut ? 'Antigravity did not return usage before the check timed out.'
      : 'Antigravity did not report quota for this sign-in.' };
  }
  return { ...base, status: 'available', accountLabel: 'Google account', windows,
    detail: 'Read from Antigravity, the same figures as its /usage command. Models in a group share its limits.' };
}

/** The headline figures from "opencode stats". Token counts may be abbreviated (12.5K, 3.1M). */
export function parseOpenCodeStats(text: string): Omit<NonNullable<ProviderLimits['spend']>, 'days'> | null {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
  const read = (label: string) => {
    const match = new RegExp(label + '[\\s│|]+\\$?([\\d,.]+)\\s*([KMB])?', 'i').exec(clean);
    if (!match) return null;
    const scale = { K: 1e3, M: 1e6, B: 1e9 }[(match[2] ?? '').toUpperCase() as 'K' | 'M' | 'B'] ?? 1;
    const value = Number(match[1].replace(/,/g, '')) * scale;
    return Number.isFinite(value) ? value : null;
  };
  const costUsd = read('Total Cost');
  if (costUsd === null) return null;
  return {
    costUsd, sessions: Math.round(read('Sessions') ?? 0),
    inputTokens: Math.round(read('Input') ?? 0), outputTokens: Math.round(read('Output') ?? 0)
  };
}

/** OpenCode has no plan-limit interface; report what this computer spent through it. */
export async function readOpenCodeUsage(days = 7): Promise<ProviderLimits> {
  const now = new Date().toISOString();
  const base = { provider: 'opencode' as const, name: 'OpenCode', windows: [], dashboardUrl: '', lastCheckedAt: now };
  const run = await runClosedStdin(RuntimeService.opencodePath(), ['stats', '--days', String(days), '--pure'], 30_000,
    { env: openCodeIsolationEnv() });
  const spend = parseOpenCodeStats(run.stdout);
  if (!spend) {
    const installed = Boolean(run.stdout || run.stderr || run.timedOut);
    return { ...base, status: installed ? 'unavailable' : 'unsupported',
      detail: installed ? 'OpenCode usage could not be read. Try again.' : 'OpenCode CLI is not installed on this machine.' };
  }
  return { ...base, status: 'unsupported', spend: { days, ...spend },
    detail: 'OpenCode reports spending, not plan limits. Figures cover OpenCode sessions on this computer.' };
}


export async function getProviderLimits(force = false): Promise<ProviderLimitsSnapshot> {
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    // Each reader asks its own CLI and never throws, so one slow or missing CLI cannot hide the others.
    const providers = await Promise.all([readCodexLimits(), readClaudeLimits(), readAntigravityLimits(), readOpenCodeUsage()]);
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
