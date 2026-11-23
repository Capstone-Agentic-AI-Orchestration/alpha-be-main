import { ReasoningEffort, RuntimeEngine } from '../models/index.js';

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
 * How Alpha explains the product, to anyone. A question about what a project is used to get a
 * file-by-file code report; the product's own records answer it, in the person's terms. Shared by
 * the team and client prompts, so both follow the same no-guessing rule.
 */
const EXPLAIN_RULES = [
  '- Lead with what the product is for, who uses it and what they can do with it. Then what is done, what is planned and what is still undecided.',
  '- No file paths, frameworks, libraries or configuration names unless the person asks for them. Offer the technical detail as a follow-up instead.',
  '- Never guess. When something is not in these records, say it is not recorded ("The brief only says it is an informational website; there is no detail yet on pages or audience"). Do not fill the gap with what a project like this usually has.'
];

export const HOW_TO_EXPLAIN = [
  '## How to explain',
  '',
  'Questions about what this project is, does or is for, or what is planned or done, are answered from the product picture: Alpha\'s own records of the brief, the board, requests and decisions. Use plain language.',
  ...EXPLAIN_RULES,
  '- Name old or conflicting records as such ("the board still lists the expense-tracker cards, which conflicts with the brief").',
  '- Look at the code only to say what a user can actually see and do today, and say it in those terms ("the site shows a placeholder heading").'
].join('\n');

/**
 * What the plain assistant is told about itself.
 *
 * Short on purpose. The point of the default is that it is *not* a persona, so
 * this establishes only what it is and what it must not pretend to be, and how
 * it explains the product.
 */
export const DEFAULT_ASSISTANT_PROMPT = [
  '## You are Alpha',
  '',
  'You are Alpha itself, answering directly. You are not one of the configured',
  'agents and must not adopt any of their names or personas.',
  '',
  'Users can address a specific agent with an @mention. When acting as the',
  'Orchestrator, select and hand off specialist work through the routing rules',
  'rather than answering on that agent\'s behalf. Never impersonate a specialist.',
  '',
  HOW_TO_EXPLAIN
].join('\n');

/**
 * Alpha's prompt for a client. Clients see nothing about how the work is done, so this names
 * none of it: it talks about the product, from the brief, and nothing else.
 */
export const CLIENT_ASSISTANT_PROMPT = [
  '## You are Alpha',
  '',
  'You are Alpha, answering a client about their own project in plain language.',
  'What is recorded for you here is the project brief (the "About" section). Answer from it.',
  ...EXPLAIN_RULES,
  '- Talk only about the product itself. Say nothing about how the work behind it is organised or carried out, or who or what carries it out.'
].join('\n');

/** Who Alpha is talking to, in the terms the explanation should use. */
const TEAM_AUDIENCE: Record<'pm' | 'dev' | 'admin', string> = {
  pm: 'You are talking to a project manager: use product terms. When something is not recorded, suggest adding it to the brief or the board.',
  dev: 'You are talking to a developer: product terms first, then technical detail where it helps. When something is not recorded, suggest adding it to the brief or the board.',
  admin: 'You are talking to a workspace admin on the project team: product terms first, then technical detail where it helps. When something is not recorded, suggest adding it to the brief or the board.'
};

/**
 * Alpha's own prompt for one reader. A team role gets the Orchestrator's prompt and the line for
 * its role; a client, or a role Alpha does not know, gets the client prompt (it shows the least).
 */
export function assistantPromptFor(role: string | undefined): string {
  if (role !== 'pm' && role !== 'dev' && role !== 'admin') return CLIENT_ASSISTANT_PROMPT;
  return `${DEFAULT_ASSISTANT_PROMPT}\n${TEAM_AUDIENCE[role]}`;
}

/**
 * The runtime and model this reply runs on, as Alpha chose it.
 *
 * A model cannot reliably name itself: its training predates its own release
 * name, and the CLI does not tell it which model the account selected. Alpha
 * does know, so it says so, and the agent can answer "which model are you"
 * truthfully instead of guessing or refusing.
 */
