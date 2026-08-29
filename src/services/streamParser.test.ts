import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { StreamParser, ParsedEvent } from './streamParser.js';

// Resolved from the package root — vitest runs there. Avoids `import.meta`,
// which tsc rejects while the build still targets CommonJS.
const FIXTURE = path.resolve(process.cwd(), 'fixtures/claude-stream-sample.jsonl');

/**
 * Replays a real `claude -p --output-format stream-json --verbose` transcript,
 * captured 2026-08-22 from claude 2.1.238.
 *
 * This exists because the original parser matched on top-level `type: 'tool_use'`
 * and therefore dropped 14 of 14 real events — a run that started and never
 * advanced. Any future change that reintroduces that bug fails here.
 */
function replay(): { events: ParsedEvent[]; parser: StreamParser; lines: number } {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const parser = new StreamParser('claude');
  const events = lines.flatMap((l) => parser.parseLine(l));
  return { events, parser, lines: lines.length };
}

describe('StreamParser — real Claude Code transcript', () => {
  it('reads the committed fixture', () => {
    expect(fs.existsSync(FIXTURE)).toBe(true);
    expect(replay().lines).toBeGreaterThan(0);
  });

  it('leaves no event type unhandled', () => {
    const { parser } = replay();
    // The regression guard. An empty set means every real event hit a branch.
    expect(parser.getUnhandledTypes()).toEqual([]);
  });

  it('produces events rather than silently dropping the stream', () => {
    const { events } = replay();
    expect(events.length).toBeGreaterThan(0);
  });

  it('extracts tool_use nested inside assistant message content', () => {
    const { events } = replay();
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls.length).toBeGreaterThan(0);
    // The fixture's agent reads a file.
    expect(calls.map((c) => c.toolName)).toContain('Read');
  });

  it('advances out of the workspace stage on the first read tool', () => {
    const { events, parser } = replay();
    const transitions = events.filter((e) => e.type === 'stage_transition');
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions[0].stage).toBe('analysis');
    expect(parser.getCurrentStage()).not.toBe('workspace');
  });

  it('extracts tool_result nested inside user message content', () => {
    const { events } = replay();
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('captures the session id from the system init event', () => {
    const { events, parser } = replay();
    const session = events.find((e) => e.type === 'session');
    expect(session?.telemetry?.sessionId).toBeTruthy();
    expect(parser.getSessionId()).toBe(session?.telemetry?.sessionId);
  });

  it('captures cost and token telemetry from the result event', () => {
    const { events } = replay();
    const result = events.find((e) => e.type === 'result');
    expect(result).toBeDefined();

    const t = result!.telemetry!;
    expect(typeof t.costUsd).toBe('number');
    expect(typeof t.numTurns).toBe('number');
    expect(typeof t.inputTokens).toBe('number');
    expect(typeof t.outputTokens).toBe('number');
    expect(t.isError).toBe(false);
  });
});

describe('StreamParser — real Antigravity transcript', () => {
  const AGY = path.resolve(process.cwd(), 'fixtures/antigravity-stream-sample.jsonl');

  function replayAgy() {
    const lines = fs.readFileSync(AGY, 'utf8').split('\n').filter(l => l.trim());
    const parser = new StreamParser('antigravity');
    return { events: lines.flatMap(l => parser.parseLine(l)), parser };
  }

  it('reads the committed fixture', () => {
    expect(fs.existsSync(AGY)).toBe(true);
  });

  it('leaves no event unhandled', () => {
    expect(replayAgy().parser.getUnhandledTypes()).toEqual([]);
  });

  it('captures the conversation id from the init event', () => {
    const { events, parser } = replayAgy();
    expect(events.find(e => e.type === 'session')?.telemetry?.sessionId).toBeTruthy();
    expect(parser.getSessionId()).toBeTruthy();
  });

  it('joins text_delta fragments into one message rather than one per fragment', () => {
    const logs = replayAgy().events.filter(e => e.type === 'log');
    // The fixture streams "PONG" then "\n" across two deltas of the same step.
    expect(logs.length).toBe(1);
    expect(logs[0].message).toBe('PONG');
  });

  it('captures token usage from the result event', () => {
    const result = replayAgy().events.find(e => e.type === 'result');
    expect(result).toBeDefined();
    expect(result!.telemetry?.inputTokens).toBeGreaterThan(0);
    expect(result!.telemetry?.outputTokens).toBeGreaterThan(0);
    expect(result!.telemetry?.isError).toBe(false);
  });

  it('does not confuse the two schemas — claude parser drops agy events', () => {
    // Guards against wiring a runtime to the wrong family: `event`-keyed
    // Antigravity lines must not silently parse as Claude ones.
    const p = new StreamParser('claude');
    const line = fs.readFileSync(AGY, 'utf8').split('\n').filter(l => l.trim())[0];
    expect(p.parseLine(line)).toEqual([]);
  });
});

