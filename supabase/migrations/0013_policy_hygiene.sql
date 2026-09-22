-- Alpha cloud control plane — the same rules, read once per statement
--
-- Two advisories, fixed together because they interact.
--
-- **The accessors had a mutable search_path.** `alpha.login()` and the rest
-- resolve `auth.jwt()`; with the caller free to set `search_path`, what those
-- names resolve to is the caller's to decide. Every policy in the system is
-- built on them, so this is the one place where that matters most.
--
-- **Every table was checked twice on a read.** A `for all` policy's `using`
-- clause applies to SELECT as well, and permissive policies are OR'd -- so
-- each table had its read policy plus the read half of its write policy, both
-- evaluated for every row. The write rules are split into insert, update and
-- delete here, which leaves exactly one policy per table per read. `0011` did
-- this for `agents` already, for a sharper reason: the write rule was granting
-- reads it was never meant to.
--
-- ## Why the order matters
--
-- Setting `search_path` on a SQL function stops PostgreSQL inlining it, and an
-- un-inlined function in a policy is called once per row. So the calls are
-- wrapped as `(select alpha.x())` first, which makes each an InitPlan --
-- evaluated once per statement, whatever the row count. `alpha.in_workspace`
-- takes a column and cannot be an InitPlan at all, so its callers compare
-- against `(select alpha.workspace())` directly; the function stays for
-- anything else that uses it.
--
-- Nothing about who may do what changes here. `rlsPolicies.test.ts` is the
-- check on that, and every rule it states still holds.

-- ─────────────────────────────────────────────────────────────────────────
-- Accessors: same answers, fixed resolution
-- ─────────────────────────────────────────────────────────────────────────

create or replace function alpha.claims() returns jsonb
language sql stable
set search_path = ''
as $$
  select case when auth.jwt() ->> 'iss' = 'alpha' then auth.jwt() else '{}'::jsonb end
$$;

create or replace function alpha.login() returns text
language sql stable
set search_path = ''
as $$
  select nullif(alpha.claims() ->> 'sub', '')
$$;

create or replace function alpha.workspace() returns text
language sql stable
set search_path = ''
as $$
  select nullif(alpha.claims() ->> 'workspace_id', '')
$$;

create or replace function alpha.alpha_role() returns text
language sql stable
set search_path = ''
as $$
  select coalesce(alpha.claims() ->> 'alpha_role', 'client')
$$;

create or replace function alpha.is_overseer() returns boolean
language sql stable
set search_path = ''
as $$
  select alpha.alpha_role() in ('pm', 'admin')
$$;

create or replace function alpha.is_admin() returns boolean
language sql stable
set search_path = ''
as $$
  select alpha.alpha_role() = 'admin'
$$;

create or replace function alpha.in_workspace(row_workspace text) returns boolean
language sql stable
set search_path = ''
as $$
  select row_workspace is not distinct from alpha.workspace()
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Workspace and membership
-- ─────────────────────────────────────────────────────────────────────────

drop policy if exists "read own workspace" on workspaces;
create policy "read own workspace" on workspaces
  for select using (id = (select alpha.workspace()));

drop policy if exists "admins update their workspace" on workspaces;
create policy "admins update their workspace" on workspaces
  for update using (id = (select alpha.workspace()) and (select alpha.is_admin()));

drop policy if exists "read the roster" on workspace_members;
create policy "read the roster" on workspace_members
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "admins manage members" on workspace_members;
create policy "admins add members" on workspace_members
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_admin()));
create policy "admins change members" on workspace_members
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_admin()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_admin()));
create policy "admins remove members" on workspace_members
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_admin()));

drop policy if exists "read assignments" on workspace_project_assignments;
create policy "read assignments" on workspace_project_assignments
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers manage assignments" on workspace_project_assignments;
create policy "overseers add assignments" on workspace_project_assignments
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change assignments" on workspace_project_assignments
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers remove assignments" on workspace_project_assignments
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

