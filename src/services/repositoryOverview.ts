import fs from 'node:fs';
import path from 'node:path';

const PLANNING_SKIPPED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', 'out', 'vendor']);
const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|swift|rb|php|cs|dart|sql|css|scss|html)$/i;
const TEST_PATH_PATTERN = /(?:^|\/)(?:tests?|__tests__|spec|e2e)\/|\.(?:test|spec)\.[^/]+$/i;
const CONFIG_FILE_PATTERN = /(?:^|\/)[^/]*\.config\.[^/]+$/i;
const MAX_LISTED_PLANNING_FILES = 150;
const MAX_SCANNED_PLANNING_FILES = 3_000;

/**
 * Lists the repository's files so the planner can see what already exists.
 * Root names alone made a one-file scaffold look like a working app, and the
 * planner then asked specialists to "fix existing workflows" that did not exist.
 */
export function repositoryFileOverview(repositoryDir: string): string {
  const files: string[] = [];
  const queue = [''];
  while (queue.length && files.length < MAX_SCANNED_PLANNING_FILES) {
    const relative = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(repositoryDir, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!PLANNING_SKIPPED_DIRS.has(entry.name)) queue.push(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  const total = `${files.length}${files.length >= MAX_SCANNED_PLANNING_FILES ? '+' : ''}`;
  const sourceFiles = files.filter(file => SOURCE_FILE_PATTERN.test(file) && !TEST_PATH_PATTERN.test(file) &&
    !CONFIG_FILE_PATTERN.test(file));
  const listed = files.slice(0, MAX_LISTED_PLANNING_FILES);
  const more = files.length > listed.length ? `\n… and ${files.length - listed.length} more files` : '';
  const scaffoldNote = sourceFiles.length <= 3
    ? `\n\nThis repository looks like a starter scaffold: it has ${sourceFiles.length} application source file${sourceFiles.length === 1 ? '' : 's'} (${sourceFiles.join(', ') || 'none'}). Plan to create the requested features. Do not assume existing screens, endpoints, API clients, data models, or workflows.`
    : '';
  return `Repository files (${total} total, ${sourceFiles.length} application source files):\n${listed.join('\n')}${more}${scaffoldNote}`;
}
