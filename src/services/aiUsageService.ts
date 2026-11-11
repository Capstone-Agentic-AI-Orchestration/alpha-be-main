import type { UsageEntry } from './chatUsage.js';
import { sqliteService } from './sqliteService.js';

export type AiUsageProvider = 'claude' | 'codex' | 'antigravity';

export interface AiUsageFilter {
  ownerId: string;
  from: string;
  to: string;
  provider?: AiUsageProvider;
}

export interface AiUsageTotals {
  invocations: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
  reportedCostUsd: number | null;
  estimatedCostUsd: number | null;
  unknownCostInvocations: number;
  unreportedTokenInvocations: number;
}

export interface AiUsageBreakdown extends AiUsageTotals {
  key: string;
  label: string;
  provider?: AiUsageProvider;
  model?: string;
  agentId?: string;
}

export interface AiUsageDaily extends AiUsageTotals {
  date: string;
}

export interface AiUsageSummary {
  available: true;
  source: 'this_desktop';
  from: string;
  to: string;
  provider: AiUsageProvider | 'all';
  priceTableVersion: string;
  lastUpdatedAt: string | null;
  totals: AiUsageTotals;
  byProvider: AiUsageBreakdown[];
  byModel: AiUsageBreakdown[];
  byAgent: AiUsageBreakdown[];
  byDay: AiUsageDaily[];
}

interface UsageGroup extends AiUsageTotals {
  key: string;
  label: string;
  provider?: AiUsageProvider;
  model?: string;
  agentId?: string;
  date?: string;
}

const usageFields = [
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
  'thinkingTokens', 'totalTokens', 'reportedCostUsd', 'estimatedCostUsd'
] as const;
type UsageField = typeof usageFields[number];

function emptyTotals(): AiUsageTotals {
  return {
    invocations: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    thinkingTokens: null,
    totalTokens: null,
    reportedCostUsd: null,
    estimatedCostUsd: null,
    unknownCostInvocations: 0,
    unreportedTokenInvocations: 0
  };
}

function applyEntry(target: AiUsageTotals, entry: UsageEntry): void {
  target.invocations += 1;
  let sawTokens = false;
  for (const key of usageFields) {
    const value = entry.usage?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    target[key] = (target[key] ?? 0) + value;
    if (key.endsWith('Tokens')) sawTokens = true;
  }
  if (!sawTokens) target.unreportedTokenInvocations += 1;
  if (entry.usage?.reportedCostUsd === undefined && entry.usage?.estimatedCostUsd === undefined) {
    target.unknownCostInvocations += 1;
  }
}

function collect(
  entries: UsageEntry[],
  identify: (entry: UsageEntry) => Omit<UsageGroup, keyof AiUsageTotals>
): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const entry of entries) {
    const id = identify(entry);
    let group = groups.get(id.key);
    if (!group) {
      group = { ...emptyTotals(), ...id };
      groups.set(id.key, group);
    }
    applyEntry(group, entry);
  }
  const values = [...groups.values()];
  values.sort((a, b) => (b.estimatedCostUsd ?? b.reportedCostUsd ?? -1) - (a.estimatedCostUsd ?? a.reportedCostUsd ?? -1));
  return values;
}

function sum(entries: UsageEntry[]): AiUsageTotals {
  const totals = emptyTotals();
  for (const entry of entries) applyEntry(totals, entry);
  return totals;
}

const providerLabels: Record<AiUsageProvider, string> = {
  claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity'
};

export function aiUsageSummary(filter: AiUsageFilter, priceTableVersion: string): AiUsageSummary {
  const entries = sqliteService.getAiUsageForOwner(filter.ownerId, filter.from, filter.to)
    .filter(entry => !filter.provider || entry.provider === filter.provider);
  const agents = new Map(sqliteService.getAgents().map(agent => [agent.id, agent.name]));
  const byProvider = collect(entries, entry => ({
    key: entry.provider,
    label: providerLabels[entry.provider] ?? entry.provider,
    provider: entry.provider as AiUsageProvider
  }));
  const byModel = collect(entries, entry => ({
    key: `${entry.provider}\u0000${entry.model ?? 'unknown'}`,
    label: entry.model ?? 'Model not reported',
    provider: entry.provider as AiUsageProvider,
    model: entry.model
  }));
  const byAgent = collect(entries, entry => ({
    key: entry.agentId ?? 'unattributed',
    label: entry.agentId === 'alpha-assistant' ? 'Alpha' : agents.get(entry.agentId ?? '') ?? entry.agentId ?? 'Unattributed',
    agentId: entry.agentId
  }));
  const byDay = collect(entries, entry => ({
    key: entry.startedAt.slice(0, 10),
    label: entry.startedAt.slice(0, 10),
    date: entry.startedAt.slice(0, 10)
  })).map(group => ({ ...group, date: group.date! }));
  byDay.sort((a, b) => a.date.localeCompare(b.date));
  const lastUpdatedAt = entries.reduce<string | null>((latest, entry) => !latest || entry.updatedAt > latest ? entry.updatedAt : latest, null);

  return {
    available: true,
    source: 'this_desktop',
    from: filter.from,
    to: filter.to,
    provider: filter.provider ?? 'all',
    priceTableVersion,
    lastUpdatedAt,
    totals: sum(entries),
    byProvider,
    byModel,
    byAgent,
    byDay
  };
}
