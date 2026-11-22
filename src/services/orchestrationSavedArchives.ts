import fs from 'node:fs';
import { samePath } from '../utils/samePath.js';
import { sameRepository } from '../utils/repositoryName.js';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OrchestrationSnapshot, OrchestrationTaskRecord } from './orchestrationStateMachine.js';
import { repositoryWorkspaceForTask } from './orchestrationWorkspace.js';
import { getCurrentBranch, getHeadCommit, isGitWorkingTreeClean } from '../utils/gitUtils.js';
import { pathMatchesScope, scopeAllowsPath } from '../utils/pathScope.js';
import { worktreeChangesHash } from './orchestrationWorktreeRecovery.js';

const exec = promisify(execFile);
const safeName = (value: string) => value.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'attempt';
const MAX_BYTES = 4 * 1024 * 1024;

function archive(snapshot: OrchestrationSnapshot, task: OrchestrationTaskRecord, id: string) {
  if (id === '.' || id === '..' || path.basename(id) !== id || !/^[\w.-]+$/.test(id)) throw new Error('Invalid archive identifier.');
  const root = path.resolve(process.env.ALPHA_HOME || path.join(os.homedir(), '.alpha'), 'preserved', safeName(snapshot.run.id));
  const folder = path.resolve(root, id);
  if (!folder.startsWith(root + path.sep)) throw new Error('Archive must stay inside this build’s preserved directory.');
  if (!fs.existsSync(folder) || [path.dirname(root), root, folder, path.join(folder, 'README.json')].some(item => fs.lstatSync(item).isSymbolicLink())) throw new Error('Saved archive unavailable.');
  const workspace = repositoryWorkspaceForTask(snapshot, task.id);
  if (!workspace) throw new Error('The recorded workspace is unavailable.');
  if (fs.statSync(path.join(folder, 'README.json')).size > MAX_BYTES) throw new Error('Saved archive metadata exceeds the restore limit.');
  const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'README.json'), 'utf8'));
  if (metadata.runId !== snapshot.run.id || !samePath(String(metadata.worktree), workspace.worktreePath) || !id.endsWith('-' + safeName(task.id))) throw new Error('The archive does not belong to this failed step and workspace.');
  const hash = createHash('sha256');
  let size = 0;
  const files: Array<{ relative: string; file: string }> = [];
  const walk = (dir: string, prefix = '') => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      const relative = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error('Saved archives with symbolic links need manual review.');
      if (item.isDirectory()) walk(file, relative + '/');
      else {
        size += fs.statSync(file).size;
        if (size > MAX_BYTES || files.length >= 500) throw new Error('The saved archive exceeds the bounded restore limit.');
        files.push({ relative, file }); hash.update(JSON.stringify(relative)); hash.update(fs.readFileSync(file));
      }
    }
  };
  walk(folder);
  const patch = files.find(item => item.relative === 'tracked-changes.patch');
  if (patch && /^(?:new file mode|old mode|new mode) 120000$/m.test(fs.readFileSync(patch.file, 'utf8'))) throw new Error('A symbolic-link patch needs manual review.');
  const untracked = files.filter(item => item.relative.startsWith('untracked/'));
  const allows = (relative: string) => relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..') && !relative.split(/[\\/]/).some(part => part.toLowerCase() === '.git') &&
    scopeAllowsPath(task.scope, relative);
  if (untracked.some(item => !allows(item.relative.slice('untracked/'.length)))) throw new Error('The archive contains a file outside this step’s approved scope.');
  return { workspace, folder, hash: hash.digest('hex'), patch, untracked, allows, files: files.map(item => item.relative), savedAt: String(metadata.savedAt ?? '') };
}

/**
 * The file names in `git apply --numstat -z` output: "added<TAB>deleted<TAB>path\0", or for a
 * rename "added<TAB>deleted<TAB>\0old\0new\0". Both names of a rename are returned.
 */
