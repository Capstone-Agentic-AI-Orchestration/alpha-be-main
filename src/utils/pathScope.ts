import { isSecretFile, SKIPPED_DIRS } from '../services/projectFiles.js';

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

/**
 * Whether a task's scope allows a path: matched by an include pattern and by no exclude pattern.
 * The write tool, acceptance, planning and saved-work restore all use this one rule.
 */
export function scopeAllowsPath(scope: { includePaths: readonly string[]; excludePaths: readonly string[] }, filePath: string): boolean {
  return scope.includePaths.some(pattern => pathMatchesScope(filePath, pattern)) &&
    !scope.excludePaths.some(pattern => pathMatchesScope(filePath, pattern));
}

/**
 * Whether a code task may change a path. The repository is the boundary, not the planner's guess:
 * include patterns say where the change belongs, but a shared type, barrel export or config file
 * the change needs is in bounds too. Excluded paths, secrets, dependency folders, build output and
 * git internals never are. Write tools, acceptance, saved-work restore and fixes use this rule.
 */
export function codeTaskAllowsPath(scope: { excludePaths: readonly string[] }, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '..' ||
      SKIPPED_DIRS.has(part.toLowerCase()) || isSecretFile(part))) return false;
  return !scope.excludePaths.some(pattern => pathMatchesScope(normalized, pattern));
}
