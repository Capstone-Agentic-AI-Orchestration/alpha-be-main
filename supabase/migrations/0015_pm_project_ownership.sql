-- Projects are started by project managers (fe #32).
--
-- A workspace's catalogue is the projects an active PM created: the
-- organisation's repositories are not all projects, and one with no PM behind
-- it is nobody's to run. `created_by` records that PM. The API sets it from
-- the signed-in person; these policies are the boundary for desktops, which
-- read and write this table directly with their own database token.
--
-- Who may do what:
--   read    developers, PMs and admins: every PM-owned project in the
--           workspace. Clients: only projects they are assigned to.
--   create  project managers, as themselves.
--   update  developers, PMs and admins, on PM-owned projects. Developers run
--           projects day to day; they cannot start or remove one.
--   delete  PMs and admins, on PM-owned projects.
--   owner   `created_by` never changes once set (trigger below).

alter table projects add column if not exists created_by text;

create index if not exists idx_projects_created_by
  on projects (workspace_id, created_by);

-- ─────────────────────────────────────────────────────────────────────────
-- Backfill: nothing that exists disappears.
--
-- Every project made before this had no creator, and the catalogue hides a
-- project without one. Each is given to its workspace's creator when that
-- person is an active PM there, otherwise to the workspace's longest-standing
-- active PM. A workspace with no active PM keeps its projects unowned, and
-- hidden, until one joins and claims them -- there is nobody to give them to.
-- ─────────────────────────────────────────────────────────────────────────

update projects p
set created_by = coalesce(
  (
    select w.created_by
    from workspaces w
    join workspace_members m
      on m.workspace_id = w.id and m.user_id = w.created_by
     and m.role = 'pm' and m.status = 'active'
    where w.id = p.workspace_id
  ),
  (
    select m.user_id
    from workspace_members m
    where m.workspace_id = p.workspace_id and m.role = 'pm' and m.status = 'active'
    order by m.created_at asc, m.user_id asc
    limit 1
  )
)
where p.created_by is null;

-- ─────────────────────────────────────────────────────────────────────────
-- Is this project's creator an active PM of its workspace?
-- ─────────────────────────────────────────────────────────────────────────

create or replace function alpha.pm_owned(project_workspace text, project_creator text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select project_creator is not null and exists (
    select 1 from public.workspace_members m
    where m.workspace_id = project_workspace
      and m.user_id = project_creator
      and m.role = 'pm'
      and m.status = 'active'
  )
$$;

revoke all on function alpha.pm_owned(text, text) from public;
grant execute on function alpha.pm_owned(text, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Policies
-- ─────────────────────────────────────────────────────────────────────────

drop policy if exists "members read projects" on projects;
drop policy if exists "pm-owned projects" on projects;
drop policy if exists "clients read assigned projects" on projects;
drop policy if exists "overseers write projects" on projects;
drop policy if exists "overseers add projects" on projects;
drop policy if exists "overseers change projects" on projects;
drop policy if exists "overseers remove projects" on projects;
drop policy if exists "pm add projects" on projects;
drop policy if exists "team change projects" on projects;
drop policy if exists "pm change projects" on projects;
drop policy if exists "overseers remove pm-owned projects" on projects;
drop policy if exists "pm remove projects" on projects;

create policy "pm-owned projects" on projects
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and alpha.pm_owned(workspace_id, created_by)
  );

create policy "clients read assigned projects" on projects
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) = 'client'
    and exists (
      select 1 from workspace_project_assignments a
      where a.workspace_id = projects.workspace_id
        and a.project_id = projects.id
        and a.user_id = (select alpha.login())
        and a.status = 'active'
    )
  );

create policy "pm add projects" on projects
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) = 'pm'
    and created_by = (select alpha.login())
    and alpha.pm_owned(workspace_id, created_by)
  );

create policy "team change projects" on projects
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and alpha.pm_owned(workspace_id, created_by)
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    and alpha.pm_owned(workspace_id, created_by)
  );

create policy "overseers remove pm-owned projects" on projects
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('pm', 'admin')
    and alpha.pm_owned(workspace_id, created_by)
  );

-- ─────────────────────────────────────────────────────────────────────────
-- The owner is fixed once set.
--
-- A policy cannot compare old and new values, so this does: an update may
-- fill in a missing owner (the repair a workspace with no PM needs later),
-- never replace one. Without it a developer allowed to edit a project could
-- also re-home it under another PM.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function alpha.keep_project_owner()
returns trigger
language plpgsql
as $$
begin
  if old.created_by is not null and new.created_by is distinct from old.created_by then
    raise exception 'A project''s creator cannot be changed.' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists keep_project_owner on projects;
create trigger keep_project_owner
  before update of created_by on projects
  for each row execute function alpha.keep_project_owner();
