import { RuntimeEngine } from '../models/index.js';

/**
 * Who answers a chat message that names no agent.
 *
 * A message with no `@mention` used to be routed to whichever agent had been
 * mentioned earliest in the thread, because an `@mention` permanently joined
 * that agent to it. So typing "hello" got a reply from Ada Lovelace, in
 * character, having never been addressed — and if her CLI was unavailable the
 * user got Ada's error for a message that was never hers.
 *
 * Alpha answers those itself instead: no persona, no agent identity, no
 * pretence that a specialist was consulted. Agents speak when spoken to.
 */

/** Identity for messages Alpha answers on its own behalf. */
export const DEFAULT_ASSISTANT = {
  /**
   * Not a real agent id, and deliberately not one that could collide with a
   * generated `agent-*` id. Used to key the thread's CLI session so the plain
   * assistant keeps its own conversation, separate from any agent's.
   */
  id: 'alpha-assistant',
  name: 'Alpha'
} as const;

/**
 * What the plain assistant is told about itself.
 *
 * Short on purpose. The point of the default is that it is *not* a persona, so
 * this establishes only what it is and what it must not pretend to be.
 */
export const DEFAULT_ASSISTANT_PROMPT = [
  '## You are Alpha',
  '',
  'You are Alpha itself, answering directly. You are not one of the configured',
  'agents and must not adopt any of their names or personas.',
  '',
  'If the user wants a specific agent, they address it with an @mention — say so',
  'rather than answering on that agent\'s behalf.'
].join('\n');

export interface DefaultAssistantRuntime {
  provider: string;
  modelName: string;
  /** Why this runtime was chosen, for the log and for an error message. */
  reason: string;
}

/**
 * Pick the runtime the plain assistant should use.
 *
 * Prefers the one already marked `isDefault` by the runtime scan, which is the
 * existing notion of "the CLI this machine leads with". Falls back to any other
 * signed-in runtime rather than refusing, because a machine without the default
 * installed should still be able to hold a conversation.
 *
 * Returns null when nothing is usable, so the caller can say what to install
 * instead of spawning a binary that is not there.
 */
export function pickDefaultRuntime(runtimes: RuntimeEngine[]): DefaultAssistantRuntime | null {
  const usable = runtimes.filter(r => r.status === 'online' && (r.models ?? []).length);

  const chosen =
    usable.find(r => r.isDefault) ??
    // Deterministic rather than whatever order the scan returned, so the same
    // machine does not answer from a different model run to run.
    [...usable].sort((a, b) => a.provider.localeCompare(b.provider))[0];

  if (!chosen) return null;

  return {
    provider: chosen.provider,
    modelName: chosen.models[0],
    reason: chosen.isDefault
      ? `${chosen.name} is this machine's default runtime`
      : `${chosen.name} is the only signed-in runtime available`
  };
}
