import { ALPHA_CLOUD_API, IS_CLOUD } from '../config/env.js';
import { sameRepository } from '../utils/repositoryName.js';
import { database, type Sql } from '../store/database.js';
import { cloudRequest } from './cloudWorkspaces.js';
import { githubApi, type GitHubApi } from './githubApi.js';
import { RepoWorkspaceError } from './githubRepoWorkspace.js';

/**
 * Whether `uat` may go to production: the release rule, checked where the
 * release happens.
 *
 * The project manager and the client test UAT; when the client approves, the
 * project manager merges `uat` into `main`. So for a project with a client,
 * production needs the client's latest submitted UAT round for the commit now
 * on `uat` to have passed. A round for an older build approves nothing: the
 * client never saw what is on `uat` now. A project no client can see goes on
 * the project manager's decision, as before, and says so.
 *
 * UAT rounds live in the cloud's database. The cloud reads them directly; a
 * desktop asks the cloud as the signed-in person, and refuses when it cannot.
 */

export type ProductionReadiness =
  | { state: 'approved'; repository: string; sha: string; round: number; submittedAt: string }
  | { state: 'no_client'; repository: string; sha: string; reason: string }
  | { state: 'not_approved'; repository: string; sha: string; reason: string; round?: number; outcome?: string };

interface BuildPart {
  repository?: string;
  commitSha?: string;
}

export interface SubmittedRound {
  number: number;
  outcome: string | null;
  submittedAt: string;
  build: { frontend?: BuildPart; backends?: BuildPart[] } | null;
}

const SHA = /^[a-f0-9]{40,64}$/i;

/** Whether the client tested `repository` at exactly `sha` in this build. */
export function builtFrom(build: SubmittedRound['build'], repository: string, sha: string): boolean {
  const parts = [build?.frontend, ...(build?.backends ?? [])];
  return parts.some(part =>
    Boolean(part) && sameRepository(part?.repository, repository) && part?.commitSha?.toLowerCase() === sha.toLowerCase());
}

export function decideReadiness(input: {
  repository: string;
  sha: string;
  hasClient: boolean;
  anyRounds: boolean;
  submitted: SubmittedRound[];
}): ProductionReadiness {
  const { repository, sha } = input;
  const short = sha.slice(0, 7);
  const matching = input.submitted
    .filter(round => builtFrom(round.build, repository, sha))
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const latest = matching[0];
  if (latest?.outcome === 'passed') {
    return { state: 'approved', repository, sha, round: latest.number, submittedAt: latest.submittedAt };
  }
  if (latest) {
    return {
      state: 'not_approved', repository, sha, round: latest.number, outcome: latest.outcome ?? undefined,
      reason: `The client's latest UAT round for ${repository} at ${short} (round ${latest.number}) ended ${latest.outcome ?? 'without an outcome'}. Fix what they reported, deploy it to uat, and publish a new round.`
    };
  }
  if (input.hasClient || input.anyRounds) {
    return {
      state: 'not_approved', repository, sha,
      reason: `The client has not passed UAT for ${repository} at ${short}, the commit now on uat. Publish a UAT round for this build and wait for the client to pass it.`
    };
  }
  return {
    state: 'no_client', repository, sha,
    reason: 'No client has access to this project, so production goes on the project manager\'s decision.'
  };
}

/** The cloud's own answer, from the UAT rounds and client grants in its database. */
export async function readinessFromDatabase(sql: Sql, workspaceId: string, projectId: string, repository: string, sha: string) {
  const { rows: submitted } = await sql.query<{ number: number; outcome: string | null; submitted_at: Date | string; build: SubmittedRound['build'] }>(
    `select number, outcome, submitted_at, build from alpha_private.client_uat_rounds
      where workspace_id=$1 and project_id=$2 and status='submitted' and submitted_at is not null`,
    [workspaceId, projectId]
  );
  const { rows: [facts] } = await sql.query<{ any_rounds: boolean; has_client: boolean }>(
    `select exists(select 1 from alpha_private.client_uat_rounds where workspace_id=$1 and project_id=$2) as any_rounds,
      exists(select 1 from alpha_private.tickets t
        join alpha_private.ticket_client_grants cg on cg.workspace_id=t.workspace_id and cg.ticket_id=t.id
          and cg.client_user_id=t.client_user_id and cg.active and cg.revoked_at is null
        where t.workspace_id=$1 and t.project_id=$2 and t.project_client_visible) as has_client`,
    [workspaceId, projectId]
  );
  return decideReadiness({
    repository, sha,
    hasClient: Boolean(facts?.has_client),
    anyRounds: Boolean(facts?.any_rounds),
    submitted: submitted.map(row => ({
      number: row.number, outcome: row.outcome, build: row.build,
      submittedAt: new Date(row.submitted_at).toISOString()
    }))
  });
}

/** The commit on `uat` now. */
export async function uatHead(repository: string, api: GitHubApi = githubApi()): Promise<string> {
  return (await api.get<{ commit: { sha: string } }>(`/repos/${repository}/branches/uat`)).commit.sha;
}

/**
 * Production readiness for `repository` at `sha` (the current `uat` head when
 * omitted). Fails closed: a desktop that cannot reach the cloud gets an error,
 * never a pass.
 */
export async function productionReadiness(
  workspaceId: string,
  projectId: string,
  repository: string,
  sha?: string
): Promise<ProductionReadiness> {
  const commit = sha ?? (await uatHead(repository));
  if (!SHA.test(commit)) throw new RepoWorkspaceError('A full commit SHA is required.', 400);
  if (IS_CLOUD) return database().transaction(sql => readinessFromDatabase(sql, workspaceId, projectId, repository, commit));

  if (!ALPHA_CLOUD_API) {
    throw new RepoWorkspaceError('Production promotion needs the client\'s UAT approval, which this desktop cannot check without an Alpha cloud connection.', 503);
  }
  const answer = await cloudRequest<ProductionReadiness | { error?: string }>(
    `/projects/${encodeURIComponent(projectId)}/repos/${repository}/production-readiness?sha=${commit}`,
    { workspaceId }
  ).catch(() => null);
  if (!answer || answer.status !== 200 || !answer.body || !('state' in answer.body)) {
    const detail = answer?.body && 'error' in answer.body && answer.body.error ? ` (${answer.body.error})` : '';
    throw new RepoWorkspaceError(`Could not confirm the client's UAT approval with Alpha cloud${detail}. Production promotion was not opened.`, 503);
  }
  return answer.body;
}
