import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Project } from '../models/index.js';
import { sqliteService } from './sqliteService.js';
import { reposForProject } from './githubIssueMapping.js';
import { resolveProjectWorkspace } from './workspaceService.js';
import { BindingError, bindProject, type BoundProject } from './projectBindings.js';
import type { ProjectRoot } from './projectFiles.js';

/**
 * Where a project's code lives on this computer.
 *
 * One code folder per computer (Documents\AlphaProjects unless changed), and
 * in it one folder per project, named after the project. Each repository is a
 * subfolder named after the repository:
 *
 *   AlphaProjects\TestProjectMock\TestProjectRepov1-be
 *   AlphaProjects\TestProjectMock\TestProjectRepov1-fe
 *
 * That is the default, not a rule. A repository can be registered anywhere --
 * a backend kept on another drive -- and that registration wins
 * (local_repo_bindings, one row per repository).
 *
 * These are this machine's answers, so they live in its database only: the
 * team's project record never carries a path from one person's laptop.
 */

const CODE_FOLDER_KEY = 'code_folder';
const projectFolderKey = (projectId: string) => 'project_folder:' + projectId;

export function defaultCodeFolder(): string {
  return path.join(os.homedir(), 'Documents', 'AlphaProjects');
}

export function codeFolder(): string {
  return sqliteService.getMetaValue(CODE_FOLDER_KEY) ?? defaultCodeFolder();
}

function absoluteFolder(dir: unknown, message: string): string {
  if (typeof dir !== 'string' || !dir.trim() || !path.isAbsolute(dir.trim())) {
    throw new BindingError(message, 'invalid_folder');
  }
  return path.resolve(dir.trim());
}

/** Change the code folder; null or '' goes back to the default. */
export function setCodeFolder(dir: unknown): string {
  if (dir === null || dir === '') {
    sqliteService.setMetaValue(CODE_FOLDER_KEY, null);
    return codeFolder();
  }
  const resolved = absoluteFolder(dir, 'Choose a folder on this computer for your projects.');
  sqliteService.setMetaValue(CODE_FOLDER_KEY, resolved);
  return resolved;
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A project name as a folder name: no characters Windows refuses, spaces as dashes. */
export function folderName(name: string): string {
  let clean = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[. ]+$/, '');
  if (!clean) clean = 'project';
  if (RESERVED_NAMES.test(clean)) clean += '-project';
  return clean.slice(0, 80);
}

export interface ProjectFolder {
  dir: string;
  /** False when someone chose this folder for the project. */
  isDefault: boolean;
}

/** The project's folder: the one chosen for it, or <code folder>\<project name> (with its key if two projects share a name). */
export function projectFolder(project: Pick<Project, 'id' | 'name' | 'key'>): ProjectFolder {
  const chosen = sqliteService.getMetaValue(projectFolderKey(project.id));
  if (chosen) return { dir: chosen, isDefault: false };
  const base = folderName(project.name || project.key || project.id);
  const clash = sqliteService.getProjects().some(other =>
    other.id !== project.id && folderName(other.name || other.key || other.id).toLowerCase() === base.toLowerCase()
  );
  const name = clash && project.key ? base + '-' + folderName(project.key) : base;
  return { dir: path.join(codeFolder(), name), isDefault: true };
}

/** Choose the project's folder; null or '' goes back to the default. */
export function setProjectFolder(project: Pick<Project, 'id' | 'name' | 'key'>, dir: unknown): ProjectFolder {
  if (dir === null || dir === '') {
    sqliteService.setMetaValue(projectFolderKey(project.id), null);
  } else {
    sqliteService.setMetaValue(projectFolderKey(project.id), absoluteFolder(dir, 'Choose a folder on this computer for this project.'));
  }
  return projectFolder(project);
}

/** The project's folder, created if it is the default and does not exist yet. What a clone goes into. */
export function ensureProjectFolder(project: Pick<Project, 'id' | 'name' | 'key'>): string {
  const folder = projectFolder(project);
  fs.mkdirSync(folder.dir, { recursive: true });
  return folder.dir;
}

/** owner/repo from a GitHub remote URL (https or ssh), or null. */
export function repoOfRemote(url: string): string | null {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? match[1] + '/' + match[2] : null;
}

