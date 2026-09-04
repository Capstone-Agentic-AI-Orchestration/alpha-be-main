import { ParsedEvent } from './streamParser.js';

/**
 * Assemble one CLI turn's stream events into a reply.
 *
 * Split out of `runCliTurn` so the rule below can be exercised against the
 * captured transcripts in `fixtures/` rather than a live subprocess.
 *
 * ## What counts as the answer
 *
 * The answer is the final contiguous run of text blocks — everything after the
 * last tool call. Text emitted *before* a tool call is narration ("let me check
 * that file"), not part of the reply.
 *
 * The previous behaviour concatenated every text block, so a turn shaped
 *
 *   text → tool_use → text → tool_use → text
 *
 * put all three into the chat bubble, and replies read as an unedited stream of
 * consciousness. `fixtures/claude-stream-sample.jsonl` is exactly this shape.
 *
 * A contiguous *run* rather than simply the last block, because one assistant
 * message can legitimately emit two text blocks in a row with no tool call
 * between them; those belong to the same answer and must not be truncated.
 *
 * Narration is not discarded — it goes to the thinking panel, which is where a
 * reader looking for "what did it actually do" expects to find it.
 */

export interface CliToolRecord {
  id: string;
  toolName: string;
  parameters: Record<string, unknown>;
  status: 'success';
  executedAt: string;
}

export class TurnAccumulator {
  /** Text blocks seen since the last tool call — the answer, so far. */
  private answerRun: string[] = [];

  /**
   * Narration and reasoning in the order it arrived.
   *
   * Kept as tagged entries rather than plain strings because the two are not
   * interchangeable: narration is something the agent said and can stand in as
   * a reply, whereas a thinking block is internal reasoning and must never
   * surface as one. Tagging keeps the panel chronological while letting
   * `getContent` fall back to narration only.
   */
  private process: { kind: 'narration' | 'thinking'; text: string }[] = [];

  private readonly tools: CliToolRecord[] = [];
  private streamError = '';

  accept(event: ParsedEvent): void {
    switch (event.type) {
      case 'log':
        if (event.message) this.answerRun.push(event.message);
        break;

      case 'thinking':
        if (event.thinking) this.process.push({ kind: 'thinking', text: event.thinking });
        break;

      case 'tool_call':
        if (!event.toolName) break;
        // Everything said before a tool call was narration.
        this.flushNarration();
        this.tools.push({
          id: `tool-${Date.now()}-${this.tools.length}`,
          toolName: event.toolName,
          parameters: (event.toolInput as Record<string, unknown>) ?? {},
          status: 'success',
          executedAt: new Date().toISOString()
        });
        break;

      case 'error':
        // The CLI's own error is far more useful than stderr's first line,
        // which is often an unrelated warning.
        if (event.message) this.streamError = event.message;
        break;

      default:
        // tool_result, stage_transition, rate_limit, session, result carry no
        // reply text — the parser surfaces them for the run pipeline.
        break;
    }
  }

  private flushNarration(): void {
    if (!this.answerRun.length) return;
    for (const text of this.answerRun) this.process.push({ kind: 'narration', text });
    this.answerRun = [];
  }

  /** Index of the narration entry `getContent` falls back to, or -1. */
  private fallbackIndex(): number {
    if (this.answerRun.join('').trim()) return -1;

    for (let i = this.process.length - 1; i >= 0; i--) {
      if (this.process[i].kind === 'narration') return i;
    }
    return -1;
  }

  /**
   * The reply.
   *
   * Falls back to the last narration entry when the turn ended on a tool call
   * with no closing text. Reporting "the CLI produced no output" in that case
   * would be worse than showing what it did say, and the caller treats empty
   * content as a failure.
   */
  getContent(): string {
    const answer = this.answerRun.join('\n\n').trim();
    if (answer) return answer;

    const promoted = this.fallbackIndex();
    return promoted === -1 ? '' : this.process[promoted].text.trim();
  }

  /** Narration and reasoning, or `fallback` when the turn produced neither. */
  getThinking(fallback: string): string {
    // When getContent fell back to a narration entry, that entry is the reply —
    // leaving it here too would show the same text in both places.
    const promoted = this.fallbackIndex();

    return (
      this.process
        .filter((_, i) => i !== promoted)
        .map(entry => entry.text)
        .join('\n\n')
        .trim() || fallback
    );
  }

  getTools(): CliToolRecord[] {
    return this.tools;
  }

  getStreamError(): string {
    return this.streamError;
  }
}
