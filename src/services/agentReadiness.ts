import { Agent, ModelProvider, RuntimeEngine } from '../models/index.js';

/**
 * Can this agent actually run right now, and if not, what would fix it?
 *
 * Alpha stores no provider credentials by design — agents run by spawning
 * `claude`, `codex` or `agy`, which authenticate from the machine's own
 * keychain. The consequence is that an agent is only as available as the CLI
 * behind it, and that varies per machine and per person.
 *
 * Nothing surfaced this. The roster showed five healthy-looking agents whether
 * or not their CLIs were installed or signed in; the first sign of trouble was
 * a failed chat turn, worded as though the daemon were at fault. On this machine
 * `codex` is installed but signed out, so one of the five agents cannot answer
 * at all and nothing says so until you message it.
 *
 * That is tolerable for the person who set the machine up and knows which CLIs
 * they have. It is not tolerable for anyone else, which is the whole point of
 * checking: someone opening Alpha for the first time should be told what to
 * install or sign into, not discover it one broken conversation at a time.
 *
 * The runtime scan already knows all of this — `runtimeService` distinguishes
 * installed-and-signed-in from installed-but-signed-out from absent. This maps
 * that onto the agent, which is where the user is looking.
 */

export type AgentReadinessStatus =
  /** The CLI is installed and signed in. */
  | 'ready'
  /** Installed, but no session — the user needs to sign in. */
  | 'signed_out'
  /** The binary was not found on this machine. */
  | 'not_installed'
  /**
   * The CLI is installed and signed in, but the model this agent is pinned to
   * is not one the CLI offers any more.
   */
  | 'stale_model'
  /** No runtime was scanned for this provider, so nothing is known. */
  | 'unknown';

export interface AgentReadiness {
  status: AgentReadinessStatus;
  /** One sentence naming what to do, or confirming there is nothing to do. */
  detail: string;
  /** The command to run, when there is one. */
  command?: string;
}

/**
 * The CLI each provider spawns, and how to get it working.
 *
 * Kept beside the readiness check rather than in the runner because this is
 * user-facing advice, and it has to name the binary a person would type.
 */
const PROVIDER_CLI: Partial<Record<ModelProvider, { bin: string; signIn: string; install: string }>> = {
  Anthropic: {
    bin: 'claude',
    signIn: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code'
  },
  OpenAI: {
    bin: 'codex',
    signIn: 'codex login',
    install: 'npm install -g @openai/codex'
  },
  Antigravity: {
    bin: 'agy',
    signIn: 'agy',
    install: 'Install the Antigravity IDE, which ships the agy CLI'
  },
  'Google Gemini': {
    bin: 'agy',
    signIn: 'agy',
    install: 'Install Google Antigravity CLI from antigravity.google/cli'
  },
  Ollama: {
    bin: 'ollama',
    signIn: 'ollama serve',
    install: 'Install Ollama from ollama.com'
  },
  'LM Studio': {
    bin: 'lmstudio',
    signIn: 'Start the LM Studio local server',
    install: 'Install LM Studio from lmstudio.ai'
  },
  OpenCode: {
    bin: 'opencode',
    signIn: 'opencode auth',
    install: 'npm install -g opencode-ai'
  }
};