drop policy if exists "read squad owners" on workspace_squad_owners;
create policy "read squad owners" on workspace_squad_owners
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "own or oversee squad ownership" on workspace_squad_owners;
create policy "claim squad ownership" on workspace_squad_owners
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (user_id = (select alpha.login()) or (select alpha.is_overseer()))
  );
create policy "change squad ownership" on workspace_squad_owners
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (user_id = (select alpha.login()) or (select alpha.is_overseer()))
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (user_id = (select alpha.login()) or (select alpha.is_overseer()))
  );
create policy "release squad ownership" on workspace_squad_owners
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (user_id = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "read squad projects" on workspace_squad_projects;
create policy "read squad projects" on workspace_squad_projects
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers manage squad projects" on workspace_squad_projects;
create policy "overseers assign squads" on workspace_squad_projects
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change squad assignments" on workspace_squad_projects
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers unassign squads" on workspace_squad_projects
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

drop policy if exists "read bindings" on workspace_entity_bindings;
create policy "read bindings" on workspace_entity_bindings
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers manage bindings" on workspace_entity_bindings;
create policy "overseers add bindings" on workspace_entity_bindings
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change bindings" on workspace_entity_bindings
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers remove bindings" on workspace_entity_bindings
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

-- ─────────────────────────────────────────────────────────────────────────
-- The board
-- ─────────────────────────────────────────────────────────────────────────

drop policy if exists "members read projects" on projects;
create policy "members read projects" on projects
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers write projects" on projects;
create policy "overseers add projects" on projects
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change projects" on projects
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers remove projects" on projects
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

-- `agents` was split by 0011; this only lifts the calls out of the row loop.
-- The 0002 names are dropped too, so this migration lands the same way on a
-- database that has 0011 and on one that does not -- otherwise the old write
-- policy would survive beside these and keep granting the reads 0011 removed.
drop policy if exists "members read agents" on agents;
drop policy if exists "developers write agents" on agents;
drop policy if exists "members read agents they may address" on agents;
create policy "members read agents they may address" on agents
  for select using (
    workspace_id is not distinct from (select alpha.workspace()) and (
      coalesce(allowed_users, 'team') = 'everyone'
      or (coalesce(allowed_users, 'team') = 'team' and (select alpha.alpha_role()) <> 'client')
      or (allowed_users = 'admins' and (select alpha.is_admin()))
      or (allowed_users = 'private' and owner = (select alpha.login()))
    )
  );

drop policy if exists "developers add agents" on agents;
drop policy if exists "developers change agents" on agents;
drop policy if exists "developers remove agents" on agents;
create policy "developers add agents" on agents
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  );
create policy "developers change agents" on agents
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  );
create policy "developers remove agents" on agents
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = (select alpha.login()))
  );

drop policy if exists "members read squads" on squads;
create policy "members read squads" on squads
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "developers write squads" on squads;
create policy "developers add squads" on squads
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
  );
create policy "developers change squads" on squads
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
  );
create policy "developers remove squads" on squads
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'admin')
  );

drop policy if exists "internal roles read issues" on issues;
create policy "internal roles read issues" on issues
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) <> 'client'
  );

drop policy if exists "internal roles write issues" on issues;
create policy "internal roles add issues" on issues
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
  );
create policy "internal roles change issues" on issues
  for update using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
  );
create policy "internal roles remove issues" on issues
  for delete using (
    workspace_id is not distinct from (select alpha.workspace())
    and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
  );

drop policy if exists "read comments on visible issues" on issue_comments;
create policy "read comments on visible issues" on issue_comments
  for select using (
    exists (
      select 1 from issues i
      where i.id = issue_comments.issue_id
        and i.workspace_id is not distinct from (select alpha.workspace())
        and (select alpha.alpha_role()) <> 'client'
    )
  );

drop policy if exists "write comments on visible issues" on issue_comments;
create policy "write comments on visible issues" on issue_comments
  for insert with check (
    exists (
      select 1 from issues i
      where i.id = issue_comments.issue_id
        and i.workspace_id is not distinct from (select alpha.workspace())
        and (select alpha.alpha_role()) in ('dev', 'pm', 'admin')
    )
  );

