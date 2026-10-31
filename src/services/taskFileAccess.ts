import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import spawn from 'cross-spawn';
import treeKill from 'tree-kill';
import type { ChildProcess } from 'node:child_process';
import { isSecretFile, pickRoot, resolveInProject, SKIPPED_DIRS, type ProjectRoot } from './projectFiles.js';
import { pathMatchesScope } from '../utils/pathScope.js';
import { orchestrationTaskKindSchema, orchestrationRequiredCheckSchema } from './orchestrationContract.js';
import { isImplementationTask } from './agentRoleContracts.js';
import type { runVerification } from './verificationService.js';
import { dependencyAuditSpecSchema } from './dependencyAuditContract.js';
import { agentRoleContract, roleCanOwnTask } from './agentRoleContracts.js';
import { runDependencyAudit, stopDependencyAudits } from './dependencyAuditService.js';
import { childProcessEnv } from './childProcessEnv.js';

const scopeSchema = z.object({
  taskId: z.string().min(1), repository: z.string().min(1), kind: orchestrationTaskKindSchema,
  includePaths: z.array(z.string()), excludePaths: z.array(z.string()),
  requiredChecks: z.array(orchestrationRequiredCheckSchema), reportOnly: z.boolean().default(false),
  dependencyAudit: dependencyAuditSpecSchema.optional(), role: z.string().optional(), auditDirectory: z.string().optional()
}).strict();
export type TaskFileScope = z.infer<typeof scopeSchema>;
export function parseTaskFileScope(raw: string | undefined): TaskFileScope | undefined {
  if (!raw) return undefined;
  // Malformed authority fails closed; it never becomes an unrestricted file server.
  return scopeSchema.parse(JSON.parse(raw));
}

const MAX_FILE = 2 * 1024 * 1024;
const activeChecks = new Set<string>();
const activeLocks = new Map<number, ChildProcess>();
let stopping = false;

/** The CLI may close its MCP pipe during cancellation; stop managed descendants too. */
export async function stopTaskOperations(): Promise<void> {
  stopping = true;
  const stops: Promise<unknown>[] = [];
  stops.push(stopDependencyAudits());
  if (activeChecks.size) {
    const { processManager } = await import('./processManager.js');
    stops.push(...[...activeChecks].map(id => processManager.terminateProcessAndWait(id, 'cancelled')));
  }
  for (const [pid, child] of activeLocks) stops.push(new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 5_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    treeKill(pid, 'SIGTERM', () => {});
  }));
  await Promise.allSettled(stops);
}

export function taskCanAudit(scope: TaskFileScope): boolean {
  if (scope.reportOnly || !scope.dependencyAudit || !scope.role || !scope.auditDirectory) return false;
  if (scope.dependencyAudit.purpose !== 'self-check') return ['audit', 'review'].includes(scope.kind) && roleCanOwnTask('audit', scope.role);
  return (isImplementationTask(scope.kind) || scope.kind === 'validation') && Boolean(agentRoleContract(scope.role)) && roleCanOwnTask(scope.kind, scope.role);
}

export async function auditTaskDependencies(roots: ProjectRoot[], scope: TaskFileScope) {
  if (stopping || !taskCanAudit(scope)) throw new Error('A dependency audit is not authorized for this task role and purpose.');
  const root = pickRoot(roots, scope.repository);
  return runDependencyAudit({ directory: root.dir, repository: scope.repository, taskId: scope.taskId,
    evidenceDirectory: scope.auditDirectory!, spec: scope.dependencyAudit! });
}
function writablePath(roots: ProjectRoot[], scope: TaskFileScope, given: string): string {
  if (scope.reportOnly || !isImplementationTask(scope.kind)) throw new Error('This task is read-only.');
  if (!given || given.includes('\\') || given.includes(':') || given.startsWith('/') ||
      given.split('/').some(part => !part || part === '.' || part === '..' || SKIPPED_DIRS.has(part) || isSecretFile(part))) {
    throw new Error('Use a repository-relative source path; secrets, dependencies and internal folders are forbidden.');
  }
  if (!scope.includePaths.some(pattern => pathMatchesScope(given, pattern)) ||
      scope.excludePaths.some(pattern => pathMatchesScope(given, pattern))) throw new Error(`${given} is outside this task’s approved path scope.`);
  const root = pickRoot(roots, scope.repository);
  let current = root.dir;
  for (const part of given.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current) && !fs.lstatSync(current, { throwIfNoEntry: false })) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink > 1)) throw new Error('Linked paths are forbidden for task writes.');
    const real = fs.realpathSync.native(current);
    const rel = path.relative(root.dir, real);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path escapes the assigned repository.');
  }
  return current;
}

export function writeTaskFile(roots: ProjectRoot[], scope: TaskFileScope, args: { path: string; content: string; expected_content?: string }): string {
  const target = writablePath(roots, scope, args.path);
  if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE) throw new Error('Text content must be at most 2 MiB.');
  if (fs.existsSync(target) && (args.expected_content === undefined || fs.readFileSync(target, 'utf8') !== args.expected_content)) {
    throw new Error('File already exists or changed. Use project_edit_file, or supply its exact expected_content.');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, args.content, 'utf8');
  return `Updated ${args.path} within task ${scope.taskId}.`;
}

