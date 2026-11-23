/**
 * Whether a change to an accepted test file weakened it. A JavaScript/TypeScript heuristic, not a
 * parser: it counts active test cases, skipped or todo tests, and assertions in code with comments
 * and string contents removed, so a `test(` in a comment or a string does not count, and turning a
 * test into `test.skip` counts as weakening.
 */

/** Test files whose cases and assertions an update to accepted work must keep. */
export const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/** `it(` / `test(`, optionally `.only` or `.concurrent`. */
const PLAIN_TEST = /(?<![\w$.])(?:it|test)(?:\.(?:only|concurrent))*\s*\(/g;
/** `it.each` / `test.each` tables: one active test each. */
const TABLE_TEST = /(?<![\w$.])(?:it|test)(?:\.(?:only|concurrent))*\.each\b/g;
const INACTIVE_TEST = /(?<![\w$.])(?:(?:it|test|describe)\.(?:skip|todo|fixme)|xit|xtest|xdescribe)\b/g;
const ASSERTION = /(?<![\w$.])(?:expect|assert)(?:\.\w+)*\s*\(/g;
const QUOTES = new Set(['"', '\'', '`']);

/** Index of the quote closing the string that opens at `start`, or the end of the source. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  let end = start + 1;
  while (end < source.length && source[end] !== quote) end += source[end] === '\\' ? 2 : 1;
  return Math.min(end, source.length);
}

/** The text that replaces the token starting at `index`, and where the next token starts. */
function nextToken(source: string, index: number): { text: string; end: number } {
  const pair = source.slice(index, index + 2);
  if (pair === '//') {
    const newline = source.indexOf('\n', index);
    return { text: '', end: newline === -1 ? source.length : newline };
  }
  if (pair === '/*') {
    const close = source.indexOf('*/', index + 2);
    return { text: ' ', end: close === -1 ? source.length : close + 2 };
  }
  const char = source[index];
  if (QUOTES.has(char)) return { text: char + char, end: stringEnd(source, index) + 1 };
  return { text: char, end: index + 1 };
}

/** Code with comments removed and string and template contents emptied (quotes kept). */
export function stripCommentsAndStrings(source: string): string {
  const parts: string[] = [];
  for (let index = 0; index < source.length;) {
    const token = nextToken(source, index);
    parts.push(token.text);
    index = token.end;
  }
  return parts.join('');
}

export interface TestStrength { active: number; inactive: number; assertions: number }

export function testStrength(source: string): TestStrength {
  const code = stripCommentsAndStrings(source);
  const count = (pattern: RegExp) => code.match(pattern)?.length ?? 0;
  return { active: count(PLAIN_TEST) + count(TABLE_TEST), inactive: count(INACTIVE_TEST), assertions: count(ASSERTION) };
}

/** How `after` weakened `before`, or undefined when it kept every active test and assertion. */
export function testWeakening(before: string, after: string): string | undefined {
  const was = testStrength(before);
  const now = testStrength(after);
  if (now.active < was.active) return 'removed test cases';
  if (now.inactive > was.inactive) return 'skipped or disabled tests';
  if (now.assertions < was.assertions) return 'removed assertions';
  return undefined;
}
