-- Internal team members may maintain the agent roster.
--
-- Agents are workspace execution personas rather than repositories or
-- projects. Project managers staff the personas used by their projects;
-- developers maintain the local personas they run; admins retain oversight.
-- Clients remain read-only. The API's workspaceRegistry uses the same role
-- set, so the browser control and the database boundary cannot drift apart.

drop policy if exists "developers add agents" on agents;
drop policy if exists "developers change agents" on agents;
drop policy if exists "developers remove agents" on agents;
drop policy if exists "internal members add agents" on agents;
drop policy if exists "internal members change agents" on agents;
drop policy if exists "internal members remove agents" on agents;

create policy "internal members add agents" on agents
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  );

create policy "internal members change agents" on agents
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  );

create policy "internal members remove agents" on agents
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  );
