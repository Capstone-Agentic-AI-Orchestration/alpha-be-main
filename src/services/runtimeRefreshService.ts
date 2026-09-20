import { RuntimeEngine } from '../models/index.js';
import { logError, logInfo } from '../utils/logger.js';
import { runtimeService } from './runtimeService.js';
import { sqliteService } from './sqliteService.js';

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function configuredInterval(): number {
  const value = Number(process.env.ALPHA_RUNTIME_REFRESH_MS);
  return Number.isFinite(value) && value >= 30_000 ? value : DEFAULT_REFRESH_INTERVAL_MS;
}

/**
 * Coordinates runtime catalog scans so startup, the UI, and the timer cannot
 * launch overlapping provider probes. A scan is metadata-only: it never
 * installs a runtime, loads/unloads a model, or restarts a provider.
 */
export class RuntimeRefreshService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<RuntimeEngine[]> | undefined;
  private runtimeInFlight = new Map<string, Promise<RuntimeEngine>>();

  start(): void {
    if (this.timer) return;

    void this.refresh(true).catch(err => {
      logError('Initial runtime catalog refresh failed:', err);
    });

    this.timer = setInterval(() => {
      void this.refresh(false).catch(err => {
        logError('Scheduled runtime catalog refresh failed:', err);
      });
    }, configuredInterval());

    // A refresh timer should not keep a cleanly shutting-down daemon alive.
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
    logInfo('Runtime catalog refresh scheduled', { intervalMs: configuredInterval() });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(_force: boolean): Promise<RuntimeEngine[]> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = runtimeService.scanRuntimes({ refreshCatalog: true })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  async refreshOne(id: string): Promise<RuntimeEngine> {
    if (this.inFlight) {
      const runtimes = await this.inFlight;
      const runtime = runtimes.find(item => item.id === id);
      if (runtime) return runtime;
    }

    const existing = this.runtimeInFlight.get(id);
    if (existing) return existing;

    const promise = runtimeService.refreshRuntime(id, { refreshCatalog: true })
      .finally(() => {
        this.runtimeInFlight.delete(id);
      });
    this.runtimeInFlight.set(id, promise);
    return promise;
  }

  cached(): RuntimeEngine[] {
    return sqliteService.getRuntimes();
  }
}

export const runtimeRefreshService = new RuntimeRefreshService();
