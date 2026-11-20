/**
 * The preview a client sees for one project, as one row (repository, branch, url, updated_at),
 * for use in `left join lateral (...) alias on true`.
 *
 * What the project manager shared through the client-preview endpoint decides: once a PM has
 * shared or stopped sharing (a row in client_project_previews), that choice is final, and only
 * hosted `uat` previews reach clients. Projects with no such row fall back to the latest
 * published UAT round for this client, from before sharing moved to that endpoint.
 *
 * The client project list, a client's request detail and the PM's client summary all read the
 * preview through this one query, so they always agree on what the client can see.
 */
export function clientProjectPreviewSql(workspaceId: string, projectId: string, clientUserId: string): string {
  return `select
      case when shared.project_id is null then round.repository when shared.branch = 'uat' then shared.repository end as repository,
      case when shared.project_id is null then round.branch when shared.branch = 'uat' then shared.branch end as branch,
      case when shared.project_id is null then round.url when shared.branch = 'uat' then shared.url end as url,
      coalesce(shared.updated_at, round.updated_at) as updated_at
    from (select 1) as one
    left join alpha_private.client_project_previews shared
      on shared.workspace_id = ${workspaceId} and shared.project_id = ${projectId}
    left join lateral (
      select r.updated_at, r.build->'frontend'->>'repository' as repository, 'uat'::text as branch, r.build->'frontend'->>'url' as url
      from alpha_private.client_uat_rounds r
      where r.workspace_id = ${workspaceId} and r.project_id = ${projectId} and r.client_user_id = ${clientUserId}
        and r.status in ('published','submitted') and r.published_at is not null
      order by r.number desc limit 1
    ) round on shared.project_id is null`;
}
