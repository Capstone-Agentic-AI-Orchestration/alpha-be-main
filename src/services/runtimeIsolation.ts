import type { RuntimeEngine } from '../models/index.js';
import { codexAlphaSignedIn } from './cliHome.js';

/**
 * What each runtime can see of the operator's personal setup when it runs an
 * Alpha agent. Shown on the Runtimes page so a developer knows before an agent
 * runs whether their own instructions, skills or tool servers could leak in.
 * See cliHome for how each runtime is isolated and how that was measured.
 */
export type RuntimeIsolation = NonNullable<RuntimeEngine['isolation']>;

/**
 * Codex features that reach the operator's own accounts, plugins, memories,
 * hooks, browser or computer. Alpha grants agents tools through MCP instead.
 */
export const CODEX_OPERATOR_FEATURES = [
  'apps',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'memories',
  'hooks',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use'
] as const;

/**
 * `--disable` flags for the features `codex features list` reports.
 * Codex refuses to start on an unknown feature, so only listed names are used.
 */
export function codexIsolationArgsFrom(featureList: string): string[] {
  const listed = new Set(featureList.split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]).filter(Boolean));
  return CODEX_OPERATOR_FEATURES.filter(feature => listed.has(feature)).flatMap(feature => ['--disable', feature]);
}

export function runtimeIsolation(id: string, state: { codexSignedInForAlpha: boolean }): RuntimeIsolation | undefined {
  switch (id) {
    case 'claude':
      return { isolated: true, detail: 'Agents run without your Claude instructions, skills, plugins or MCP servers.' };
    case 'codex':
      return state.codexSignedInForAlpha
        ? { isolated: true, detail: 'Agents use Alpha\'s own Codex sign-in, without your Codex instructions, skills, memories, plugins or apps.' }
        : {
            isolated: false,
            detail: 'Agents still read your personal Codex instructions (AGENTS.md) and skills. Apps, plugins, memories and hooks are turned off. Sign in to Codex for Alpha to keep your setup separate.',
            action: 'codex_sign_in'
          };
    case 'antigravity':
    case 'gemini':
      return { isolated: true, detail: 'Agents run in Alpha\'s own Antigravity home, without your GEMINI.md, agents, skills or rules.' };
    case 'opencode':
      return { isolated: true, detail: 'Agents run with Alpha\'s own OpenCode settings, without your MCP servers, plugins, or Claude and agent skills.' };
    default:
      return undefined;
  }
}

/** Stamp each runtime with its current isolation. Cheap: reads one file. */
export function withRuntimeIsolation(runtimes: RuntimeEngine[]): RuntimeEngine[] {
  const state = { codexSignedInForAlpha: codexAlphaSignedIn() };
  return runtimes.map(runtime => {
    const isolation = runtimeIsolation(runtime.id, state);
    return isolation ? { ...runtime, isolation } : runtime;
  });
}
