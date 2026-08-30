import { StageId } from '../models/index.js';
import { EXECUTION_LIMITS } from '../config/constants.js';

/**
 * Claude Code `--output-format stream-json --verbose` event schema.
 *
 * Verified 2026-08-22 against claude 2.1.238 by capturing a real run; the
 * transcript is committed at fixtures/claude-stream-sample.jsonl and replayed
 * by streamParser.test.ts.
 *
 * The important detail, and the one an earlier version of this file got wrong:
 * tool_use / tool_result / text / thinking are NOT top-level event types. They
 * are content blocks NESTED inside an assistant or user message:
 *
 *   { "type": "system",    "subtype": "init" | "hook_started" | "hook_response" | ... }
 *   { "type": "assistant", "message": { "content": [ { "type": "text" },
 *                                                    { "type": "tool_use", "name": "Read" },
 *                                                    { "type": "thinking" } ] } }
 *   { "type": "user",      "message": { "content": [ { "type": "tool_result" } ] } }
 *   { "type": "rate_limit_event", ... }
 *   { "type": "result",    "subtype": "success", "session_id": "...",
 *                          "total_cost_usd": 0.75, "usage": { ... }, "num_turns": 2 }
 *
 * Matching on a top-level `type === 'tool_use'` silently drops every event and
 * produces a run that never advances a stage. Do not "simplify" this back.
 */

export type StreamFamily = 'claude' | 'codex' | 'antigravity';

export interface RunTelemetry {
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  stopReason?: string;
  isError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ParsedEvent {
  type:
    | 'log'
    | 'tool_call'
    | 'tool_result'
    | 'stage_transition'
    | 'error'
    | 'thinking'
    | 'rate_limit'
    | 'session'
    | 'result';
  stage?: StageId;
  message?: string;
  toolName?: string;
  toolInput?: any;
  toolOutput?: any;
  thinking?: string;
  /** Populated on 'session' and 'result'. */
  telemetry?: RunTelemetry;
}

export function compactToolOutput(
  output: string,
  maxLines = EXECUTION_LIMITS.MAX_OUTPUT_LINES_FOR_CONTEXT
): string {
  const lines = output.split('\n');
  if (lines.length <= maxLines) return output;
  const head = lines.slice(0, 40).join('\n');
  const tail = lines.slice(-40).join('\n');
  return `${head}\n\n... [${lines.length - 80} lines omitted for context efficiency] ...\n\n${tail}`;
}

/**
 * Codex nests the provider's JSON error inside a string field, so the raw value
 * is an unreadable escaped blob. Pull out the human sentence when it is there.
 */
function extractCodexError(raw: unknown): string {
  const text = String(raw ?? 'Codex run failed');
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message ?? parsed?.message ?? text);
  } catch {
    return text;
  }
}

export class StreamParser {
  private currentStage: StageId = 'workspace';
  private sessionId?: string;
  /** Guards against emitting the final message twice — see handleResult. */
  private sawAssistantText = false;
  /** Accumulates Antigravity's `text_delta` fragments until its step completes. */
  private antigravityText = '';
  /** Event types seen that no branch handled — surfaced by tests, not swallowed. */
  private readonly unhandled = new Set<string>();

  constructor(private readonly family: StreamFamily = 'claude') {}

