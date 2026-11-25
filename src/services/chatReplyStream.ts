/**
 * Alpha's reply text as it is written, for the chat to show live.
 *
 * Agent CLIs report a reply in small pieces (`text_delta`). ReplyStream gathers them and hands
 * the reply so far to `emit` at most every `intervalMs`, so a fast model does not send one
 * event per word. The finished reply still arrives as a normal chat message and replaces this
 * text, so a dropped or late update only costs a moment of liveness.
 */

/** Escapes a JSON string may contain, by the letter after the backslash. */
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

/**
 * The readable part of a structured reply written so far: the `message` string of
 * `{ "contract": …, "message": "…", "decision": … }` (see alphaChatResponseSchema), decoded up to
 * where the model has got to. Empty until the message starts.
 */
export function structuredMessageSoFar(raw: string): string {
  const start = /"message"\s*:\s*"/.exec(raw);
  if (!start) return '';
  let text = '';
  let index = start.index + start[0].length;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') break;
    if (char !== '\\') {
      text += char;
      index += 1;
      continue;
    }
    const escaped = raw[index + 1];
    if (escaped === undefined) break;
    if (escaped === 'u') {
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      text += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    text += ESCAPES[escaped] ?? escaped;
    index += 2;
  }
  return text;
}

export class ReplyStream {
  private raw = '';
  private lastKey: string | undefined;
  private sent = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly emit: (text: string) => void,
    /** The reply is JSON (alphaChatResponseSchema): show only its message. */
    private readonly structured: boolean,
    private readonly intervalMs = 80
  ) {}

  /** One piece of text. A new `key` is a new message in the same turn, so it starts a new paragraph. */
  push(text: string, key?: string): void {
    if (!this.structured && this.raw && key !== undefined && key !== this.lastKey) this.raw += '\n\n';
    if (key !== undefined) this.lastKey = key;
    this.raw += text;
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  /** Send the reply so far, when there is something new to show. */
  flush(): void {
    this.timer = null;
    const visible = this.structured ? structuredMessageSoFar(this.raw) : this.raw;
    if (!visible || visible === this.sent) return;
    this.sent = visible;
    this.emit(visible);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

