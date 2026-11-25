import fs from 'node:fs';
import path from 'node:path';
import { isImplementationTask } from './agentRoleContracts.js';
import type { OrchestrationPlan } from './orchestrationContract.js';
import type { ProjectRoot } from './projectFiles.js';
import { sameRepository } from '../utils/repositoryName.js';
import { PATHS_IGNORE_CASE } from '../utils/samePath.js';

/**
 * Which files the planner opened, and the plan's proof that it looked before it decided.
 *
 * The planner reads a repository through alpha-project-files. During planning those tools write
 * each file the planner opens to a per-planning log (ALPHA_READ_LOG). Alpha then checks the plan
 * against the log: a code task may only change an existing file the planner actually opened. The
 * same list goes with the plan to every specialist as a place to start reading, so specialists do
 * not repeat the planner's search from nothing.
 */
export interface PlannerRead {
  repository: string;
  /** Relative to the repository, with forward slashes. */
  path: string;
}

/** Characters that make a scope pattern match several paths instead of naming one file. */
const PATTERN_CHARACTERS = /[*?[\]{}]/;

/** Record one file the planner opened. The file tools call this from their own process. */
export function recordPlannerRead(logPath: string, read: PlannerRead): void {
  fs.appendFileSync(logPath, JSON.stringify(read) + '\n');
}

/**
 * The files a planning log recorded, each once, in the order they were first opened. Null when
 * there is no log: the planner's runtime had no Alpha file tools, so nothing could be recorded.
 */
export function readPlannerReads(logPath: string): PlannerRead[] | null {
  let text: string;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  const reads = new Map<string, PlannerRead>();
  for (const line of text.split('\n')) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const { repository, path: file } = (entry ?? {}) as Record<string, unknown>;
    if (typeof repository !== 'string' || typeof file !== 'string') continue;
    const key = readKey(repository, file);
    if (!reads.has(key)) reads.set(key, { repository, path: file });
  }
  return [...reads.values()];
}

function readKey(repository: string, file: string): string {
  const name = repository.toLowerCase() + '|' + file;
  return PATHS_IGNORE_CASE ? name.toLowerCase() : name;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Existing files a code task plans to change that the planner never opened, as
 * `path (task id)`. Only exact paths count: a folder or wildcard pattern names no single file to
 * open, and a path that does not exist yet is a new file. Both are left to the specialist.
 */
export function unreadPlannedFiles(plan: OrchestrationPlan, reads: readonly PlannerRead[], roots: readonly ProjectRoot[]): string[] {
  const opened = new Set(reads.map(read => readKey(read.repository, read.path)));
  const unread: string[] = [];
  for (const task of plan.tasks) {
    if (!isImplementationTask(task.kind)) continue;
    const root = task.repository ? roots.find(item => sameRepository(item.repo, task.repository)) : roots[0];
    if (!root) continue;
    for (const pattern of task.scope.includePaths) {
      if (PATTERN_CHARACTERS.test(pattern) || !isFile(path.join(root.dir, pattern))) continue;
      if (!opened.has(readKey(root.repo, pattern))) unread.push(`${pattern} (task ${task.id})`);
    }
  }
  return unread;
}

