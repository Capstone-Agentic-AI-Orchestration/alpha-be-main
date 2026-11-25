import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplyStream, structuredMessageSoFar } from './chatReplyStream.js';

describe('the reply as it is written', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reads the message of a structured reply as far as it has been written', () => {
    expect(structuredMessageSoFar('{"contract":"alpha_chat_v1","mess')).toBe('');
    expect(structuredMessageSoFar('{"contract":"alpha_chat_v1","message":"Your home')).toBe('Your home');
    expect(structuredMessageSoFar('{"message":"Line one\\nSays \\"hi\\" \\u00e9","decision":null}')).toBe('Line one\nSays "hi" é');
    // A half-written escape waits for the rest instead of showing a backslash.
    expect(structuredMessageSoFar('{"message":"Almost \\')).toBe('Almost ');
    expect(structuredMessageSoFar('{"message":"Code \\u00')).toBe('Code ');
  });

  it('sends the reply so far a few times a second, not once per piece', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const stream = new ReplyStream(text => sent.push(text), false, 80);
    stream.push('Your ', 'm1');
    stream.push('homepage ', 'm1');
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(80);
    expect(sent).toEqual(['Your homepage ']);
    stream.push('is built.', 'm1');
    stream.push('Next step:', 'm2');
    vi.advanceTimersByTime(80);
    expect(sent.at(-1)).toBe('Your homepage is built.\n\nNext step:');
  });

  it('shows only the message of a structured reply, and nothing before it starts', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const stream = new ReplyStream(text => sent.push(text), true, 80);
    stream.push('{"contract":"alpha_chat_v1",');
    vi.advanceTimersByTime(80);
    expect(sent).toEqual([]);
    stream.push('"message":"Done.');
    vi.advanceTimersByTime(80);
    expect(sent).toEqual(['Done.']);
    stream.stop();
  });
});

