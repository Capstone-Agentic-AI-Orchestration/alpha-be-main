import { createHash } from 'node:crypto';

import { Agent, AgentRole, AutonomyLevel, ModelProvider } from '../models/index.js';
import { readAgentFile } from './agentFileService.js';
import { composeMemory } from './memoryService.js';
import { describeChatToolPolicy } from './toolPolicy.js';
import { logInfo } from '../utils/logger.js';

/**
 * Resolve an agent into the values a CLI turn actually needs.
 *
 * One place answers "what is this agent, right now": the database row overlaid
 * with its persona file, plus whichever memory tiers apply. Both callers of
 * `runCliTurn` need that, and the alternative — each assembling it — is how the
 * chat path and the run path drift into behaving differently.
 *
 * ## Order matters
 *
 * The persona comes first and the standing context after it, because the last
 * thing in a prompt carries the most weight and standing rules should override
 * persona flavour, not the other way round. A persona that says "be terse" and a
 * preferences file that says "always explain your reasoning" resolves to the
 * preferences file, which is the tier the user edits deliberately.
 */

export interface ResolvedPersona {
  /** Composed prompt for `--append-system-prompt`. Empty when there is nothing. */
  systemPrompt: string;
  /** Name the model should answer to on CLI families with no system-prompt flag. */
  name: string;
  role: AgentRole;
  modelProvider: ModelProvider;
  modelName: string;
  autonomyLevel: AutonomyLevel;
  temperature?: number;
  skills: string[];
  mcpServers: string[];
  /** What contributed, for logging: 'file' / 'db' plus each memory path. */
  sources: string[];
  /**
   * Fingerprint of `systemPrompt`.
   *
   * Stored against a CLI session so a later turn can tell whether the agent's
   * instructions changed underneath a conversation already in progress. Covers
   * the memory tiers as well as the persona, because an edit to a preferences
   * file is just as invisible mid-session as an edit to the persona itself.
   */
  personaHash: string;
}

export interface ResolveOptions {
  /** `Project.key`. Omit for chat threads, which belong to no project. */
  projectKey?: string;
  /** Skip the memory tiers — used by callers that are not a persona run. */
  includeMemory?: boolean;
  /**
   * Append the read-only tool constraint. On for chat turns, where the seeded
   * personas otherwise promise writes the runner denies — see toolPolicy.
   */
  includeToolPolicy?: boolean;
}

/**
 * Merge the database row with its persona file.
 *
 * The file wins for every field it declares; see agentFileService for why that
 * direction and not the reverse.
 */
export function resolveAgent(agent: Agent, options: ResolveOptions = {}): ResolvedPersona {
  const { projectKey, includeMemory = true, includeToolPolicy = false } = options;

  const overlay = readAgentFile(agent.id);
  const merged = { ...agent, ...(overlay ?? {}) };
  const mcpServers = merged.mcpServers ?? [];

  const sources: string[] = [overlay ? `agents/${agent.id}.md` : 'alpha.db'];

  const parts: string[] = [];
  const persona = (merged.systemPrompt ?? '').trim();
  if (persona) parts.push(persona);

  if (includeMemory) {
    const memory = composeMemory({ agentId: agent.id, projectKey });
    if (memory.text) {
      parts.push(memory.text);
      sources.push(...memory.sources);
    }
  }

  if (includeToolPolicy) {
    // Last, so it is the nearest thing to the turn itself. A persona that says
    // "write the code" and a constraint that says "you cannot" resolve in
    // favour of whichever came last, and the constraint is the true one.
    parts.push(describeChatToolPolicy(mcpServers));
    sources.push('tool-policy');
  }

  const systemPrompt = parts.join('\n\n---\n\n');

  return {
    systemPrompt,
    personaHash: createHash('sha256').update(systemPrompt).digest('hex').slice(0, 16),
    name: merged.name,
    role: merged.role,
    modelProvider: merged.modelProvider,
    modelName: merged.modelName,
    autonomyLevel: merged.autonomyLevel,
    temperature: merged.temperature,
    skills: merged.skills ?? [],
    mcpServers,
    sources
  };
}

/**
 * Same as `resolveAgent`, with a line in the log saying what went into the
 * prompt. Worth having on the chat and run paths: "why did the agent ignore
 * that rule" is otherwise unanswerable after the fact.
 */
export function resolveAgentLogged(agent: Agent, options: ResolveOptions = {}): ResolvedPersona {
  const resolved = resolveAgent(agent, options);

  logInfo(
    `Persona ${agent.id}: ${resolved.systemPrompt.length} chars from ${resolved.sources.join(' + ')}`
  );

  return resolved;
}
