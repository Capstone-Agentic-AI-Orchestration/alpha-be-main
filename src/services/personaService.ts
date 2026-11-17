import { createHash } from 'node:crypto';

import {
  Agent,
  AgentRole,
  AutonomyLevel,
  ModelProvider,
  ReasoningEffort
} from '../models/index.js';
import { readAgentFile } from './agentFileService.js';
import { composeMemory } from './memoryService.js';
import { describeChatToolPolicy, describeReplyFormat, describeRoster, RosterEntry } from './toolPolicy.js';
import { mcpAccessFor } from './autonomyPolicy.js';
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
  reasoningEffort?: ReasoningEffort;
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
   * Append the tool constraint. On for chat turns, where a persona otherwise
   * describes capability the runner does not actually hand over — in either
   * direction, now that skills grant it per agent. See toolPolicy.
   */
  includeToolPolicy?: boolean;
  /**
   * The other Alpha agents, so this one can answer about its own team.
   *
   * Passed in rather than read here, to keep this module free of the database
   * and testable without it.
   */
  roster?: RosterEntry[];
  /** Per-turn capability override from the chat access selector. */
  skillsOverride?: string[];
  /** Full chat access is the only selector state that enables GitHub writes. */
  autonomyOverride?: AutonomyLevel;
  /**
   * The project's repository memory (AGENTS.md of each repository), already
   * rendered by repositoryMemory.renderProjectMemory. Placed first, so the agent
   * reads it before anything else; Alpha's tool policy still comes last.
   * Opt-in: passed by every caller that works on a project.
   */
  repositoryMemory?: string;
}

/**
 * Merge the database row with its persona file.
 *
 * The file wins for every field it declares; see agentFileService for why that
 * direction and not the reverse.
 */
export function resolveAgent(agent: Agent, options: ResolveOptions = {}): ResolvedPersona {
  const { projectKey, includeMemory = true, includeToolPolicy = false, roster } = options;

  const overlay = readAgentFile(agent.id);
  const merged = {
    ...agent,
    ...(overlay ?? {}),
    ...(options.skillsOverride ? { skills: options.skillsOverride } : {}),
    ...(options.autonomyOverride ? { autonomyLevel: options.autonomyOverride } : {})
  };
  const mcpServers = merged.mcpServers ?? [];
  const skills = merged.skills ?? [];

  const sources: string[] = [overlay ? `agents/${agent.id}.md` : 'alpha.db'];

  const parts: string[] = [];
  const repositoryMemory = options.repositoryMemory?.trim();
  if (repositoryMemory) {
    parts.push(repositoryMemory);
    sources.push('repository-memory');
  }
  const persona = (merged.systemPrompt ?? '').trim();
  if (persona) parts.push(persona);

  if (includeMemory) {
    const memory = composeMemory({ agentId: agent.id, projectKey });
    if (memory.text) {
      parts.push(memory.text);
      sources.push(...memory.sources);
    }
  }

  if (roster?.length) {
    const text = describeRoster(roster, agent.id);
    if (text) {
      parts.push(text);
      sources.push('roster');
    }
  }

  if (includeToolPolicy) {
    // Last, so it is the nearest thing to the turn itself. A persona that says
    // "write the code" and a constraint that says "you cannot" resolve in
    // favour of whichever came last, and the constraint is the true one.
    // The same three inputs the runner builds its argv from, so the sentence
    // the agent reads and the flags it runs under cannot disagree.
    parts.push(
      describeChatToolPolicy(mcpServers, skills, mcpAccessFor(merged.autonomyLevel, 'chat', skills))
    );
    sources.push('tool-policy');

    // What the reply should look like, as opposed to what it may do. Separate
    // section because it is the one part of the prompt with no bearing on what
    // the agent can reach.
    parts.push(describeReplyFormat());
    sources.push('reply-format');
  }

  const systemPrompt = parts.join('\n\n---\n\n');

  return {
    systemPrompt,
    personaHash: createHash('sha256').update(systemPrompt).digest('hex').slice(0, 16),
    name: merged.name,
    role: merged.role,
    modelProvider: merged.modelProvider,
    modelName: merged.modelName,
    reasoningEffort: merged.reasoningEffort ?? undefined,
    autonomyLevel: merged.autonomyLevel,
    temperature: merged.temperature,
    skills,
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
