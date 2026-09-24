-- Projects and repositories are initiated by project managers.
--
-- The API records the authenticated PM in `created_by`, but the policy is the
-- security boundary for desktop clients that write to Supabase directly.

alter table projects add column if not exists created_by text;

create index if not exists idx_projects_created_by
  on projects (workspace_id, created_by);

-- Rows created before creator attribution remain NULL and are intentionally
-- hidden until a PM explicitly repairs their ownership. Inferring an owner
-- from membership would make an administrator's legacy project look PM-owned.

drop policy if exists "members read projects" on projects;
drop policy if exists "pm-owned projects" on projects;
drop policy if exists "clients read assigned projects" on projects;
create policy "pm-owned projects" on projects
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and exists (
      select 1
      from workspace_members m
      where m.workspace_id = projects.workspace_id
        and m.user_id = projects.created_by
        and m.role = 'pm'
        and m.status = 'active'
    )
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
  );

create policy "clients read assigned projects" on projects
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) = 'client'
    and exists (
      select 1
      from workspace_project_assignments a
      where a.workspace_id = projects.workspace_id
        and a.project_id = projects.id
        and a.user_id = (select alpha.login())
        and a.status = 'active'
    )
  );

drop policy if exists "overseers write projects" on projects;
drop policy if exists "overseers add projects" on projects;
drop policy if exists "overseers change projects" on projects;
drop policy if exists "overseers remove projects" on projects;
create policy "pm add projects" on projects
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) = 'pm'
    and created_by = (select alpha.login())
    and exists (
      select 1
      from workspace_members m
      where m.workspace_id = projects.workspace_id
        and m.user_id = created_by
        and m.role = 'pm'
        and m.status = 'active'
    )
  );

create policy "pm change projects" on projects
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) = 'pm'
    and exists (
      select 1
      from workspace_members m
      where m.workspace_id = projects.workspace_id
        and m.user_id = projects.created_by
        and m.role = 'pm'
        and m.status = 'active'
    )
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) = 'pm'
    and exists (
      select 1
      from workspace_members m
      where m.workspace_id = projects.workspace_id
        and m.user_id = projects.created_by
        and m.role = 'pm'
        and m.status = 'active'
    )
  );

create policy "pm remove projects" on projects
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) = 'pm'
    and exists (
      select 1
      from workspace_members m
      where m.workspace_id = projects.workspace_id
        and m.user_id = projects.created_by
        and m.role = 'pm'
        and m.status = 'active'
    )
  );
