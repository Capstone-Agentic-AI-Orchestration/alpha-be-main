import path from 'node:path';

/** Whether this platform's file names ignore letter case: C:\Users\Me and c:\users\me are one folder on Windows. */
export const PATHS_IGNORE_CASE = process.platform === 'win32';

/** A resolved path in the form used for comparison on this platform. */
export function comparablePath(value: string, ignoreCase = PATHS_IGNORE_CASE): string {
  const resolved = path.resolve(value);
  return ignoreCase ? resolved.toLowerCase() : resolved;
}

/** Whether two paths name the same place, ignoring letter case where the platform does. */
export function samePath(left: string, right: string, ignoreCase = PATHS_IGNORE_CASE): boolean {
  return comparablePath(left, ignoreCase) === comparablePath(right, ignoreCase);
}

/** Whether a path is the folder itself or inside it, ignoring letter case where the platform does. */
export function isPathInside(child: string, folder: string, ignoreCase = PATHS_IGNORE_CASE): boolean {
  const target = comparablePath(child, ignoreCase);
  const base = comparablePath(folder, ignoreCase);
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}
