import fs from 'node:fs';
import path from 'node:path';

import { MONOREPO_APPS } from './monorepoLayout.js';

const PLANNING_SKIPPED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', 'out', 'vendor']);
const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|swift|rb|php|cs|dart|sql|css|scss|html)$/i;
const TEST_PATH_PATTERN = /(?:^|\/)(?:tests?|__tests__|spec|e2e)\/|\.(?:test|spec)\.[^/]+$/i;
const CONFIG_FILE_PATTERN = /(?:^|\/)[^/]*\.config\.[^/]+$/i;
const MAX_LISTED_PLANNING_FILES = 150;
const MAX_SCANNED_PLANNING_FILES = 3_000;
/** A starter scaffold has at most this many application source files per app. */
const SCAFFOLD_SOURCE_FILES_PER_APP = 3;

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
  // An Alpha monorepo: two complete apps, so a task belongs in one folder or the other.
  const monorepo = files.includes(`${MONOREPO_APPS.web.path}/package.json`) && files.includes(`${MONOREPO_APPS.api.path}/package.json`);
  const monorepoNote = monorepo
    ? `\n\nThis repository is a monorepo: the frontend (the website) is the app in ${MONOREPO_APPS.web.path}/ and the backend (the API) is the app in ${MONOREPO_APPS.api.path}/, each with its own package.json, tests and lockfile. Scope frontend tasks to ${MONOREPO_APPS.web.path}/ and backend tasks to ${MONOREPO_APPS.api.path}/; one task may cover both when a change needs both. Put a dependency in the package.json of the app that uses it, never the root. The root scripts run each script in both apps.`
    : '';
  const scaffoldLimit = SCAFFOLD_SOURCE_FILES_PER_APP * (monorepo ? 2 : 1);
  const sourceFileWord = sourceFiles.length === 1 ? 'file' : 'files';
  const scaffoldNote = sourceFiles.length <= scaffoldLimit
    ? `\n\nThis repository looks like a starter scaffold: it has ${sourceFiles.length} application source ${sourceFileWord} (${sourceFiles.join(', ') || 'none'}). Plan to create the requested features. Do not assume existing screens, endpoints, API clients, data models, or workflows.`
    : '';
  return `Repository files (${total} total, ${sourceFiles.length} application source files):\n${listed.join('\n')}${more}${monorepoNote}${scaffoldNote}`;
}