/**
 * The GitHub repository a checkout's origin points at, read from its git
 * config as text -- no git process, so looking costs a file read. Handles a
 * worktree or submodule, whose .git is a file naming the real directory.
 */
export function originOf(dir: string): string | null {
  try {
    let gitDir = path.join(dir, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!pointer) return null;
      gitDir = path.resolve(dir, pointer[1].trim());
      const common = path.join(gitDir, 'commondir');
      if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim());
    }
    let inOrigin = false;
    for (const line of fs.readFileSync(path.join(gitDir, 'config'), 'utf8').split(/\r?\n/)) {
      const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/i.exec(line);
      if (section) {
        inOrigin = section[1] === 'origin';
        continue;
      }
      if (/^\s*\[/.test(line)) {
        inOrigin = false;
        continue;
      }
      const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/i.exec(line) : null;
      if (url) return repoOfRemote(url[1]);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * - registered: this machine has a copy Alpha uses, and it is there.
 * - found: not registered, but <project folder>\<repository> is a checkout of it.
 * - moved: registered, but the folder is gone, and nothing was found instead.
 * - missing: not on this computer.
 */
export type RepositoryLocationState = 'registered' | 'found' | 'moved' | 'missing';

export interface RepositoryLocation {
  repo: string;
  name: string;
  state: RepositoryLocationState;
  /** Where the copy is (registered, found) or was (moved); null when missing. */
  dir: string | null;
  /** <project folder>\<repository name>: where a clone goes and where Alpha looks. */
  expectedDir: string;
  /** Alpha's own clone under ~/.alpha/workspaces. */
  managed: boolean;
}

export interface ProjectFolderReport {
  codeFolder: string;
  folder: string;
  isDefault: boolean;
  repositories: RepositoryLocation[];
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Each of the project's repositories, and where -- if anywhere -- this computer has it. Looks in two places only. */
export function locateProjectRepositories(project: Project): ProjectFolderReport {
  const folder = projectFolder(project);
  const repositories = reposForProject(project).map((repo): RepositoryLocation => {
    const name = repo.split('/').pop() || repo;
    const expectedDir = path.join(folder.dir, name);
    const foundThere = () => {
      const origin = originOf(expectedDir);
      return Boolean(origin && sameRepo(origin, repo));
    };
    const workspace = resolveProjectWorkspace(project, repo);
    if (workspace && fs.existsSync(workspace.dir)) {
      return { repo, name, state: 'registered', dir: workspace.dir, expectedDir, managed: workspace.managed };
    }
    if (foundThere()) return { repo, name, state: 'found', dir: expectedDir, expectedDir, managed: false };
    if (workspace) return { repo, name, state: 'moved', dir: workspace.dir, expectedDir, managed: workspace.managed };
    return { repo, name, state: 'missing', dir: null, expectedDir, managed: false };
  });
  return { codeFolder: codeFolder(), folder: folder.dir, isDefault: folder.isDefault, repositories };
}

/** Register the copy found in the project folder, so builds branch from it too. */
export async function useFoundCopy(project: Project, repo: unknown): Promise<BoundProject> {
  const wanted = typeof repo === 'string' ? repo.trim() : '';
  const location = locateProjectRepositories(project).repositories.find(item => sameRepo(item.repo, wanted));
  if (!location) throw new BindingError(wanted + ' is not one of ' + project.name + "'s repositories.", 'wrong_repository');
  if (location.state !== 'found') {
    throw new BindingError('No unregistered copy of ' + location.repo + ' was found at ' + location.expectedDir + '.', 'invalid_folder');
  }
  return bindProject(project, location.expectedDir, { repo: location.repo });
}

/**
 * What a chat on this project may read: every repository this computer has,
 * registered or found in the project folder. Reading a found copy is harmless;
 * builds still use only registered ones.
 */
export function projectReadRoots(project: Project): { roots: ProjectRoot[]; missing: string[] } {
  const roots: ProjectRoot[] = [];
  const missing: string[] = [];
  for (const location of locateProjectRepositories(project).repositories) {
    if ((location.state === 'registered' || location.state === 'found') && location.dir) {
      roots.push({ name: location.name, repo: location.repo, dir: location.dir });
    } else {
      missing.push(location.repo);
    }
  }
  return { roots, missing };
}

