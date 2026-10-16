import type { RuntimeEngine } from '../models/index.js';

/** Failed probes alone cannot establish that a local engine is installed. */
export function reconcileDetectedRuntimes(detected: RuntimeEngine[], previous: RuntimeEngine[], installedLocalIds: Set<string>): RuntimeEngine[] {
  const prior = new Map(previous.map(runtime => [runtime.id, runtime]));
  const runtimes = detected.filter(runtime => {
    if (!['ollama', 'lmstudio'].includes(runtime.id)) return true;
    return installedLocalIds.has(runtime.id) || !!runtime.catalogFetchedAt || !!prior.get(runtime.id)?.catalogFetchedAt;
  }).map(runtime => {
    const old = prior.get(runtime.id);
    const preserve = !runtime.catalogFetchedAt && !!old?.catalogFetchedAt;
    return { ...runtime, isDefault: old?.isDefault ?? runtime.isDefault,
      ...(preserve ? { models: old!.models, catalogSource: 'cache' as const, catalogFetchedAt: old!.catalogFetchedAt, catalogStale: true } : {}) };
  });
  const usable = runtimes.filter(runtime => runtime.status === 'online' && runtime.models.length);
  const selected = usable.find(runtime => runtime.isDefault) ?? usable[0];
  return runtimes.map(runtime => ({ ...runtime, isDefault: runtime.id === selected?.id }));
}
