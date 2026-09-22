import { IS_CLOUD } from '../config/env.js';
import type { RuntimeEngine } from '../models/index.js';
import { sqliteService } from './sqliteService.js';

/**
 * The agent CLIs installed on this machine.
 *
 * None, in the cloud: Render has no `claude`, `codex` or `agy`, and never runs
 * an agent. Saying so is not a degraded answer -- it is why the web app shows
 * every agent as needing the desktop app, which is true.
 */
export function machineRuntimes(): RuntimeEngine[] {
  return IS_CLOUD ? [] : sqliteService.getRuntimes();
}