  public parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed);
        switch (this.family) {
          case 'codex':       return this.handleCodexEvent(json);
          case 'antigravity': return this.handleAntigravityEvent(json);
          default:            return this.handleClaudeEvent(json);
        }
      } catch {
        // Truncated or non-JSON line — fall through to the text heuristics.
      }
    }

    return this.handleRawTextLine(trimmed);
  }

  // ─── Claude Code ───────────────────────────────────────────────────────────

  private handleClaudeEvent(json: any): ParsedEvent[] {
    switch (json?.type) {
      case 'system':
        return this.handleSystem(json);
      case 'assistant':
        return this.handleContentBlocks(json?.message?.content, 'assistant');
      case 'user':
        return this.handleContentBlocks(json?.message?.content, 'user');
      case 'rate_limit_event':
        return [
          {
            type: 'rate_limit',
            stage: this.currentStage,
            message: 'Provider rate limit signalled — backing off'
          }
        ];
      case 'result':
        return this.handleResult(json);
      case 'stream_event':
        // Partial deltas, only present with includePartialMessages. Ignored:
        // the completed assistant message carries the same content.
        return [];
      default:
        if (json?.type) this.unhandled.add(String(json.type));
        return [];
    }
  }

  private handleSystem(json: any): ParsedEvent[] {
    if (json.subtype !== 'init') return [];
    this.sessionId = json.session_id;
    return [
      {
        type: 'session',
        stage: this.currentStage,
        message: `Session ${json.session_id ?? 'unknown'} initialised`,
        telemetry: { sessionId: json.session_id }
      }
    ];
  }

  /** Walks the content blocks nested inside an assistant or user message. */
  private handleContentBlocks(content: unknown, role: 'assistant' | 'user'): ParsedEvent[] {
    if (!Array.isArray(content)) return [];
    const events: ParsedEvent[] = [];

    for (const block of content) {
      switch (block?.type) {
        case 'text': {
          const text = String(block.text ?? '').trim();
          if (text) {
            this.sawAssistantText = true;
            events.push({ type: 'log', stage: this.currentStage, message: text });
          }
          break;
        }

        case 'thinking': {
          const thinking = String(block.thinking ?? '').trim();
          if (thinking) events.push({ type: 'thinking', stage: this.currentStage, thinking });
          break;
        }

        case 'tool_use': {
          const toolName = String(block.name ?? 'tool');
          const toolInput = block.input ?? {};

          const mapped = this.mapToolToStage(toolName, toolInput);
          if (mapped && mapped !== this.currentStage) {
            this.currentStage = mapped;
            events.push({ type: 'stage_transition', stage: mapped });
          }

          events.push({
            type: 'tool_call',
            stage: this.currentStage,
            toolName,
            toolInput,
            message: `Executing ${toolName}`
          });
          break;
        }

        case 'tool_result': {
          const raw = block.content;
          const text =
            typeof raw === 'string'
              ? raw
              : Array.isArray(raw)
                ? raw.map((c: any) => c?.text ?? '').join('\n')
                : JSON.stringify(raw ?? '');

          events.push({
            type: block.is_error ? 'error' : 'tool_result',
            stage: this.currentStage,
            message: compactToolOutput(text)
          });
          break;
        }

        default:
          if (block?.type) this.unhandled.add(`${role}.content.${block.type}`);
      }
    }

    return events;
  }

  private handleResult(json: any): ParsedEvent[] {
    const usage = json.usage ?? {};
    const telemetry: RunTelemetry = {
      sessionId: json.session_id ?? this.sessionId,
      costUsd: json.total_cost_usd,
      numTurns: json.num_turns,
      durationMs: json.duration_ms,
      stopReason: json.stop_reason,
      isError: Boolean(json.is_error),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens
    };

    const events: ParsedEvent[] = [];

    if (json.is_error) {
      events.push({
        type: 'error',
        stage: this.currentStage,
        message: String(json.result ?? json.subtype ?? 'Run failed')
      });
    } else if (
      typeof json.result === 'string' &&
      json.result.trim() &&
      // `result.result` restates the final assistant message. Emitting both
      // makes every reply appear twice, so only use it when the assistant
      // produced no text of its own (a tool-only turn).
      !this.sawAssistantText
    ) {
      events.push({ type: 'log', stage: this.currentStage, message: json.result.trim() });
    }

    events.push({
      type: 'result',
      stage: this.currentStage,
      message: `Run ${json.subtype ?? 'finished'}`,
      telemetry
    });

    return events;
  }

  // ─── Antigravity (agy) ─────────────────────────────────────────────────────

  /**
   * Google Antigravity's `agy -p … --output-format stream-json`.
   *
   * Verified 2026-08-23 against agy 1.1.18; transcript committed at
   * fixtures/antigravity-stream-sample.jsonl.
   *
   * Nothing about this matches Claude Code. The discriminator is `event`, not
   * `type`, and assistant text arrives as incremental `text_delta` fragments on
   * `agent_response` steps rather than as a finished block:
   *
   *   { "event": "init",        "conversation_id": "…", "init": { "cwd": … } }
   *   { "event": "step_update", "step_update": { "step_index": 2, "state": "ACTIVE",
   *                                              "step_type": "agent_response",
   *                                              "text_delta": "PONG" } }
   *   { "event": "result",      "result": { "status": "SUCCESS", "response": "PONG",
   *                                         "num_turns": 1, "usage": { … } } }
   *
   * Because deltas are fragments, they are concatenated rather than emitted as
   * separate log lines — otherwise a reply arrives one word per row.
   */
  private handleAntigravityEvent(json: any): ParsedEvent[] {
    switch (json?.event) {
      case 'init':
        this.sessionId = json.conversation_id;
        return [{
          type: 'session',
          stage: this.currentStage,
          message: `Antigravity conversation ${json.conversation_id ?? 'unknown'}`,
          telemetry: { sessionId: json.conversation_id }
        }];

      case 'step_update':
        return this.handleAntigravityStep(json.step_update ?? {});

      case 'result': {
        const r = json.result ?? {};
        const usage = r.usage ?? {};
        const events: ParsedEvent[] = [];

        if (r.status && r.status !== 'SUCCESS') {
          events.push({
            type: 'error',
            stage: this.currentStage,
            message: `Antigravity run ended with status ${r.status}`
          });
        } else if (!this.sawAssistantText && typeof r.response === 'string' && r.response.trim()) {
          events.push({ type: 'log', stage: this.currentStage, message: r.response.trim() });
        }

        events.push({
          type: 'result',
          stage: this.currentStage,
          message: `Run ${String(r.status ?? 'finished').toLowerCase()}`,
          telemetry: {
            sessionId: r.conversation_id ?? this.sessionId,
            numTurns: r.num_turns,
            durationMs: r.duration_seconds ? Math.round(r.duration_seconds * 1000) : undefined,
            isError: r.status !== undefined && r.status !== 'SUCCESS',
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens
          }
        });
        return events;
      }

      default:
        if (json?.event) this.unhandled.add('antigravity.' + String(json.event));
        return [];
    }
  }

  private handleAntigravityStep(step: any): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    const kind = String(step.step_type ?? '');

    // Assistant prose, streamed a fragment at a time.
    if (kind === 'agent_response') {
      if (typeof step.text_delta === 'string' && step.text_delta) {
        this.sawAssistantText = true;
        this.antigravityText += step.text_delta;
      }

      /**
       * Flush on DONE whether or not THIS event carried a delta.
       *
       * The delta and the completion do not have to arrive together. When a
       * DONE came through with no `text_delta`, the old condition skipped this
       * branch entirely: the step fell through to the bottom, was recorded as
       * an unhandled `antigravity.step.agent_response`, and everything already
       * accumulated in `antigravityText` was dropped — the agent's whole reply
       * silently vanished and the turn reported "the CLI produced no output".
       *
       * fixtures/antigravity-stream-sample.jsonl happens to carry a delta on
       * its DONE, which is why the tests never caught this; the unhandled-type
       * log from a real run is what surfaced it.
       */
      if (step.state === 'DONE') {
        const text = this.antigravityText.trim();
        this.antigravityText = '';
        if (text) events.push({ type: 'log', stage: this.currentStage, message: text });
      }
      return events;
    }

    // Tool activity. The exact step_type set is not fully documented, so map
    // what is recognisable and record the rest instead of silently dropping it.
    if (kind === 'tool_call' || kind === 'tool_use' || step.tool_name) {
      /**
       * One event per tool call, not one per state change.
       *
       * Antigravity reports the same step twice — `state: 'ACTIVE'` when the
       * tool starts and `state: 'DONE'` when it finishes — and this branch had
       * no state check, so every tool call was recorded twice. A run log read
       * as though the agent had run each command two times.
       *
       * ACTIVE is the one to keep: it is the moment the call is made, which is
       * what a live run log wants. A step with no state at all still emits, so
       * a shape that does not use the field is not silently dropped.
       */
      if (step.state === 'DONE') return events;

      const toolName = String(step.tool_name ?? kind);
      /**
       * Antigravity puts the arguments under `tool_info.parameters`, not
       * `tool_input`.
       *
       * Reading only `tool_input` meant every Antigravity tool call carried an
       * empty argument object: the UI's tool chips showed a bare name with no
       * detail, and `mapToolToStage` — which decides the run stage by looking
       * at the arguments — was choosing from nothing. `tool_input` is kept as
       * a fallback since the schema is not documented and may vary.
       */
      const toolInput = step.tool_info?.parameters ?? step.tool_input ?? {};

      const mapped = this.mapToolToStage(toolName, toolInput);
      if (mapped && mapped !== this.currentStage) {
        this.currentStage = mapped;
        events.push({ type: 'stage_transition', stage: mapped });
      }
      events.push({
        type: 'tool_call',
        stage: this.currentStage,
        toolName,
        toolInput,
        message: `Executing ${toolName}`
      });
      return events;
    }

    if (kind && kind !== 'user_input' && kind !== 'checkpoint') {
      this.unhandled.add('antigravity.step.' + kind);
    }
    return events;
  }

  // ─── Codex ─────────────────────────────────────────────────────────────────

  /**
   * `codex exec --json`.
   *
   * Verified 2026-08-23 against codex-cli 0.144.1; transcript committed at
   * fixtures/codex-stream-sample.jsonl.
   *
   *   { "type": "thread.started", "thread_id": "…" }
   *   { "type": "turn.started" }
   *   { "type": "item.completed", "item": { "id": "item_0", "type": "…", … } }
   *   { "type": "error",       "message": "…" }
   *   { "type": "turn.failed", "error": { "message": "…" } }
   *
   * Note that `item.completed` with `item.type === 'error'` is a NON-FATAL
   * warning (model-metadata notices, truncated skill descriptions). Only a
   * top-level `error` or `turn.failed` ends the run — conflating the two would
   * report a healthy turn as broken.
   */
  private handleCodexEvent(json: any): ParsedEvent[] {
    switch (json?.type) {
      case 'thread.started':
        this.sessionId = json.thread_id;
        return [{
          type: 'session',
          stage: this.currentStage,
          message: `Codex thread ${json.thread_id ?? 'unknown'}`,
          telemetry: { sessionId: json.thread_id }
        }];

      case 'turn.started':
        return [];

      case 'item.completed':
        return this.handleCodexItem(json.item ?? {});

      case 'error':
        return [{
          type: 'error',
          stage: this.currentStage,
          message: extractCodexError(json.message)
        }];

      case 'turn.failed':
        return [{
          type: 'error',
          stage: this.currentStage,
          message: extractCodexError(json.error?.message)
        }];

      case 'turn.completed':
        return [{
          type: 'result',
          stage: this.currentStage,
          message: 'Run completed',
          telemetry: {
            sessionId: this.sessionId,
            inputTokens: json.usage?.input_tokens,
            outputTokens: json.usage?.output_tokens,
            isError: false
          }
        }];

      default:
        if (json?.type) this.unhandled.add('codex.' + String(json.type));
        return [];
    }
  }

  private handleCodexItem(item: any): ParsedEvent[] {
    const kind = String(item.type ?? '');

    if (kind === 'agent_message' || kind === 'assistant_message') {
      const text = String(item.text ?? item.message ?? '').trim();
      if (!text) return [];
      this.sawAssistantText = true;
      return [{ type: 'log', stage: this.currentStage, message: text }];
    }

    if (kind === 'reasoning') {
      const text = String(item.text ?? '').trim();
      return text ? [{ type: 'thinking', stage: this.currentStage, thinking: text }] : [];
    }

    if (kind === 'command_execution' || kind === 'file_change') {
      const toolName = kind === 'file_change' ? 'Edit' : 'Bash';
      const input = kind === 'file_change' ? {} : { command: item.command ?? '' };
      const mapped = this.mapToolToStage(toolName, input);
      const events: ParsedEvent[] = [];
      if (mapped && mapped !== this.currentStage) {
        this.currentStage = mapped;
        events.push({ type: 'stage_transition', stage: mapped });
      }
      events.push({ type: 'tool_call', stage: this.currentStage, toolName, toolInput: input });
      return events;
    }

    // Non-fatal notice, not a failure — logged, never surfaced as an error.
    if (kind === 'error') {
      return [{
        type: 'log',
        stage: this.currentStage,
        message: `[codex] ${String(item.message ?? '').slice(0, 300)}`
      }];
    }

    if (kind) this.unhandled.add('codex.item.' + kind);
    return [];
  }

  // ─── Shared ────────────────────────────────────────────────────────────────

  private handleRawTextLine(line: string): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    const lower = line.toLowerCase();

    if (lower.includes('checkout') || lower.includes('branch') || lower.includes('workspace')) {
      if (this.currentStage !== 'workspace') {
        this.currentStage = 'workspace';
        events.push({ type: 'stage_transition', stage: 'workspace' });
      }
    } else if (
      lower.includes('reading') || lower.includes('searching') ||
      lower.includes('grep') || lower.includes('glob') || lower.includes('analyzing')
    ) {
      if (this.currentStage === 'workspace') {
        this.currentStage = 'analysis';
        events.push({ type: 'stage_transition', stage: 'analysis' });
      }
    } else if (
      lower.includes('writing') || lower.includes('editing') || lower.includes('patching') ||
      lower.includes('created file') || lower.includes('modified')
    ) {
      if (this.currentStage === 'workspace' || this.currentStage === 'analysis') {
        this.currentStage = 'implementation';
        events.push({ type: 'stage_transition', stage: 'implementation' });
      }
    } else if (
      lower.includes('npm test') || lower.includes('vitest') ||
      lower.includes('pytest') || lower.includes('tests passed') || lower.includes('test failed')
    ) {
      if (this.currentStage !== 'tests') {
        this.currentStage = 'tests';
        events.push({ type: 'stage_transition', stage: 'tests' });
      }
    }

    events.push({ type: 'log', stage: this.currentStage, message: line });
    return events;
  }

  private mapToolToStage(toolName: string, input: any): StageId | null {
    const name = toolName.toLowerCase();

    if (name.includes('read') || name.includes('grep') || name.includes('glob') ||
        name.includes('list') || name.includes('search')) {
      return 'analysis';
    }

    if (name.includes('write') || name.includes('edit') || name.includes('patch') ||
        name.includes('replace') || name.includes('delete') || name.includes('notebook')) {
      return 'implementation';
    }

    if (name.includes('bash') || name.includes('exec') || name.includes('test')) {
      const cmd = String(input?.command ?? '').toLowerCase();
      if (/\b(test|vitest|jest|pytest|go test|cargo test|mvn test)\b/.test(cmd)) return 'tests';
      return 'implementation';
    }

    return null;
  }

  public getCurrentStage(): StageId {
    return this.currentStage;
  }

  public getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Event types no branch handled. Empty is the healthy state. */
  public getUnhandledTypes(): string[] {
    return [...this.unhandled];
  }
}
