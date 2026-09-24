import { ALPHA_ORG } from '../config/env.js';
import { projectStore } from '../store/stores.js';
import { DatabaseError } from '../store/database.js';
import { Project } from '../models/index.js';
import { githubApi } from './githubApi.js';
import { repoForProject } from './githubIssueMapping.js';
import { DEFAULT_WORKSPACE_ID } from './workspaceContext.js';
import { logInfo, logError } from './../utils/logger.js';

/**
 * The organisation's repositories are its projects.
 *
 * This is an explicit importer for a PM-authorized workflow. The normal board
 * sync only updates projects already created or attached in Alpha; it never
 * turns every organization repository into a project implicitly.
 *
 * ## Only the organisation's workspace
 *
 * Project ids, keys and issue identifiers are unique across every workspace,
 * so the same repository cannot be a project twice. The default workspace is
 * the organisation's; any other is somewhere people make their own projects,
 * and is left alone.
 *
 * ## Ids from GitHub
 *
 * A project is `gh-repo-<repository id>` and a pulled issue `gh-issue-<issue
 * id>`, both GitHub's own numbers: stable across renames and transfers of
 * ownership, and the same on every machine that reads them. Two copies of the
 * board -- Postgres in the cloud, SQLite on a desktop -- then agree on what
 * each card is without ever exchanging ids.
 *
 * ## Never deleted
 *
 * A repository that disappears from the listing -- deleted, archived, or just
 * no longer visible to the person syncing -- keeps its project. Losing sight of
 * a repository is not a reason to destroy the runs and assignments on it.
 */

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  archived: boolean;
  has_issues: boolean;
  default_branch?: string;
}

export interface DiscoveryReport {
  /** Projects made for repositories seen for the first time. */
  projectsImported: number;
  skipped: Array<{ project: string; reason: string }>;
  errors: Array<{ project: string; detail: string }>;
}

export const projectIdForRepo = (repoId: number): string => `gh-repo-${repoId}`;
export const issueIdFor = (githubIssueId: number): string => `gh-issue-${githubIssueId}`;

/**
 * A short key for a repository's cards -- `alpha-be-main` becomes `ABM`, so its
 * issues read ABM-12 -- that no other project already holds.
 *
 * Adds a number on a clash rather than failing: `ABM2` is an odd name, but a
 * repository missing from the board is worse.
 */
export function keyForRepo(name: string, taken: ReadonlySet<string>): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const base =
    (words.length > 1 ? words.map(word => word[0]).join('') : (words[0] ?? '').slice(0, 4))
      .toUpperCase()
      .slice(0, 6) || 'REPO';

  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  return key;
}

/** Why a repository is not a project, or null if it should be one. */
function reasonToSkip(repo: GitHubRepo): string | null {
  if (repo.archived) return 'archived on GitHub';
  // A board is issues; with them turned off every sync of it would fail.
  if (!repo.has_issues) return 'issues are turned off on GitHub';
  return null;
}

const isUniqueClash = (err: unknown): boolean => err instanceof DatabaseError && err.sqlState === '23505';

/** Make a project for every organisation repository that does not have one. */
export async function importOrgRepositories(
  workspaceId: string,
  report: DiscoveryReport,
  createdBy?: string
): Promise<void> {
  if (!createdBy?.trim()) {
    report.errors.push({
      project: 'organization repositories',
      detail: 'A PM creator is required before importing a repository as a project.'
    });
    return;
  }

  if (!ALPHA_ORG || workspaceId !== DEFAULT_WORKSPACE_ID) return;

  let repos: GitHubRepo[];
  try {
    // As the person syncing, so it lists what they can see on GitHub and no more.
    repos = await githubApi().getAll<GitHubRepo>(`/orgs/${ALPHA_ORG}/repos?type=all&per_page=100`);
  } catch (err: any) {
    const detail = String(err?.message ?? err).trim();
    report.errors.push({ project: ALPHA_ORG, detail });
    logError(`Could not list the repositories of ${ALPHA_ORG}:`, detail);
    return;
  }

  const existing = await projectStore().list(workspaceId);
  const ids = new Set(existing.map(project => project.id));
  const attached = new Set(existing.map(project => repoForProject(project)?.toLowerCase()).filter(Boolean));
  const taken = new Set(existing.map(project => project.key.toUpperCase()));

  // Oldest first, so which of two similar names gets the plain key does not
  // depend on the order GitHub happened to list them in.
  for (const repo of [...repos].sort((a, b) => a.id - b.id)) {
    const id = projectIdForRepo(repo.id);
    // A project someone made by hand for this repository is that repository's
    // project; making a second would split its issues between two cards.
    if (ids.has(id) || attached.has(repo.full_name.toLowerCase())) continue;

    const skip = reasonToSkip(repo);
    if (skip) {
      report.skipped.push({ project: repo.name, reason: skip });
      continue;
    }

    const project: Partial<Project> = {
      id,
      name: repo.name,
      description: repo.description ?? '',
      githubOrg: ALPHA_ORG,
      resources: [
        {
          id: `${id}-repo`,
          type: 'github_repo',
          name: repo.full_name,
          pathOrUrl: repo.html_url,
          branchOrMachine: repo.default_branch
        }
      ]
    };

    // A key can be held by a project in another workspace, which this one
    // cannot see. The database refusing it is how that is found out.
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = keyForRepo(repo.name, taken);
      taken.add(key);
      try {
        await projectStore().create(workspaceId, { ...project, key, createdBy });
        report.projectsImported += 1;
        logInfo(`Imported ${repo.full_name} as project ${key}`);
        break;
      } catch (err) {
        if (isUniqueClash(err) && attempt < 4) continue;
        const detail = String((err as Error)?.message ?? err);
        report.errors.push({ project: repo.name, detail });
        logError(`Could not import ${repo.full_name}:`, detail);
        break;
      }
    }
  }
}
