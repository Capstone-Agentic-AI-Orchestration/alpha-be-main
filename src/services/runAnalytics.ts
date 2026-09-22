import type { Agent, AnalyticsData, PrototypeRun } from '../models/index.js';

/**
 * What a workspace's runs add up to, over the last day.
 *
 * A pure function of the rows it is given, so the desktop can aggregate its
 * SQLite and the cloud its Postgres without two implementations drifting
 * apart. It used to sit inside `sqliteService`, which quietly made "analytics"
 * mean "analytics of this machine's database" -- true on a laptop, wrong on
 * Render, where the runs belong to everybody.
 *
 * Missing telemetry stays missing: a run whose CLI reported no tokens is not a
 * run of zero tokens, and counting it as one would understate cost.
 */
export function analyticsFrom(
  allRuns: PrototypeRun[],
  roster: Agent[],
  now = new Date()
): AnalyticsData {
  const cutoffMs = now.getTime() - 24 * 60 * 60 * 1000;
  const runs = allRuns.filter(run => {
    const createdMs = Date.parse(run.createdAt);
    return Number.isFinite(createdMs) && createdMs >= cutoffMs && createdMs <= now.getTime();
  });
  const agents = new Map(roster.map(agent => [agent.id, agent]));
  const terminalStatuses = new Set<string>(['completed', 'failed', 'cancelled', 'changes_requested']);

  const tokenParts = (run: PrototypeRun) => {
    const usage = run.usage;
    if (!usage) return null;
    const promptTokens = (usage.inputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
    const completionTokens = (usage.outputTokens ?? 0) + (usage.thinkingTokens ?? 0);
    const hasTokens = [
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
      usage.thinkingTokens
    ].some(value => typeof value === 'number');
    if (!hasTokens) return null;
    return {
      promptTokens,
      completionTokens,
      tokens: promptTokens + completionTokens,
      cost: typeof usage.costUsd === 'number' ? usage.costUsd : 0
    };
  };

  const totalTokens = runs.reduce((sum, run) => sum + (tokenParts(run)?.tokens ?? 0), 0);
  const totalCost = runs.reduce((sum, run) => sum + (tokenParts(run)?.cost ?? 0), 0);
  const judged = runs.filter(run => terminalStatuses.has(run.status));
  const completed = judged.filter(run => run.status === 'completed').length;
  const durations = runs
    .map(run => Date.parse(run.updatedAt) - Date.parse(run.createdAt))
    .filter(duration => Number.isFinite(duration) && duration >= 0);

  const bucketMs = 3 * 60 * 60 * 1000;
  const baseMs = Math.floor(cutoffMs / bucketMs) * bucketMs;
  const buckets = Array.from({ length: 8 }, (_, index) => ({
    startMs: baseMs + index * bucketMs,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0
  }));
  for (const run of runs) {
    const parts = tokenParts(run);
    if (!parts) continue;
    const index = Math.floor((Date.parse(run.createdAt) - baseMs) / bucketMs);
    if (index < 0 || index >= buckets.length) continue;
    buckets[index].promptTokens += parts.promptTokens;
    buckets[index].completionTokens += parts.completionTokens;
    buckets[index].cost += parts.cost;
  }

  const formatHour = (timestamp: number) => {
    const hour = new Date(timestamp).getHours();
    return `${String(hour).padStart(2, '0')}:00`;
  };

  const agentTotals = new Map<string, {
    tokens: number;
    cost: number;
    runs: number;
    judged: number;
    completed: number;
  }>();
  const modelTotals = new Map<string, { calls: number; cost: number }>();

  for (const run of runs) {
    const parts = tokenParts(run);
    const current = agentTotals.get(run.agentId) ?? {
      tokens: 0,
      cost: 0,
      runs: 0,
      judged: 0,
      completed: 0
    };
    current.tokens += parts?.tokens ?? 0;
    current.cost += parts?.cost ?? 0;
    current.runs += 1;
    if (terminalStatuses.has(run.status)) current.judged += 1;
    if (run.status === 'completed') current.completed += 1;
    agentTotals.set(run.agentId, current);

    const modelName = agents.get(run.agentId)?.modelName || 'Unknown model';
    const model = modelTotals.get(modelName) ?? { calls: 0, cost: 0 };
    model.calls += 1;
    model.cost += parts?.cost ?? 0;
    modelTotals.set(modelName, model);
  }

  return {
    totalTokens24h: totalTokens,
    totalCost24h: Math.round(totalCost * 100) / 100,
    avgLatencyMs: durations.length
      ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
      : 0,
    totalAgentRuns: runs.length,
    successRate: judged.length ? Math.round((completed / judged.length) * 1000) / 10 : 0,
    tokenTimeline: buckets.some(bucket => bucket.promptTokens > 0 || bucket.completionTokens > 0)
      ? buckets.map(bucket => ({
          hour: formatHour(bucket.startMs),
          promptTokens: bucket.promptTokens,
          completionTokens: bucket.completionTokens,
          cost: Math.round(bucket.cost * 100) / 100
        }))
      : [],
    agentBreakdown: [...agentTotals.entries()]
      .map(([agentId, values]) => ({
        agentId,
        agentName: agents.get(agentId)?.name || agentId,
        tokens: values.tokens,
        cost: Math.round(values.cost * 100) / 100,
        runs: values.runs,
        efficiency: values.judged ? Math.round((values.completed / values.judged) * 1000) / 10 : 0
      }))
      .sort((a, b) => b.tokens - a.tokens),
    modelBreakdown: [...modelTotals.entries()]
      .map(([modelName, values]) => ({
        modelName,
        percentage: runs.length ? Math.round((values.calls / runs.length) * 1000) / 10 : 0,
        cost: Math.round(values.cost * 100) / 100,
        totalCalls: values.calls
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls)
  };
}
