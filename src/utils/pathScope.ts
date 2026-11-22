/**
 * Whether path scopes ignore letter case here. Windows file names are case-insensitive, so
 * `src/Components/x.ts` and `src/components/x.ts` are the same file: a scope check that
 * told them apart would allow a write and then reject the very file it produced.
 */
export const SCOPE_IGNORES_CASE = process.platform === 'win32';

/** Match repository-relative paths against the small glob subset used by orchestration plans. */
export function pathMatchesScope(filePath: string, pattern: string, ignoreCase = SCOPE_IGNORES_CASE): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') {
        index++;
        expression += '(?:.*/)?';
      } else {
        expression += '.*';
      }
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  expression += '$';
  return new RegExp(expression, ignoreCase ? 'i' : '').test(normalizedPath);
}
