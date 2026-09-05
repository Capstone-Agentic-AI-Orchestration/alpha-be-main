import fs from 'node:fs';
import path from 'node:path';

/**
 * Is this folder usable as a project's working copy?
 *
 * Attaching a folder is the main way a developer who already has a checkout
 * points Alpha at it, and it is the first thing a new collaborator does. Every
 * way it can be wrong used to surface at the same moment — the middle of an
 * agent run, as a "Git branch checkout notice" that the run then ignored.
 *
 * Measured: a project attached to `…/Capstone/Alpha-v2` — a folder holding
 * three repositories rather than being one — produced a run that failed to
 * create a branch, edited files anyway, and finished with no commit and no PR.
 * Nothing in that sequence said the path was the problem.
 *
 * So the check happens when the folder is chosen, while the person is looking
 * at the field they got wrong.
 */

export type WorkspaceProblem =
  | 'missing'
  | 'not_a_directory'
  | 'not_a_repo'
  | 'nested_repos';

export interface WorkspaceCheck {
  ok: boolean;
  problem?: WorkspaceProblem;
  /** One sentence naming what is wrong and what would fix it. */
  detail?: string;
}

/** Directories that hold repositories rather than being one. */
function childRepositories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.git')))
      .map(e => e.name);
  } catch {
    return [];
  }
}

export function checkWorkspace(dir: unknown): WorkspaceCheck {
  if (typeof dir !== 'string' || !dir.trim()) {
    return { ok: false, problem: 'missing', detail: 'A folder path is required.' };
  }

  const resolved = path.resolve(dir.trim());

  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      problem: 'missing',
      detail: `Nothing exists at ${resolved}.`
    };
  }

  if (!fs.statSync(resolved).isDirectory()) {
    return {
      ok: false,
      problem: 'not_a_directory',
      detail: `${resolved} is a file, not a folder.`
    };
  }

  if (!fs.existsSync(path.join(resolved, '.git'))) {
    /**
     * The nested case is called out separately because it is the one that looks
     * right. A monorepo-shaped folder of sibling checkouts is what someone
     * naturally points at, and the fix is to name one of them.
     */
    const children = childRepositories(resolved);
    if (children.length) {
      return {
        ok: false,
        problem: 'nested_repos',
        detail:
          `${resolved} is not a repository — it contains ${children.length}: ` +
          `${children.slice(0, 4).join(', ')}${children.length > 4 ? '…' : ''}. ` +
          `Attach one of them instead, or add a project per repository.`
      };
    }

    return {
      ok: false,
      problem: 'not_a_repo',
      detail:
        `${resolved} is not a git repository, so an agent could not create a ` +
        `branch or commit its work. Run \`git init\` there, or attach a checkout.`
    };
  }

  return { ok: true };
}