describe('StreamParser — real Codex transcript', () => {
  const CODEX = path.resolve(process.cwd(), 'fixtures/codex-stream-sample.jsonl');

  function replayCodex() {
    const lines = fs.readFileSync(CODEX, 'utf8').split('\n').filter(l => l.trim());
    const parser = new StreamParser('codex');
    return { events: lines.flatMap(l => parser.parseLine(l)), parser };
  }

  it('leaves no event unhandled', () => {
    expect(replayCodex().parser.getUnhandledTypes()).toEqual([]);
  });

  it('captures the thread id', () => {
    expect(replayCodex().parser.getSessionId()).toBeTruthy();
  });

  it('unwraps the provider error from its nested JSON string', () => {
    const errors = replayCodex().events.filter(e => e.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    // Raw value is an escaped JSON blob; the readable sentence must survive.
    expect(errors[0].message).toContain('not supported when using Codex');
    expect(errors[0].message).not.toContain('\\"');
  });

  it('treats item.completed errors as warnings, not failures', () => {
    // Model-metadata notices arrive as item.type === 'error' but are non-fatal.
    // Reporting them as errors would mark a healthy turn as broken.
    const logs = replayCodex().events.filter(e => e.type === 'log');
    expect(logs.some(l => l.message?.includes('[codex]'))).toBe(true);
  });

  it('extracts assistant text from item.completed', () => {
    const p = new StreamParser('codex');
    const events = p.parseLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_2', type: 'agent_message', text: 'PONG' }
    }));
    expect(events.some(e => e.type === 'log' && e.message === 'PONG')).toBe(true);
  });
});

describe('StreamParser — robustness', () => {
  it('ignores blank lines', () => {
    const p = new StreamParser('claude');
    expect(p.parseLine('')).toEqual([]);
    expect(p.parseLine('   ')).toEqual([]);
  });

  it('treats a truncated JSON line as raw text instead of throwing', () => {
    const p = new StreamParser('claude');
    expect(() => p.parseLine('{"type":"assis')).not.toThrow();
  });

  it('does not advance a stage for an unknown top-level event', () => {
    const p = new StreamParser('claude');
    p.parseLine(JSON.stringify({ type: 'some_future_event', data: 1 }));
    expect(p.getCurrentStage()).toBe('workspace');
    expect(p.getUnhandledTypes()).toContain('some_future_event');
  });

  it('routes a test command to the tests stage', () => {
    const p = new StreamParser('claude');
    const events = p.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]
        }
      })
    );
    expect(events.some((e) => e.type === 'stage_transition' && e.stage === 'tests')).toBe(true);
  });

  it('routes an edit to the implementation stage', () => {
    const p = new StreamParser('claude');
    const events = p.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }] }
      })
    );
    expect(events.some((e) => e.type === 'stage_transition' && e.stage === 'implementation')).toBe(true);
  });

  it('surfaces an errored tool_result as an error event', () => {
    const p = new StreamParser('claude');
    const events = p.parseLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', is_error: true, content: 'ENOENT' }] }
      })
    );
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});

describe('Antigravity agent_response completion', () => {
  const step = (over: Record<string, unknown>) => JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', ...over } });

  it('flushes accumulated text when DONE carries no delta', () => {
    // The regression: a DONE without its own text_delta used to skip the
    // branch, be logged as an unhandled type, and drop the whole reply.
    const parser = new StreamParser('antigravity');
    parser.parseLine(step({ state: 'ACTIVE', text_delta: 'Hello ' }));
    parser.parseLine(step({ state: 'ACTIVE', text_delta: 'world' }));
    const events = parser.parseLine(step({ state: 'DONE' }));

    expect(events.map(e => e.message)).toEqual(['Hello world']);
  });

  it('no longer records agent_response as an unhandled type', () => {
    const parser = new StreamParser('antigravity');
    parser.parseLine(step({ state: 'ACTIVE', text_delta: 'Hi' }));
    parser.parseLine(step({ state: 'DONE' }));

    expect(parser.getUnhandledTypes()).not.toContain('antigravity.step.agent_response');
  });

  it('still flushes when DONE does carry the final delta', () => {
    const parser = new StreamParser('antigravity');
    parser.parseLine(step({ state: 'ACTIVE', text_delta: 'PONG' }));
    const events = parser.parseLine(step({ state: 'DONE', text_delta: '!' }));

    expect(events.map(e => e.message)).toEqual(['PONG!']);
  });

  it('emits nothing when the step completes with no text at all', () => {
    const parser = new StreamParser('antigravity');
    expect(parser.parseLine(step({ state: 'DONE' }))).toEqual([]);
  });

  it('starts clean for the next response after a flush', () => {
    const parser = new StreamParser('antigravity');
    parser.parseLine(step({ state: 'ACTIVE', text_delta: 'first' }));
    parser.parseLine(step({ state: 'DONE' }));
    parser.parseLine(step({ state: 'ACTIVE', text_delta: 'second' }));
    const events = parser.parseLine(step({ state: 'DONE' }));

    expect(events.map(e => e.message)).toEqual(['second']);
  });
});