/** Names Claude Code resolves itself, to the newest model of each family. */
const CLAUDE_CODE_ALIASES: ReadonlySet<string> = new Set(['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

/**
 * Whether a runtime will accept this model name.
 *
 * Usually that means the name is in the scanned list. Claude Code on a
 * subscription login is the exception: its list comes from Claude Code's own
 * picker (or, failing that, its aliases), and Claude Code accepts both every
 * alias and full names it does not list, such as `claude-sonnet-5`. A missing
 * name is no evidence the model was retired. If it was, Claude Code says so on
 * the first turn.
 */
export function runtimeOffersModel(runtime: RuntimeEngine, modelName: string): boolean {
  if (runtime.models.includes(modelName)) return true;
  return runtime.provider === 'Anthropic' && runtime.catalogSource === 'cli' &&
    (modelName.startsWith('claude-') || CLAUDE_CODE_ALIASES.has(modelName));
}

/**
 * Is this agent pinned to a model its CLI has since stopped offering?
 *
 * Providers retire model tiers on their own schedule. Antigravity 1.1.25 dropped
 * the whole `gemini-3.5` family and added `3.8`, which silently invalidated
 * every agent pinned to a 3.5 model — the run died with "invalid model
 * selection" and advice to check that the CLI was installed and signed in,
 * which it was. The model picker cannot prevent this: it constrains the choice
 * to the live list at the moment of writing, and the pin goes stale afterwards.
 *
 * The scan already holds the answer — `runtime.models` is refreshed from
 * `agy models` on every detect — so this is a comparison, not a new probe.
 *
 * Only ever fires on positive evidence. An empty `models` means the scan
 * learned nothing: a probe that timed out keeps the last known list, and some
 * runtimes report no models at all. Calling an agent broken on the strength of
 * a list we do not have would be worse than saying nothing.
 */
function staleModel(
  agent: Pick<Agent, 'modelProvider' | 'modelName'>,
  runtime: RuntimeEngine,
  bin: string
): AgentReadiness | null {
  const pinned = agent.modelName?.trim();
  if (!pinned) return null;
  if (!runtime.models?.length) return null;
  if (runtimeOffersModel(runtime, pinned)) return null;

  return {
    status: 'stale_model',
    detail:
      `${bin} no longer offers \`${pinned}\`, so this agent cannot answer. ` +
      `Edit the agent and pick a current model.`,
    // Not a shell command, but the same slot the other statuses use for "the
    // concrete thing that fixes it" — and here that is the list to choose from.
    command: `Available: ${runtime.models.join(', ')}`
  };
}

/**
 * Map a scanned runtime onto the agent that depends on it.
 *
 * `runtimeService` reports `degraded` for a CLI that is present but has no
 * session — see `auth.loggedIn ? 'online' : 'degraded'`. That distinction is
 * the useful part and is what separates "sign in" from "install".
 */
export function agentReadiness(
  agent: Pick<Agent, 'modelProvider' | 'modelName'>,
  runtimes: RuntimeEngine[]
): AgentReadiness {
  const cli = PROVIDER_CLI[agent.modelProvider];
  // Google Gemini agents are dispatched through Antigravity CLI (`agy`), not
  // the separate Gemini Developer CLI. Readiness must reflect the binary the
  // runner will actually start.
  const runtime = agent.modelProvider === 'Google Gemini'
    ? runtimes.find(r => r.id === 'antigravity')
    : runtimes.find(r => r.provider === agent.modelProvider);

  if (!runtime) {
    return {
      status: 'unknown',
      detail: `No runtime has been scanned for ${agent.modelProvider}. Open the Runtimes page to scan.`
    };
  }

  switch (runtime.status) {
    case 'online': {
      // Installed and signed in is necessary but not sufficient: the CLI can be
      // perfectly healthy and still reject the model this agent is pinned to.
      const stale = staleModel(agent, runtime, cli?.bin ?? runtime.name);
      if (stale) return stale;
      return { status: 'ready', detail: `${cli?.bin ?? runtime.name} is installed and signed in.` };
    }

    case 'degraded':
      return {
        status: 'signed_out',
        detail: `${cli?.bin ?? runtime.name} is installed but not signed in, so this agent cannot answer.`,
        command: cli?.signIn
      };

    case 'offline':
      return {
        status: 'not_installed',
        detail: `${cli?.bin ?? runtime.name} was not found on this machine, so this agent cannot answer.`,
        command: cli?.install
      };

    default:
      // 'scanning', or a status added later. Not an error, just not an answer.
      return {
        status: 'unknown',
        detail: `${cli?.bin ?? runtime.name} is still being checked.`
      };
  }
}
