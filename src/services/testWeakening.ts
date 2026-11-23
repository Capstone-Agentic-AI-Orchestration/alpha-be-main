/**
 * Whether a change to an accepted test file weakened it. A JavaScript/TypeScript heuristic, not a
 * parser: it counts active test cases, skipped or todo tests, and assertions in code with comments
 * and string contents removed, so a `test(` in a comment or a string does not count, and turning a
 * test into `test.skip` counts as weakening.
 */

/** Test files whose cases and assertions an update to accepted work must keep. */
export const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

const ACTIVE_TEST = /(?<![\w$.])(?:it|test)(?:\.(?:only|concurrent|each\s*(?:\([^)]*\)|`[^`]*`)))*\s*\(/g;
const INACTIVE_TEST = /(?<![\w$.])(?:(?:it|test|describe)\.(?:skip|todo|fixme)|xit|xtest|xdescribe)\b/g;
const ASSERTION = /(?<![\w$.])(?:expect|assert)(?:\.\w+)*\s*\(/g;

/** Code with comments removed and string and template contents emptied (quotes kept). */
export function stripCommentsAndStrings(source: string): string {
  let out = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 1;
      out += ' ';
    } else if (char === '"' || char === '\'' || char === '`') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1;
      out += char + char;
      index = end;
    } else {
      out += char;
    }
  }
  return out;
}

export interface TestStrength { active: number; inactive: number; assertions: number }

export function testStrength(source: string): TestStrength {
  const code = stripCommentsAndStrings(source);
  const count = (pattern: RegExp) => code.match(pattern)?.length ?? 0;
  return { active: count(ACTIVE_TEST), inactive: count(INACTIVE_TEST), assertions: count(ASSERTION) };
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
