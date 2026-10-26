export function availabilityPercent(samples: ReadonlyArray<{ ok: boolean }>): number | null {
  if (!samples.length) return null;
  return availabilityPercentFromCounts(samples.filter(sample => sample.ok).length, samples.length);
}

export function availabilityPercentFromCounts(successCount: number, sampleCount: number): number | null {
  if (!sampleCount || sampleCount < 0 || successCount < 0 || successCount > sampleCount) return null;
  return Math.round(successCount * 100_000 / sampleCount) / 1_000;
}

/** Recent samples are supplied newest first, as returned by the monitor query. */
export function incidentTransition(
  samplesNewestFirst: ReadonlyArray<{ ok: boolean }>,
  hasOpenIncident: boolean
): 'open' | 'resolve' | null {
  if (samplesNewestFirst.length < 2) return null;
  const latestTwo = samplesNewestFirst.slice(0, 2);
  if (!hasOpenIncident && latestTwo.every(sample => !sample.ok)) return 'open';
  if (hasOpenIncident && latestTwo.every(sample => sample.ok)) return 'resolve';
  return null;
}

export function isDeploymentInImportWindow(value: string | number | Date, now = Date.now(), windowMs = 30 * 24 * 60 * 60 * 1_000): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= now && timestamp >= now - windowMs;
}
