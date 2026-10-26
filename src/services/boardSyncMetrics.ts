export interface BoardSyncMetric {
  workspaceId: string;
  clientVersion: string;
  kind: 'snapshot' | 'delta';
  changedRows: number;
  responseBytes: number;
}

function safeLabel(value: string, pattern: RegExp, fallback: string, maxLength: number): string {
  if (!value || value.length > maxLength || !pattern.test(value)) return fallback;
  return value;
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Emit aggregate sync measurements without ever accepting row data or keys. */
export function recordBoardSyncMetric(metric: BoardSyncMetric): void {
  if (metric.kind !== 'snapshot' && metric.kind !== 'delta') return;
  const safeMetric = {
    event: 'board_sync_metric',
    workspaceId: safeLabel(metric.workspaceId, /^[A-Za-z0-9_.:-]+$/, 'unknown', 128),
    clientVersion: safeLabel(metric.clientVersion, /^[A-Za-z0-9.+_-]+$/, 'unknown', 64),
    kind: metric.kind,
    changedRows: safeCount(metric.changedRows),
    responseBytes: safeCount(metric.responseBytes)
  };
  try {
    console.info(JSON.stringify(safeMetric));
  } catch {
    // Metrics must never prevent an otherwise successful board response.
  }
}
