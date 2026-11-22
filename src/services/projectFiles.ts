import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Read-only access to one project's repositories on this computer.
 *
 * Why this exists rather than the agent CLI's own file tools: measured on
 * 2026-10-23, a Codex chat in its read-only sandbox, started in an empty
 * folder, read a package.json from another folder on the disk. The sandbox
 * blocks writes, not reads. So a chat on one project could read every other
 * project on the machine, and only its instructions stopped it.
 *
 * Here the boundary is code. Every path a model names is resolved to its real
 * location -- following "..", symbolic links and junctions -- and must land
 * inside one of the project's own repository folders. Secrets are listed by
 * name but never shown. Git runs with its hook-like settings turned off, so
 * reading a repository cannot run a program configured in it.
 *
 * Nothing here imports the database or any service: the MCP server that uses
 * it is spawned per turn and is handed its folders in the environment.
 */

export interface ProjectRoot {
  /** The folder name the model uses, e.g. "TestProjectRepov1-be". */
  name: string;
  /** owner/repo on GitHub. */
  repo: string;
  /** Real, absolute path. */
  dir: string;
}

export class ProjectFilesError extends Error {}

const IS_WIN = process.platform === 'win32';

/** Folders listed by name but never walked: dependencies, build output, git internals. */
export const SKIPPED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', '.venv', 'venv', '__pycache__', 'target', '.cache'
]);

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 20000;
const MAX_LISTED = 500;
const MAX_GIT_OUTPUT = 60000;

/** The folders this turn may read, from the JSON the daemon put in the environment. Missing folders are dropped. */
export function parseRoots(raw: string | undefined): ProjectRoot[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const roots: ProjectRoot[] = [];
  for (const item of parsed as any[]) {
    if (!item || typeof item.dir !== 'string' || typeof item.repo !== 'string') continue;
    let real: string;
    try {
      real = fs.realpathSync.native(path.resolve(item.dir));
      if (!fs.statSync(real).isDirectory()) continue;
    } catch {
      continue;
    }
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.repo.split('/').pop() || item.repo;
    roots.push({ name, repo: item.repo, dir: real });
  }
  return roots;
}

/** Whether child is root itself or somewhere beneath it. Case-insensitive on Windows, as its file system is. */
export function isInside(child: string, root: string): boolean {
  const a = IS_WIN ? root.toLowerCase() : root;
  const b = IS_WIN ? child.toLowerCase() : child;
  const rel = path.relative(a, b);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function rootList(roots: ProjectRoot[]): string {
  return roots.map(root => root.name + ' (' + root.dir + ')').join(', ');
}

function outside(roots: ProjectRoot[]): ProjectFilesError {
  return new ProjectFilesError(
    'That path is outside this project. Only its own repositories can be read here: ' + rootList(roots) + '.'
  );
}

/** The repository a call is about: the one named, or the only one there is. */
export function pickRoot(roots: ProjectRoot[], repository?: string): ProjectRoot {
  if (!roots.length) throw new ProjectFilesError('This project has no repository on this computer.');
  const wanted = (repository ?? '').trim().toLowerCase();
  if (!wanted) {
    if (roots.length === 1) return roots[0];
    throw new ProjectFilesError('Name the repository: ' + roots.map(root => root.name).join(' or ') + '.');
  }
  const found = roots.find(root =>
    root.name.toLowerCase() === wanted || root.repo.toLowerCase() === wanted || root.repo.toLowerCase().endsWith('/' + wanted)
  );
  if (!found) {
    throw new ProjectFilesError('"' + repository + '" is not one of this project\'s repositories on this computer: ' + rootList(roots) + '.');
  }
  return found;
}

export interface Resolved {
  root: ProjectRoot;
  abs: string;
  /** Relative to the repository, with forward slashes; '' for the repository itself. */
  rel: string;
}

/**
 * Resolve a path a model gave and refuse anything outside the project.
 *
 * Checked twice: lexically, so "..\\other" is refused before the disk is
 * touched, and again after following links, so a junction inside the
 * repository that points elsewhere is refused too.
 */
export function resolveInProject(roots: ProjectRoot[], repository: string | undefined, given: string | undefined): Resolved {
  // Models often write Windows separators; on Linux a backslash would otherwise be read as part of a file name.
  const raw = (given ?? '').trim().replace(/\\/g, '/');
  if (raw.includes('\0')) throw new ProjectFilesError('Invalid path.');

  let root: ProjectRoot;
  let candidate: string;
  if (raw && path.isAbsolute(raw)) {
    candidate = path.resolve(raw);
    let real: string;
    try {
      real = fs.realpathSync.native(candidate);
    } catch {
      if (!roots.some(r => isInside(candidate, r.dir))) throw outside(roots);
      throw new ProjectFilesError('Not found: ' + raw);
    }
    const owner = roots.find(r => isInside(real, r.dir));
    if (!owner) throw outside(roots);
    root = owner;
  } else {
    root = pickRoot(roots, repository);
    candidate = path.resolve(root.dir, raw || '.');
    if (!isInside(candidate, root.dir)) throw outside(roots);
  }

  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    throw new ProjectFilesError('Not found: ' + (raw || root.name));
  }
  if (!isInside(real, root.dir)) throw outside(roots);
  return { root, abs: real, rel: path.relative(root.dir, real).split(path.sep).join('/') };
}

