import path from 'node:path';
import { sqliteService } from './sqliteService.js';
import { runCliTurn } from './cliRunner.js';
import { logError } from '../utils/logger.js';

/**
 * The hidden agent that helps configure other agents.
 *
 * "Build with AI" used to be a `setTimeout` and a table of five keyword-matched
 * personas, so describing anything outside those keywords produced the same
 * frontend specialist every time. This runs a real CLI turn instead, on a
 * runtime the user picked, and keeps the conversation resumable so the draft
 * can be refined across turns rather than generated once and abandoned.
 *
 * The client owns the structured half of the protocol: it encodes the envelope
 * (current draft + the catalogs of legal ids) into the message, and parses the
 * `<agent_draft>` block back out of the reply. Validation belongs there too,
 * because that is where the catalogs live. This service is the transport.
 */

/** Session rows are keyed by (thread, machine, agent); builders have no agent. */
const BUILDER_AGENT_ID = '__agent_builder__';

const BUILDER_SYSTEM_PROMPT = `You are the Agent Builder for Alpha, a workspace where people run autonomous coding agents.

Your job is to interview the user briefly and design ONE agent for them: its name, its one-line specialization, its system instructions, which model and reasoning effort it should use, which skills it should hold, and who may invoke it.

Every user message arrives as a JSON envelope prefixed with ALPHA_AGENT_BUILDER_INPUT. It contains:
  - user_request: what the person actually typed. Reply to this.
  - current_draft: the configuration as it stands right now.
  - available_skills / available_models / available_reasoning_efforts: the ONLY ids you may choose from.

Reply in two parts, in this order:

1. A short, plain reply to the person — two or three sentences. Say what you changed and ask at most one question. Do not paste the configuration back at them; they can see it beside the conversation.

2. Exactly one <agent_draft> block containing compact JSON:

<agent_draft>
{"name":"...","description":"...","instructions":"...","role":"Coder","model":"...","reasoning":"low","skill_ids":["..."],"access":"team"}
</agent_draft>

Rules for the block:
  - Include it in EVERY reply, even when nothing changed — omit only the keys you are not changing.
  - "role" must be one of: Architect, Coder, Reviewer, QA Tester, DevOps Engineer, Researcher, Triager, Research Agent, Architecture Agent, Manager Agent, Database Agent, Backend Agent, Frontend Agent, Mobile Agent, Security / Code Quality Agent, Validation / Checking Agent, GitHub Finalization Agent.
  - "access" must be one of: everyone, team, admins, private.
  - "model" must be an id from available_models, and "skill_ids" must all come from available_skills. Never invent one.
  - "reasoning" must be an id from available_reasoning_efforts, or be omitted to keep Auto. Never invent one.
  - "description" is one line, at most 255 characters.
  - "instructions" is the agent's system prompt: what it does, how it decides, what it must never do. Write it in the second person ("You are...").
  - Keep the JSON on as few lines as you can and never wrap it in a code fence.`;

export interface BuilderTurnResult {
  content: string;
  runtimeId: string;
  provider: string;
  modelName: string;
}

export class AgentBuilderError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Run one builder turn.
 *
 * `sessionId` is minted by the client and is the conversation's identity: it is
 * what makes the second message a continuation of the first rather than a
 * stranger restating the whole draft.
 */
export async function sendBuilderMessage(params: {
  sessionId: string;
  runtimeId: string;
  modelName: string;
  message: string;
}): Promise<BuilderTurnResult> {
  const { sessionId, runtimeId, modelName, message } = params;

  if (!sessionId?.trim()) throw new AgentBuilderError('sessionId is required');
  if (!message?.trim()) throw new AgentBuilderError('message is required');

  const runtime = sqliteService.getRuntimes().find(r => r.id === runtimeId);
  if (!runtime) {
    throw new AgentBuilderError(`Unknown runtime "${runtimeId}". Scan for runtimes first.`);
  }

  if (!['Anthropic', 'OpenAI', 'Antigravity', 'Google Gemini', 'OpenCode'].includes(runtime.provider)) {
    throw new AgentBuilderError('This runtime does not support the conversational builder. Choose a supported CLI runtime.');
  }
  if (runtime.status !== 'online') throw new AgentBuilderError('The builder runtime is unavailable. Connect it on the Runtimes page first.');
  if (!modelName || !runtime.models?.includes(modelName)) {
    throw new AgentBuilderError('Choose an available builder model. Refresh the runtime catalog if it has changed.');
  }
  // The builder's persona is a constant in this file, never a persona file, so
  // it cannot change mid-session and needs no hash comparison.
  const sessionKey = `${BUILDER_AGENT_ID}:${runtimeId}:${modelName}`;
  const priorSession = sqliteService.getThreadSession(sessionId, sessionKey)?.cliSessionId ?? null;

  const turn = await runCliTurn({
    runId: `builder-${Date.now()}`,
    cwd: path.resolve('..'),
    provider: runtime.provider,
    modelName,
    systemPrompt: BUILDER_SYSTEM_PROMPT,
    personaName: 'the Alpha Agent Builder',
    prompt: message,
    priorSession
  });

  if (turn.sessionId) {
    sqliteService.setThreadSession(sessionId, sessionKey, turn.sessionId);
  }

  if (turn.failureKind) {
    const cli = turn.bin.replace('.cmd', '');
    logError('Agent builder turn failed', turn.failureDetail ?? '');
    throw new AgentBuilderError(
      turn.failureKind === 'spawn'
        ? `Could not start ${cli}. ${turn.failureDetail}`
        : `${cli} returned nothing. ${turn.failureDetail} — check it is installed and signed in on the Runtimes page.`,
      502
    );
  }

  return {
    content: turn.content,
    runtimeId: runtime.id,
    provider: runtime.provider,
    modelName
  };
}