export function describeRuntimeModel(runtime: { provider: string; modelName: string; name?: string; reasoningEffort?: string | null }): string {
  const via = runtime.name && runtime.name !== runtime.provider ? `${runtime.name} (${runtime.provider})` : runtime.provider;
  const effort = runtime.reasoningEffort ? `, ${runtime.reasoningEffort} reasoning effort` : '';
  return [
    '## Your runtime',
    `This reply runs through ${via} with the model ${runtime.modelName}${effort}, as selected in Alpha.`,
    'If someone asks which model or runtime you are using, answer with exactly this. It comes from Alpha\'s settings, which are more reliable than your own sense of which model you are.'
  ].join('\n');
}

export interface DefaultAssistantRuntime {
  provider: string;
  modelName: string;
  endpoint?: string;
  /** The runtime's display name, for the note shown when Alpha switches runtime. */
  name?: string;
  /** Set when the Orchestrator's own setting chose this runtime. */
  reasoningEffort?: ReasoningEffort | null;
  /** Why this runtime was chosen, for the log and for an error message. */
  reason: string;
}

/** The Orchestrator agent's model, which Alpha answers with when it can. */
export interface PreferredAssistantModel {
  provider: string;
  modelName: string;
  reasoningEffort?: ReasoningEffort | null;
  agentName: string;
}

/**
 * Every runtime Alpha may answer with, best first.
 *
 * The Orchestrator's own model leads: it is the agent shown at the centre of
 * the chat, so changing its model is how someone changes who answers. Then the
 * machine's default runtime, then the other signed-in ones, one per provider,
 * so a provider whose plan is used up can be skipped for the next.
 */
export function defaultAssistantCandidates(
  runtimes: RuntimeEngine[],
  preferred?: PreferredAssistantModel
): DefaultAssistantRuntime[] {
  const usable = runtimes.filter(r => r.status === 'online' && (r.models ?? []).length);
  const candidates: DefaultAssistantRuntime[] = [];

  if (preferred) {
    const runtime = usable.find(r => r.provider === preferred.provider);
    if (runtime && runtime.models.includes(preferred.modelName)) {
      candidates.push({
        provider: runtime.provider,
        modelName: preferred.modelName,
        endpoint: runtime.endpoint,
        name: runtime.name,
        reasoningEffort: preferred.reasoningEffort ?? null,
        reason: `${preferred.agentName} is set to ${preferred.modelName} on ${runtime.name}`
      });
    }
  }

  const ordered = [
    ...usable.filter(r => r.isDefault),
    // Deterministic rather than whatever order the scan returned, so the same
    // machine does not answer from a different model run to run.
    ...[...usable].filter(r => !r.isDefault).sort((a, b) => a.provider.localeCompare(b.provider))
  ];
  for (const runtime of ordered) {
    if (candidates.some(candidate => candidate.provider === runtime.provider)) continue;
    const first = candidates.length === 0;
    candidates.push({
      provider: runtime.provider,
      modelName: runtime.models[0],
      endpoint: runtime.endpoint,
      name: runtime.name,
      reason: runtime.isDefault
        ? `${runtime.name} is this machine's default runtime`
        : first
          ? `${runtime.name} is the only signed-in runtime available`
          : `${runtime.name} is another signed-in runtime`
    });
  }
  return candidates;
}

/**
 * Providers whose plan said it was used up, until when, and in its own words.
 *
 * In memory on purpose: a restart simply tries again. While one is marked,
 * Alpha asks the other runtimes first instead of spending a turn on it.
 */
const usageLimited = new Map<string, { until: number; detail: string }>();
const USAGE_LIMIT_PAUSE_MS = 60 * 60 * 1000;

export function markUsageLimited(provider: string, detail: string, now = Date.now()): void {
  usageLimited.set(provider, { until: now + USAGE_LIMIT_PAUSE_MS, detail });
}

export function usageLimitFor(provider: string, now = Date.now()): string | null {
  const entry = usageLimited.get(provider);
  if (!entry) return null;
  if (entry.until <= now) {
    usageLimited.delete(provider);
    return null;
  }
  return entry.detail;
}

export function clearUsageLimit(provider: string): void {
  usageLimited.delete(provider);
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
  return defaultAssistantCandidates(runtimes)[0] ?? null;
}