/** Diff exclusions matching isSecretFile, so project_git diff never shows what project_read_file hides. */
const SECRET_DIFF_PATTERNS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
  '**/id_rsa', '**/id_ed25519', '**/id_ecdsa', '**/id_dsa'];

/** Files whose contents are never shown: environment files (except examples) and private keys. */
export function isSecretFile(name: string): boolean {
  // Windows drops trailing dots and spaces from file names: `.env.` and `.env ` are `.env`.
  let base = path.basename(name);
  while (base.endsWith('.') || base.endsWith(' ')) base = base.slice(0, -1);
  if (/^\.env(\..+)?$/i.test(base)) return !/\.(example|sample|template|dist)$/i.test(base);
  return /\.(pem|key|p12|pfx)$/i.test(base) || /^id_(rsa|ed25519|ecdsa|dsa)$/i.test(base);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function label(target: Resolved): string {
  return target.root.name + (target.rel ? '/' + target.rel : '');
}

export function listRepositories(roots: ProjectRoot[]): string {
  if (!roots.length) return 'This project has no repository on this computer.';
  return roots.map(root => root.name + '  ' + root.repo + '  ' + root.dir).join('\n');
}

export function listFiles(roots: ProjectRoot[], args: { repository?: string; path?: string; depth?: unknown }): string {
  const target = resolveInProject(roots, args.repository, args.path);
  if (!fs.statSync(target.abs).isDirectory()) {
    throw new ProjectFilesError(label(target) + ' is a file. Read it with project_read_file.');
  }
  const depth = clampInt(args.depth, 1, 4, 2);
  const lines: string[] = [];
  let truncated = false;

  const walk = (dir: string, prefix: string, level: number): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      if (lines.length >= MAX_LISTED) {
        truncated = true;
        return;
      }
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) {
        lines.push(rel + '  (link, not followed)');
      } else if (entry.isDirectory()) {
        const skipped = SKIPPED_DIRS.has(entry.name);
        lines.push(rel + '/' + (skipped ? '  (not listed)' : ''));
        if (!skipped && level < depth) walk(path.join(dir, entry.name), rel, level + 1);
      } else {
        lines.push(rel + (isSecretFile(entry.name) ? '  (secret: contents hidden)' : ''));
      }
    }
  };
  walk(target.abs, target.rel, 1);

  const header = label(target) + '  (' + target.root.repo + ')';
  return [header, ...lines, ...(truncated ? ['... more entries not shown; list a subfolder.'] : [])].join('\n');
}

export function readFile(
  roots: ProjectRoot[],
  args: { repository?: string; path?: string; start_line?: unknown; max_lines?: unknown }
): string {
  if (!args.path || !String(args.path).trim()) throw new ProjectFilesError('Name the file to read.');
  const target = resolveInProject(roots, args.repository, args.path);
  const stat = fs.statSync(target.abs);
  if (stat.isDirectory()) throw new ProjectFilesError(label(target) + ' is a folder. List it with project_list_files.');
  if (isSecretFile(target.abs)) {
    throw new ProjectFilesError(label(target) + ' holds secrets, so its contents are not shown. Ask the user for the specific value you need.');
  }
  if (stat.size > MAX_READ_BYTES) throw new ProjectFilesError(label(target) + ' is too large to read (' + stat.size + ' bytes).');
  const buffer = fs.readFileSync(target.abs);
  if (buffer.subarray(0, 8000).includes(0)) throw new ProjectFilesError(label(target) + ' is a binary file.');

  const all = buffer.toString('utf8').split(/\r?\n/);
  const start = clampInt(args.start_line, 1, Math.max(all.length, 1), 1);
  const max = clampInt(args.max_lines, 1, 2000, 400);
  const slice = all.slice(start - 1, start - 1 + max);
  const width = String(start + slice.length).length;
  const body = slice.map((line, i) => String(start + i).padStart(width) + '  ' + line);
  const end = start - 1 + slice.length;
  const more = all.length - end;
  return [label(target) + '  (lines ' + start + '-' + end + ' of ' + all.length + ')', ...body,
    ...(more > 0 ? ['... ' + more + ' more lines; continue with start_line ' + (end + 1) + '.'] : [])].join('\n');
}

