import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import spawn from 'cross-spawn';
import treeKill from 'tree-kill';
import type { ChildProcess } from 'node:child_process';
import { isSecretFile, pickRoot, resolveInProject, SKIPPED_DIRS, type ProjectRoot } from './projectFiles.js';
import { pathMatchesScope, scopeAllowsPath } from '../utils/pathScope.js';
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
  dependencyAudit: dependencyAuditSpecSchema.optional(), role: z.string().optional(), auditDirectory: z.string().optional(),
  // Where project_submit_work saves the checked report, and the report version it expects.
  reportFile: z.string().optional(), reportSchemaVersion: z.number().int().optional()
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
/**
 * The form an agent sees a file in (project_read_file shows lines without \r and drops a
 * leading byte-order mark), and so the form every guard compares in. On Windows a checkout
 * may hold CRLF endings the agent never sees; comparing raw bytes refused every edit.
 */
export function textForMatch(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/**
 * A file's text for an edit, refusing anything that is not valid UTF-8. Decoding Latin-1 or
 * Windows-1252 bytes as UTF-8 turns each one into U+FFFD, and writing that back corrupts every
 * such byte in the file, so these files are left as they are.
 */
function readEditableText(target: string, given: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(target));
  } catch {
    throw new Error(`${given} is not UTF-8 text, so editing it here would corrupt it. Leave it unchanged and say so in the report.`);
  }
}

/** Text written back in a file's own form: its byte-order mark and its line endings. */
function inFileForm(text: string, original: string): string {
  const body = textForMatch(text);
  const crlf = (original.match(/\r\n/g)?.length ?? 0) > (original.match(/(?<!\r)\n/g)?.length ?? 0);
  return (original.startsWith('\uFEFF') ? '\uFEFF' : '') + (crlf ? body.replace(/\n/g, '\r\n') : body);
}

/**
 * A path part Windows would resolve to another name: `config.ts.` and `config.ts ` are
 * `config.ts`, and an 8.3 short alias such as `NODE_M~1` or `SECRET~1.TXT` names a longer
 * file. Checks on the given name would not see the real one, so such names are refused.
 */
function renamedByWindows(part: string): boolean {
  return (/[. ]$/.test(part) && part !== '.' && part !== '..') || /~\d/.test(part);
}

function writablePath(roots: ProjectRoot[], scope: TaskFileScope, given: string): string {
  if (scope.reportOnly || !isImplementationTask(scope.kind)) throw new Error('This task is read-only.');
  if (!given || given.includes('\\') || given.includes(':') || given.startsWith('/') ||
      given.split('/').some(part => !part || part === '.' || part === '..' || renamedByWindows(part) || SKIPPED_DIRS.has(part.toLowerCase()) || isSecretFile(part))) {
    throw new Error('Use a repository-relative source path with forward slashes, no trailing dots or spaces; secrets, dependencies and internal folders are forbidden.');
  }
  if (!scopeAllowsPath(scope, given)) throw new Error(`${given} is outside this task’s approved path scope.`);
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
    // The same name checks on the real name, which can differ from the given one on Windows.
    if (rel.split(path.sep).some(name => SKIPPED_DIRS.has(name.toLowerCase()) || isSecretFile(name))) {
      throw new Error('Use a repository-relative source path; secrets, dependencies and internal folders are forbidden.');
    }
  }
  return current;
}

export function writeTaskFile(roots: ProjectRoot[], scope: TaskFileScope, args: { path: string; content: string; expected_content?: string }): string {
  const target = writablePath(roots, scope, args.path);
  if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE) throw new Error('Text content must be at most 2 MiB.');
  const existing = fs.existsSync(target) ? readEditableText(target, args.path) : undefined;
  if (existing !== undefined && (args.expected_content === undefined || textForMatch(existing) !== textForMatch(args.expected_content))) {
    throw new Error('File already exists or changed. Use project_edit_file, or supply its current content as expected_content (line endings do not matter). Re-read the file and retry.');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // A replaced file keeps its own line endings and byte-order mark; a new file is written as sent.
  fs.writeFileSync(target, existing === undefined ? args.content : inFileForm(args.content, existing), 'utf8');
  return `Updated ${args.path} within task ${scope.taskId}.`;
}

export function editTaskFile(roots: ProjectRoot[], scope: TaskFileScope, args: { path: string; old_text: string; new_text: string }): string {
  const target = writablePath(roots, scope, args.path);
  if (!args.old_text || typeof args.new_text !== 'string' || fs.statSync(target).size > MAX_FILE) throw new Error('Provide a nonempty exact old_text and bounded new_text.');
  const current = readEditableText(target, args.path);
  const view = textForMatch(current);
  const oldText = textForMatch(args.old_text);
  if (view.split(oldText).length !== 2) throw new Error('old_text must match exactly once (line endings do not matter). Read the current file and retry with a longer, unique old_text.');
  fs.writeFileSync(target, inFileForm(view.replace(oldText, () => textForMatch(args.new_text)), current), 'utf8');
  return `Updated ${args.path} within task ${scope.taskId}.`;
}

export function deleteTaskFile(roots: ProjectRoot[], scope: TaskFileScope, args: { path: string; expected_content: string }): string {
  const target = writablePath(roots, scope, args.path);
  if (fs.statSync(target).size > MAX_FILE || typeof args.expected_content !== 'string' || textForMatch(readEditableText(target, args.path)) !== textForMatch(args.expected_content)) {
    throw new Error('Deletion requires the current content as expected_content (line endings do not matter). Re-read the file and retry.');
  }
  fs.unlinkSync(target);
  return `Deleted ${args.path} within task ${scope.taskId}.`;
}

/** Only names authorized by the task; scripts run in a disposable source copy. */
export async function runTaskCheck(roots: ProjectRoot[], scope: TaskFileScope, script: string | readonly string[], verify?: typeof runVerification) {
  if (stopping) throw new Error('The task was stopped.');
  const scripts = [...new Set(typeof script === 'string' ? [script] : script)];
  const unauthorized = scripts.filter(name => !scope.requiredChecks.includes(name as TaskFileScope['requiredChecks'][number]));
  if (scope.reportOnly || !scripts.length || unauthorized.length) {
    throw new Error('This check is not authorized by the task' + (unauthorized.length ? ': ' + unauthorized.join(', ') : '') + '.');
  }
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
    return await verify({ runId: checkRunId, cwd: scratch, requiredScripts: scripts, shouldContinue: () => !stopping });
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
