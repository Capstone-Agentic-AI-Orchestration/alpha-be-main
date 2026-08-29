import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { TurnAccumulator } from './turnAccumulator.js';
import { StreamParser } from './streamParser.js';
import { ParsedEvent } from './streamParser.js';

const IDLE = 'Analyzing...';

const feed = (events: ParsedEvent[]) => {
  const turn = new TurnAccumulator();
  for (const e of events) turn.accept(e);
  return turn;
};

const text = (message: string): ParsedEvent => ({ type: 'log', message });
const thinking = (t: string): ParsedEvent => ({ type: 'thinking', thinking: t });
const tool = (toolName: string): ParsedEvent => ({ type: 'tool_call', toolName, toolInput: {} });

describe('answer extraction', () => {
  it('keeps only the text after the last tool call', () => {
    const turn = feed([
      text('Let me check that file.'),
      tool('Read'),
      text('Now the config.'),
      tool('Grep'),
      text('Here is what I found.')
    ]);

    expect(turn.getContent()).toBe('Here is what I found.');
  });

  it('moves the narration to the thinking panel rather than dropping it', () => {
    const turn = feed([
      text('Let me check that file.'),
      tool('Read'),
      text('Here is what I found.')
    ]);

    expect(turn.getThinking(IDLE)).toBe('Let me check that file.');
  });

  it('keeps a contiguous run of text blocks together', () => {
    const turn = feed([
      text('Checking.'),
      tool('Read'),
      text('First paragraph.'),
      text('Second paragraph.')
    ]);

    expect(turn.getContent()).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('returns a single text block unchanged when no tool ran', () => {
    expect(feed([text('Just an answer.')]).getContent()).toBe('Just an answer.');
  });

  it('falls back to the last narration when the turn ends on a tool call', () => {
    // A turn cut short after a tool call still said something; reporting
    // "no output" would be worse than showing it.
    const turn = feed([text('Let me look at that.'), tool('Read')]);

    expect(turn.getContent()).toBe('Let me look at that.');
  });

  it('does not repeat that fallback in the thinking panel', () => {
    const turn = feed([text('Let me look at that.'), tool('Read')]);
    expect(turn.getThinking(IDLE)).toBe(IDLE);
  });

  it('is empty when the turn produced nothing at all', () => {
    expect(feed([]).getContent()).toBe('');
    expect(feed([tool('Read')]).getContent()).toBe('');
  });
});

describe('thinking', () => {
  it('accumulates every thinking block instead of keeping only the last', () => {
    const turn = feed([thinking('First thought.'), thinking('Second thought.')]);

    expect(turn.getThinking(IDLE)).toBe('First thought.\n\nSecond thought.');
  });

  it('interleaves reasoning and narration in arrival order', () => {
    const turn = feed([
      thinking('I should read the file.'),
      text('Checking the file.'),
      tool('Read'),
      text('Done.')
    ]);

    expect(turn.getThinking(IDLE)).toBe('I should read the file.\n\nChecking the file.');
  });

  it('falls back to the idle message when there was neither', () => {
    expect(feed([text('Answer.')]).getThinking(IDLE)).toBe(IDLE);
  });
});

describe('tools and errors', () => {
  it('records every tool call in order', () => {
    const turn = feed([tool('Read'), tool('Grep'), tool('Glob')]);

    expect(turn.getTools().map(t => t.toolName)).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('gives each tool record a distinct id', () => {
    const ids = feed([tool('Read'), tool('Grep')]).getTools().map(t => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('captures the stream error', () => {
    const turn = feed([{ type: 'error', message: 'Credit balance too low' }]);
    expect(turn.getStreamError()).toBe('Credit balance too low');
  });

  it('ignores events that carry no reply text', () => {
    const turn = feed([
      { type: 'session', message: 'Session x initialised' },
      { type: 'tool_result', message: 'file contents' },
      { type: 'rate_limit', message: 'backing off' },
      text('The answer.')
    ]);

    expect(turn.getContent()).toBe('The answer.');
    expect(turn.getThinking(IDLE)).toBe(IDLE);
  });
});

describe('against the captured Claude transcript', () => {
  /**
   * fixtures/claude-stream-sample.jsonl is a real run shaped
   * text -> tool_use -> tool_result -> text, which is precisely the case the
   * old concatenating code got wrong.
   */
  const replay = () => {
    const file = path.join(process.cwd(), 'fixtures', 'claude-stream-sample.jsonl');
    const parser = new StreamParser('claude');
    const turn = new TurnAccumulator();

    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      for (const ev of parser.parseLine(line)) turn.accept(ev);
    }
    return turn;
  };

  it('produces a reply that is not the whole transcript', () => {
    const turn = replay();

    expect(turn.getContent().length).toBeGreaterThan(0);
    expect(turn.getTools().length).toBeGreaterThan(0);
  });

  it('does not put the pre-tool narration in the reply', () => {
    const turn = replay();
    const narration = turn.getThinking(IDLE);

    expect(narration).not.toBe(IDLE);
    expect(turn.getContent()).not.toContain(narration);
  });

  it('is shorter than the old concatenate-everything behaviour', () => {
    const turn = replay();
    const everything = `${turn.getThinking(IDLE)}\n${turn.getContent()}`;

    expect(turn.getContent().length).toBeLessThan(everything.length);
  });
});