export function searchFiles(
  roots: ProjectRoot[],
  args: { query?: string; repository?: string; path?: string; regex?: unknown; case_sensitive?: unknown; max_results?: unknown }
): string {
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query) throw new ProjectFilesError('Give a query to search for.');
  const caseSensitive = args.case_sensitive === true;
  let test: (line: string) => boolean;
  if (args.regex === true) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (err: any) {
      throw new ProjectFilesError('Invalid regular expression: ' + (err?.message ?? err));
    }
    test = line => pattern.test(line);
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    test = line => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }
  const maxResults = clampInt(args.max_results, 1, 300, 100);

  const scopes: Resolved[] = args.repository || args.path
    ? [resolveInProject(roots, args.repository, args.path)]
    : roots.map(root => ({ root, abs: root.dir, rel: '' }));

  const results: string[] = [];
  let scanned = 0;
  let stopped = false;

  const visit = (scope: Resolved, abs: string, rel: string): void => {
    if (stopped) return;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let names: string[];
      try {
        names = fs.readdirSync(abs).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (SKIPPED_DIRS.has(name)) continue;
        visit(scope, path.join(abs, name), rel ? rel + '/' + name : name);
        if (stopped) return;
      }
      return;
    }
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES || isSecretFile(abs)) return;
    if (++scanned > MAX_SEARCH_FILES) {
      stopped = true;
      return;
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(abs);
    } catch {
      return;
    }
    if (buffer.subarray(0, 8000).includes(0)) return;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].length > 2000 ? lines[i].slice(0, 2000) : lines[i];
      if (!test(line)) continue;
      const shown = line.trim();
      results.push(scope.root.name + '/' + rel + ':' + (i + 1) + ': ' + (shown.length > 200 ? shown.slice(0, 200) + '...' : shown));
      if (results.length >= maxResults) {
        stopped = true;
        return;
      }
    }
  };

  for (const scope of scopes) visit(scope, scope.abs, scope.rel);

  if (!results.length) return 'No matches for "' + query + '".';
  const note = stopped ? ['... stopped at ' + results.length + ' matches or ' + MAX_SEARCH_FILES + ' files; narrow the search.'] : [];
  return [...results, ...note].join('\n');
}

export type GitCommand = 'status' | 'log' | 'diff' | 'branches';

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/^~-]{0,199}$/;

/**
 * The argv for one read-only git command.
 *
 * The -c settings stop git from running anything configured in the
 * repository while it reads: no file-system monitor hook, no pager, and for
 * diffs no external diff tool and no text-conversion filter.
 */
export function gitArgs(command: GitCommand, options: { ref?: string; rel?: string; maxCount?: number } = {}): string[] {
  const base = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '--no-pager'];
  const ref = options.ref?.trim();
  if (ref && !SAFE_REF.test(ref)) throw new ProjectFilesError('"' + ref + '" is not a branch, tag or commit name this tool accepts.');
  const pathspec = options.rel ? ['--', options.rel] : [];
  switch (command) {
    case 'status':
      return [...base, 'status', '--short', '--branch', ...pathspec];
    case 'log':
      return [...base, 'log', '--oneline', '--decorate', '-n', String(options.maxCount ?? 20), ...(ref ? [ref] : []), ...pathspec];
    case 'diff':
      // The same files project_read_file hides (isSecretFile), in any letter case.
      return [...base, 'diff', '--no-ext-diff', '--no-textconv', ...(ref ? [ref] : []), '--', options.rel || '.',
        ...SECRET_DIFF_PATTERNS.map(pattern => `:(exclude,glob,icase)${pattern}`)];
    case 'branches':
      return [...base, 'branch', '--all', '--no-color'];
    default:
      throw new ProjectFilesError('Unknown git command. Use status, log, diff or branches.');
  }
}

export async function runGit(
  roots: ProjectRoot[],
  args: { repository?: string; command?: string; ref?: string; path?: string; max_count?: unknown }
): Promise<string> {
  const command = (args.command ?? 'status') as GitCommand;
  const target = args.path ? resolveInProject(roots, args.repository, args.path) : { root: pickRoot(roots, args.repository), rel: '' };
  const argv = gitArgs(command, { ref: args.ref, rel: target.rel, maxCount: clampInt(args.max_count, 1, 50, 20) });
  const output = await new Promise<string>((resolve, reject) => {
    execFile('git', argv, {
      cwd: target.root.dir,
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    }, (err, stdout, stderr) => {
      if (err) reject(new ProjectFilesError('git ' + command + ' failed: ' + (String(stderr).trim() || err.message)));
      else resolve(String(stdout));
    });
  });
  const trimmed = output.length > MAX_GIT_OUTPUT ? output.slice(0, MAX_GIT_OUTPUT) + '\n... output cut at ' + MAX_GIT_OUTPUT + ' characters.' : output;
  return target.root.name + ': git ' + command + '\n' + (trimmed.trim() || '(nothing)');
}

