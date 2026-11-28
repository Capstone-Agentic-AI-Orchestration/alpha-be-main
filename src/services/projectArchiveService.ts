import type { Project } from '../models/index.js';
import { projectStore } from '../store/stores.js';
import { logInfo } from '../utils/logger.js';
import { githubApi, GitHubApiError } from './githubApi.js';
import { reposForProject } from './githubIssueMapping.js';

/**
 * Archiving a project, and restoring it.
 *
 * Archiving is the reversible way to put a project away: it leaves the project
 * lists, its repositories become read-only on GitHub, and its board, history
 * and client tickets stay. Restoring undoes both. Hosting is left alone either
 * way, because tearing it down is the one step a restore could not give back.
 *
 * A repository GitHub will not change (no admin rights, an organization rule)
 * does not stop the project being archived: the outcome says which repository
 * failed, and archiving again retries just those.
 */

export type RepoArchiveState = 'archived' | 'already_archived' | 'restored' | 'already_active' | 'not_found' | 'failed';

export interface RepoArchiveOutcome {
  repo: string;
  state: RepoArchiveState;
  error?: string;
}

export interface ProjectArchiveResult {
  project: Project;
  repositories: RepoArchiveOutcome[];
}

async function setRepoArchived(repo: string, archived: boolean): Promise<RepoArchiveOutcome> {
  try {
    const info = await githubApi().get<{ archived?: boolean; permissions?: { admin?: boolean } }>(`/repos/${repo}`);
    if (Boolean(info.archived) === archived) return { repo, state: archived ? 'already_archived' : 'already_active' };
    if (!info.permissions?.admin) {
      return { repo, state: 'failed', error: `${archived ? 'Archiving' : 'Unarchiving'} ${repo} needs admin rights on it on GitHub.` };
    }
    await githubApi().patch(`/repos/${repo}`, { archived });
    return { repo, state: archived ? 'archived' : 'restored' };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return { repo, state: 'not_found' };
    return { repo, state: 'failed', error: (err as Error).message };
  }
}

/** Archive or unarchive each repository in turn; one failing never stops the rest. */
export async function setRepositoriesArchived(repos: string[], archived: boolean): Promise<RepoArchiveOutcome[]> {
  const outcomes: RepoArchiveOutcome[] = [];
  for (const repo of repos) outcomes.push(await setRepoArchived(repo, archived));
  return outcomes;
}

const describeOutcomes = (outcomes: RepoArchiveOutcome[]) =>
  outcomes.map(outcome => outcome.repo + ' ' + outcome.state).join(', ') || 'none';

/** Archive the project's repositories, then the project. Archiving an archived project retries its repositories. */
export async function archiveProject(input: { workspaceId: string; project: Project; by: string }): Promise<ProjectArchiveResult> {
  const { workspaceId, project, by } = input;
  const repositories = await setRepositoriesArchived(reposForProject(project), true);
  const archive = project.archivedAt ? { at: project.archivedAt, by: project.archivedBy ?? by } : { at: new Date().toISOString(), by };
  const updated = await projectStore().setArchived(workspaceId, project.id, archive);
  logInfo(`Archived project ${project.key}; repositories: ${describeOutcomes(repositories)}`);
  return { project: updated ?? { ...project, archivedAt: archive.at, archivedBy: archive.by }, repositories };
}

/** Unarchive the project's repositories, then bring the project back. */
export async function restoreProject(input: { workspaceId: string; project: Project }): Promise<ProjectArchiveResult> {
  const { workspaceId, project } = input;
  const repositories = await setRepositoriesArchived(reposForProject(project), false);
  const updated = await projectStore().setArchived(workspaceId, project.id, null);
  logInfo(`Restored project ${project.key}; repositories: ${describeOutcomes(repositories)}`);
  return { project: updated ?? { ...project, archivedAt: undefined, archivedBy: undefined }, repositories };
}
