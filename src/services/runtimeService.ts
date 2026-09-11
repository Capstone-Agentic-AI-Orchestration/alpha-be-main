import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeEngine, RuntimeStatus } from '../models/index.js';
import { sqliteService } from './sqliteService.js';
import { logInfo, logError } from '../utils/logger.js';
import {
  findClaude,
  findCodex,
  findAntigravity,
  findGemini,
  findOpenCode
} from './runtimeDiscovery.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    try {
      const { stdout: versionOut } = await execFileAsync(bin, ['--version']);
      const version = versionOut.trim();

      try {
        const { stdout: authOut } = await execFileAsync(bin, ['auth', 'status']);
        const auth = JSON.parse(authOut);
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
    } catch {
      return {
        id: 'claude',
        name: 'Claude Code CLI',
        provider: 'Anthropic',
        status: 'offline',
        models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
        detectedAt: now
      };
    }
  }

  private async detectCodex(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const bin = RuntimeService.codexPath();
    try {
      const { stdout: versionOut } = await execFileAsync(bin, ['--version']);
      const version = versionOut.trim();

      try {
        const { stdout: doctorOut } = await execFileAsync(bin, ['doctor']);
        const isHealthy = !doctorOut.toLowerCase().includes('error') && !doctorOut.toLowerCase().includes('not logged in');
        return {
          id: 'codex',
          name: 'OpenAI Codex CLI',
          provider: 'OpenAI',
          status: isHealthy ? 'online' : 'degraded',
          version,
          models: ['gpt-5.6-sol', 'o3', 'gpt-4o'],
          detectedAt: now
        };
      } catch {
        return {
          id: 'codex',
          name: 'OpenAI Codex CLI',
          provider: 'OpenAI',
          status: 'online',
          version,
          models: ['gpt-5.6-sol', 'o3', 'gpt-4o'],
          detectedAt: now
        };
      }
    } catch {
      return {
        id: 'codex',
        name: 'OpenAI Codex CLI',
        provider: 'OpenAI',
        status: 'offline',
        models: ['gpt-5.6-sol', 'o3', 'gpt-4o'],
        detectedAt: now
      };
    }
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
    try {
      const { stdout } = await execFileAsync(bin, ['--version']);
      return {
        id: 'gemini',
        name: 'Google Gemini CLI',
        provider: 'Google Gemini',
        status: 'online',
        version: stdout.trim(),
        models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
        detectedAt: now
      };
    } catch {
      return {
        id: 'gemini',
        name: 'Google Gemini CLI',
        provider: 'Google Gemini',
        status: 'offline',
        models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
        detectedAt: now
      };
    }
  }

  private async detectOpenCode(): Promise<DetectedEngine> {
    const now = new Date().toISOString();
    const bin = RuntimeService.opencodePath();
    try {
      const { stdout } = await execFileAsync(bin, ['--version']);
      return {
        id: 'opencode',
        name: 'OpenCode CLI',
        provider: 'OpenCode',
        status: 'online',
        version: stdout.trim(),
        models: ['opencode-coder', 'deepseek-coder', 'qwen2.5-coder'],
        detectedAt: now
      };
    } catch {
      return {
        id: 'opencode',
        name: 'OpenCode CLI',
        provider: 'OpenCode',
        status: 'offline',
        models: ['opencode-coder', 'deepseek-coder', 'qwen2.5-coder'],
        detectedAt: now
      };
    }
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