export function numstatPaths(output: string): string[] {
  const fields = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const parts = fields[index].split('\t');
    if (parts.length < 3) continue;
    const name = parts.slice(2).join('\t');
    if (name) paths.push(name);
    else { paths.push(fields[index + 1] ?? '', fields[index + 2] ?? ''); index += 2; }
  }
  return paths.filter(Boolean);
}

export function listSavedArchives(snapshot: OrchestrationSnapshot, task: OrchestrationTaskRecord) {
  const root = path.join(process.env.ALPHA_HOME || path.join(os.homedir(), '.alpha'), 'preserved', safeName(snapshot.run.id));
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(id => id.endsWith('-' + safeName(task.id))).sort().reverse().slice(0, 4).flatMap(id => {
    try {
      const entry = archive(snapshot, task, id);
      let remainingPreviewBytes = 64_000;
      return [{ id, hash: entry.hash, savedAt: entry.savedAt, files: entry.files,
        patch: entry.patch ? fs.readFileSync(entry.patch.file, 'utf8').slice(0, 120_000) : '', patchTruncated: entry.patch ? fs.statSync(entry.patch.file).size > 120_000 : false,
        untracked: entry.untracked.map(item => {
          const data = fs.readFileSync(item.file); const content = data.subarray(0, remainingPreviewBytes).toString('utf8');
          const truncated = data.length > remainingPreviewBytes; remainingPreviewBytes = Math.max(0, remainingPreviewBytes - data.length);
          return { path: item.relative.slice('untracked/'.length), content, truncated };
        }) }];
    } catch { return []; }
  });
}

/** Called inside the run serializer, with the executor confirmed stopped. Never overwrites a dirty candidate. */
export async function restoreSavedArchive(snapshot: OrchestrationSnapshot, task: OrchestrationTaskRecord, input: { archiveId: string; archiveHash: string; candidateHash: string }) {
  const entry = archive(snapshot, task, input.archiveId);
  const cwd = entry.workspace.worktreePath;
  if (entry.hash !== input.archiveHash || await worktreeChangesHash(cwd) !== input.candidateHash || !await isGitWorkingTreeClean(cwd)) throw new Error('The archive or candidate changed, or the candidate has edits. Review it before restoring.');
  const latest = [...snapshot.attempts].reverse().find(attempt => attempt.status === 'accepted' && attempt.resultCommit &&
    sameRepository(snapshot.tasks.find(item => item.id === attempt.taskId)?.repository ?? snapshot.run.repository, entry.workspace.repository));
  if (await getCurrentBranch(cwd) !== entry.workspace.branchName || await getHeadCommit(cwd) !== (latest?.resultCommit ?? entry.workspace.baseCommit)) throw new Error('The accepted checkpoint changed. The archive was not restored.');
  if (entry.patch) {
    // -z keeps file names exactly as they are; without it git quotes unusual names and they fail the scope check.
    const stat = await exec('git', ['apply', '--numstat', '-z', entry.patch.file], { cwd, windowsHide: true });
    const paths = numstatPaths(stat.stdout);
    if (!paths.length || paths.some(file => !entry.allows(file))) throw new Error('The patch contains paths outside the approved scope.');
    await exec('git', ['apply', '--check', entry.patch.file], { cwd, windowsHide: true });
  }
  for (const item of entry.untracked) {
    const target = path.resolve(cwd, item.relative.slice('untracked/'.length));
    if (!target.startsWith(path.resolve(cwd) + path.sep) || fs.existsSync(target)) throw new Error('An archived file would overwrite an existing file.');
    for (let parent = path.dirname(target); parent !== path.resolve(cwd); parent = path.dirname(parent)) {
      if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Restore destination contains a symbolic link.');
    }
  }
  // Archive remains intact. If a filesystem error occurs, keep partial candidate edits for inspection.
  if (entry.patch) await exec('git', ['apply', entry.patch.file], { cwd, windowsHide: true });
  for (const item of entry.untracked) {
    const target = path.join(cwd, item.relative.slice('untracked/'.length));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(item.file, target, fs.constants.COPYFILE_EXCL);
  }
  return worktreeChangesHash(cwd);
}