drop policy if exists "members read build steps" on project_build_steps;
create policy "members read build steps" on project_build_steps
  for select using (workspace_id is not distinct from (select alpha.workspace()));

drop policy if exists "overseers write build steps" on project_build_steps;
create policy "overseers add build steps" on project_build_steps
  for insert with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers change build steps" on project_build_steps
  for update using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()))
  with check (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));
create policy "overseers remove build steps" on project_build_steps
  for delete using (workspace_id is not distinct from (select alpha.workspace()) and (select alpha.is_overseer()));

drop policy if exists "everyone reads skills" on skills;
create policy "everyone reads skills" on skills
  for select using ((select alpha.login()) is not null);

drop policy if exists "admins write skills" on skills;
create policy "admins add skills" on skills
  for insert with check ((select alpha.is_admin()));
create policy "admins change skills" on skills
  for update using ((select alpha.is_admin())) with check ((select alpha.is_admin()));
create policy "admins remove skills" on skills
  for delete using ((select alpha.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────
-- Per-developer — the privacy boundary, unchanged
-- ─────────────────────────────────────────────────────────────────────────
--
-- These tables had only a `for all` policy, so splitting it means writing the
-- read half down explicitly. Same rule, said in four places instead of one:
-- owner-only, with no overseer bypass.

drop policy if exists "own threads" on chat_threads;
create policy "read own threads" on chat_threads
  for select using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "start own threads" on chat_threads
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "change own threads" on chat_threads
  for update using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "delete own threads" on chat_threads
  for delete using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );

drop policy if exists "messages in own threads" on chat_messages;
create policy "read messages in own threads" on chat_messages
  for select using (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  );
create policy "add messages to own threads" on chat_messages
  for insert with check (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  );
create policy "change messages in own threads" on chat_messages
  for update using (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  )
  with check (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  );
create policy "delete messages in own threads" on chat_messages
  for delete using (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = (select alpha.login())
    )
  );

drop policy if exists "own agent calls" on agent_calls;
create policy "read own agent calls" on agent_calls
  for select using (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  );
create policy "make own agent calls" on agent_calls
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  );
create policy "change own agent calls" on agent_calls
  for update using (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  );
create policy "delete own agent calls" on agent_calls
  for delete using (
    workspace_id is not distinct from (select alpha.workspace()) and requested_by = (select alpha.login())
  );

drop policy if exists "read own or overseen artifacts" on agent_call_artifacts;
create policy "read own or overseen artifacts" on agent_call_artifacts
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (owner_id = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "write own artifacts" on agent_call_artifacts;
create policy "write own artifacts" on agent_call_artifacts
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );

drop policy if exists "read own or overseen runs" on prototype_runs;
create policy "read own or overseen runs" on prototype_runs
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (owner_id = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "write own runs" on prototype_runs;
create policy "start own runs" on prototype_runs
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "change own runs" on prototype_runs
  for update using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "delete own runs" on prototype_runs
  for delete using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );

drop policy if exists "read own or overseen squad runs" on squad_runs;
create policy "read own or overseen squad runs" on squad_runs
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (owner_id = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "write own squad runs" on squad_runs;
create policy "start own squad runs" on squad_runs
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "change own squad runs" on squad_runs
  for update using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  )
  with check (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );
create policy "delete own squad runs" on squad_runs
  for delete using (
    workspace_id is not distinct from (select alpha.workspace()) and owner_id = (select alpha.login())
  );

-- The audit log keeps its shape: select and insert, and no policy at all for
-- update or delete. An actor who can rewrite their own trail has not been
-- audited, so the omission is the feature.
drop policy if exists "read own or overseen audit" on remote_actions;
create policy "read own or overseen audit" on remote_actions
  for select using (
    workspace_id is not distinct from (select alpha.workspace())
    and (actor = (select alpha.login()) or (select alpha.is_overseer()))
  );

drop policy if exists "append to own audit" on remote_actions;
create policy "append to own audit" on remote_actions
  for insert with check (
    workspace_id is not distinct from (select alpha.workspace()) and actor = (select alpha.login())
  );