export function editTaskFile(roots: ProjectRoot[], scope: TaskFileScope, args: { path: string; old_text: string; new_text: string }): string {
  const target = writablePath(roots, scope, args.path);
  if (!args.old_text || typeof args.new_text !== 'string' || fs.statSync(target).size > MAX_FILE) throw new Error('Provide a nonempty exact old_text and bounded new_text.');
  const current = fs.readFileSync(target, 'utf8');
  if (current.split(args.old_text).length !== 2) throw new Error('old_text must match exactly once. Read the current file and retry.');
  return writeTaskFile(roots, scope, { path: args.path, content: current.replace(args.old_text, () => args.new_text), expected_content: current });
}

export function deleteTaskFile(roots: ProjectRoot[], scope: TaskFileScope, args: { path: string; expected_content: string }): string {
  const target = writablePath(roots, scope, args.path);
  if (fs.statSync(target).size > MAX_FILE || typeof args.expected_content !== 'string' || fs.readFileSync(target, 'utf8') !== args.expected_content) throw new Error('Deletion requires the current exact expected_content.');
  fs.unlinkSync(target);
  return `Deleted ${args.path} within task ${scope.taskId}.`;
}

/** Only names authorized by the task; scripts run in a disposable source copy. */
export async function runTaskCheck(roots: ProjectRoot[], scope: TaskFileScope, script: string, verify?: typeof runVerification) {
  if (stopping) throw new Error('The task was stopped.');
  if (scope.reportOnly || !scope.requiredChecks.includes(script as TaskFileScope['requiredChecks'][number])) throw new Error('This check is not authorized by the task.');
  const root = pickRoot(roots, scope.repository);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-task-check-'));
  let bytes = 0;
  let releaseAuthority: (() => void) | undefined;
  const checkRunId = `task-check-${path.basename(scratch)}`;
  try {
    fs.cpSync(root.dir, scratch, { recursive: true, filter: source => {
      if (source === root.dir) return true;
      const name = path.basename(source);
      const stat = fs.lstatSync(source);
      if (SKIPPED_DIRS.has(name) || isSecretFile(name) || stat.isSymbolicLink()) return false;
      if (stat.isFile()) { bytes += stat.size; if (bytes > 64 * 1024 * 1024) throw new Error('Source copy exceeds 64 MiB; split this validation task.'); }
      return true;
    } });
    // Load command infrastructure only after MCP transport logging is redirected.
    // Ordinary read/file operations must never initialize the application database.
    if (!verify) {
      const { sqliteService } = await import('./sqliteService.js');
      sqliteService.addAllowedPath(scratch, 'Disposable assigned-check source');
      releaseAuthority = () => sqliteService.removeAllowedPath(scratch);
      verify = (await import('./verificationService.js')).runVerification;
    }
    activeChecks.add(checkRunId);
    return await verify({ runId: checkRunId, cwd: scratch, requiredScripts: [script], shouldContinue: () => !stopping });
  } finally {
    activeChecks.delete(checkRunId);
    releaseAuthority?.();
    if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('alpha-task-check-')) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A fixed package operation, without arbitrary flags or lifecycle scripts. */
export async function generateTaskLockfile(roots: ProjectRoot[], scope: TaskFileScope): Promise<string> {
  if (stopping) throw new Error('The task was stopped.');
  writablePath(roots, scope, 'package-lock.json');
  const root = pickRoot(roots, scope.repository);
  const manifestPath = resolveInProject(roots, scope.repository, 'package.json').abs;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.packageManager && !String(manifest.packageManager).startsWith('npm@')) throw new Error('This bounded operation supports npm projects only.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-task-lock-'));
  try {
    fs.copyFileSync(manifestPath, path.join(scratch, 'package.json'));
    if (fs.existsSync(path.join(root.dir, 'package-lock.json'))) fs.copyFileSync(path.join(root.dir, 'package-lock.json'), path.join(scratch, 'package-lock.json'));
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: scratch, windowsHide: true, env: childProcessEnv({ npm_config_ignore_scripts: 'true' })
      });
      if (child.pid) activeLocks.set(child.pid, child);
      let output = '';
      child.stdout?.on('data', data => { output = (output + String(data)).slice(-4000); });
      child.stderr?.on('data', data => { output = (output + String(data)).slice(-4000); });
      const timer = setTimeout(() => { if (child.pid) treeKill(child.pid, 'SIGTERM', () => {}); }, 90_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); if (child.pid) activeLocks.delete(child.pid); code === 0 && !stopping ? resolve() : reject(new Error(`npm lockfile generation failed or stopped: ${output}`)); });
    });
    const target = path.join(root.dir, 'package-lock.json');
    return writeTaskFile(roots, scope, { path: 'package-lock.json', content: fs.readFileSync(path.join(scratch, 'package-lock.json'), 'utf8'),
      ...(fs.existsSync(target) ? { expected_content: fs.readFileSync(target, 'utf8') } : {}) });
  } finally {
    if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('alpha-task-lock-')) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
