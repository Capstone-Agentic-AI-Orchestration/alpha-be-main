import { logError } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';
import type { ParsedEvent, RunTelemetry, StreamFamily } from './streamParser.js';
import { currentWorkspaceId, runWithWorkspace } from './workspaceContext.js';
import { sqliteService } from './sqliteService.js';

export interface UsageContext {
  threadId?: string;
  messageId?: string;
  agentId?: string;
  callId?: string;
  prototypeRunId?: string;
  orchestrationRunId?: string;
}
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  thinkingTokens?: number;
  totalTokens?: number;
}
export interface UsageEntry extends UsageContext {
  id: string;
  provider: StreamFamily;
  model?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  status: 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  usage: TokenUsage;
}
const active = new Set<string>();
const tokenKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'thinkingTokens'] as const;

/** Provider counts have different overlap rules. Never add a cached/reasoning subset twice. */
export function normalizeTokens(family: StreamFamily, telemetry: RunTelemetry): TokenUsage {
  const result: TokenUsage = {};
  for (const key of tokenKeys) {
    const value = telemetry[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  const parts = [result.inputTokens, result.outputTokens];
  if (family !== 'codex') parts.push(result.cacheReadTokens, result.cacheCreationTokens);
  // Antigravity reports thinking separately; Claude's output already includes it.
  if (family === 'antigravity') parts.push(result.thinkingTokens);
  const reported = parts.filter((value): value is number => value !== undefined);
  if (reported.length) result.totalTokens = reported.reduce((sum, value) => sum + value, 0);
  return result;
}

/** Per-invocation snapshots: message updates replace, final invocation totals supersede messages. */
export class UsageAccumulator {
  private messages = new Map<string, RunTelemetry>();
  private final?: TokenUsage;
  private turns = new Map<string, TokenUsage>();
  constructor(private readonly family: StreamFamily) {}
  accept(event: ParsedEvent): TokenUsage {
    if (!event.telemetry || !['usage', 'result'].includes(event.type)) return this.snapshot();
    if (event.type === 'result' && this.family === 'codex') this.turns.set(event.streamKey ?? 'turn', normalizeTokens(this.family, event.telemetry));
    else if (event.type === 'result') this.final = normalizeTokens(this.family, event.telemetry);
    else if (!this.final && event.streamKey) {
      const next = { ...this.messages.get(event.streamKey) };
      for (const key of tokenKeys) {
        const value = event.telemetry[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) next[key] = Math.max(next[key] ?? 0, value);
      }
      this.messages.set(event.streamKey, next);
    }
    return this.snapshot();
  }
  snapshot(): TokenUsage {
    if (this.final && this.final.totalTokens !== undefined) return { ...this.final };
    const sum: TokenUsage = {};
    const parts = this.family === 'codex' ? [...this.turns.values()] : [...this.messages.values()].map(message => normalizeTokens(this.family, message));
    for (const normalized of parts) {
      for (const key of [...tokenKeys, 'totalTokens'] as const) {
        if (normalized[key] !== undefined) sum[key] = (sum[key] ?? 0) + normalized[key]!;
      }
    }
    return sum;
  }
}

export function startUsage(context: UsageContext | undefined, provider: StreamFamily, model?: string) {
  if (!context || !Object.values(context).some(Boolean)) return undefined;
  const call = context.callId ? sqliteService.getAgentCall(context.callId) : undefined;
  context = { ...context, messageId: context.messageId ?? call?.messageId };
  const now = new Date().toISOString();
  const entry: UsageEntry = { ...context, id: randomUUID(), provider, model, startedAt: now, updatedAt: now, status: 'running', usage: {} };
  const accumulator = new UsageAccumulator(provider);
  active.add(entry.id);
  const workspaceId = currentWorkspaceId();
  let persistenceFailed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastPersistedAt = 0;
  const save = () => {
    if (persistenceFailed) return;
    try { runWithWorkspace(workspaceId, () => sqliteService.saveChatUsage(entry)); lastPersistedAt = Date.now(); }
    catch (error) {
      persistenceFailed = true;
      active.delete(entry.id);
      logError('Usage recording failed; execution continues without measured usage.', error);
    }
  };
  const persistSoon = () => {
    if (persistenceFailed || pending) return;
    const delay = Math.max(0, 250 - (Date.now() - lastPersistedAt));
    if (!delay) { save(); return; }
    pending = setTimeout(() => { pending = undefined; save(); }, delay);
    pending.unref?.();
  };
  save();
  return {
    accept(event: ParsedEvent) {
      if (!event.telemetry || !['usage', 'result'].includes(event.type)) {
        if (Date.now() - Date.parse(entry.updatedAt) > 2_000) { entry.updatedAt = new Date().toISOString(); persistSoon(); }
        return;
      }
      entry.usage = accumulator.accept(event);
      entry.updatedAt = new Date().toISOString();
      persistSoon();
    },
    finish(outcome: 'completed' | 'stopped' | 'failed' = 'completed') {
      if (pending) { clearTimeout(pending); pending = undefined; }
      if (!active.delete(entry.id)) return;
      entry.status = outcome;
      entry.endedAt = entry.updatedAt = new Date().toISOString();
      save();
    }
  };
}

export function currentUsageEntries(entries: UsageEntry[]): UsageEntry[] {
  return entries.map(entry => entry.status === 'running' && !active.has(entry.id)
    ? { ...entry, status: 'interrupted', endedAt: entry.updatedAt } : entry);
}
