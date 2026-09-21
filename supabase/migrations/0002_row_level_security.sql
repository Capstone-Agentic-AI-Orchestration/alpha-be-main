-- Alpha cloud control plane — row level security
--
-- Why this file is the security boundary, and not merely defence in depth.
--
-- The desktop app talks to Postgres directly. It has to: Render's free tier
-- cold-starts at around thirty seconds, and a developer will not accept that
-- on every board action, so writes cannot be proxied through the API. That
-- means a developer's machine holds a token which reaches this database, and
-- the authorization checks in the Express routes are simply not in that path.
--
-- What stands between one developer's session and another's conversations is
-- the policies below. Nothing else.
--
-- ── The claims contract ──────────────────────────────────────────────────
--
-- Alpha mints its own short-lived JWT from a session and Supabase is
-- configured to trust that issuer, so `auth.jwt()` returns Alpha's claims:
--
--   sub          GitHub login, e.g. 'LloydLim1'
--   workspace_id the active workspace for this token
--   alpha_role   'client' | 'dev' | 'pm' | 'admin'
--
-- `auth.uid()` is deliberately unused: it casts to uuid, and Alpha's subject
-- is a login. Claims are read as text throughout.
--
-- The role travels in the token rather than being read from workspace_members
-- on every check. A membership lookup inside a policy runs per row, and the
-- token is already minted from a session that resolved the role at sign-in.
-- The cost is that a role change takes effect at next token refresh.

-- ─────────────────────────────────────────────────────────────────────────
-- Claim accessors
-- ─────────────────────────────────────────────────────────────────────────
--
-- `stable` so the planner evaluates them once per statement rather than once
-- per row — the difference between an index scan and a sequential one on a
-- table of any size.

create or replace function alpha.login() returns text
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')
$$;

create or replace function alpha.workspace() returns text
language sql stable as $$
  select nullif(auth.jwt() ->> 'workspace_id', '')
$$;

-- Not named `role`: that is a reserved word in Postgres and `current_role` is
-- a built-in meaning something else entirely.
create or replace function alpha.alpha_role() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'alpha_role', 'client')
$$;

-- "Can see the whole workspace." PMs and admins oversee delivery; developers
-- and clients are scoped to what they own or are assigned.
create or replace function alpha.is_overseer() returns boolean
language sql stable as $$
  select alpha.alpha_role() in ('pm', 'admin')
$$;

create or replace function alpha.is_admin() returns boolean
language sql stable as $$
  select alpha.alpha_role() = 'admin'
$$;

-- A row in the caller's active workspace.
create or replace function alpha.in_workspace(row_workspace text) returns boolean
language sql stable as $$
  select row_workspace is not distinct from alpha.workspace()
$$;

-- A policy runs as the caller, so every accessor above is resolved with the
-- caller's privileges. Functions are executable by PUBLIC by default; a new
-- schema is not usable by anyone but its owner. Without this grant every
-- policy below fails with "permission denied for schema alpha" -- an error
-- raised before the policy has decided anything.
--
-- `authenticated` is the role Alpha's minted tokens ask for. `anon` is granted
-- too, so a tokenless request is refused by the policies and returns no rows,
-- rather than erroring on the schema first.
grant usage on schema alpha to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Enable RLS everywhere
-- ─────────────────────────────────────────────────────────────────────────
--
-- A table with RLS enabled and no policy denies everything, which is the right
-- default: a table added later and forgotten here fails closed and loudly,
-- rather than being readable by every token in the system.

alter table workspaces                    enable row level security;
alter table workspace_members             enable row level security;
alter table workspace_project_assignments enable row level security;
alter table workspace_squad_owners        enable row level security;
alter table workspace_squad_projects      enable row level security;
alter table workspace_entity_bindings     enable row level security;
alter table projects                      enable row level security;
alter table agents                        enable row level security;
alter table squads                        enable row level security;
alter table issues                        enable row level security;
alter table issue_comments                enable row level security;
alter table project_build_steps           enable row level security;
alter table skills                        enable row level security;
alter table chat_threads                  enable row level security;
alter table chat_messages                 enable row level security;
alter table agent_calls                   enable row level security;
alter table agent_call_artifacts          enable row level security;
alter table prototype_runs                enable row level security;
alter table squad_runs                    enable row level security;
alter table remote_actions                enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- Workspace and membership
-- ─────────────────────────────────────────────────────────────────────────

create policy "read own workspace" on workspaces
  for select using (id = alpha.workspace());

create policy "admins update their workspace" on workspaces
  for update using (id = alpha.workspace() and alpha.is_admin());

-- Everyone sees the roster: knowing who your colleagues are is not privileged,
-- and the team view depends on it.
create policy "read the roster" on workspace_members
  for select using (alpha.in_workspace(workspace_id));

-- Only admins change it, and `with check` as well as `using` so an admin
-- cannot move a member into a workspace they do not administer.
create policy "admins manage members" on workspace_members
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_admin())
  with check (alpha.in_workspace(workspace_id) and alpha.is_admin());

create policy "read assignments" on workspace_project_assignments
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers manage assignments" on workspace_project_assignments
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

create policy "read squad owners" on workspace_squad_owners
  for select using (alpha.in_workspace(workspace_id));

create policy "own or oversee squad ownership" on workspace_squad_owners
  for all
  using (alpha.in_workspace(workspace_id) and (user_id = alpha.login() or alpha.is_overseer()))
  with check (alpha.in_workspace(workspace_id) and (user_id = alpha.login() or alpha.is_overseer()));

create policy "read squad projects" on workspace_squad_projects
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers manage squad projects" on workspace_squad_projects
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

create policy "read bindings" on workspace_entity_bindings
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers manage bindings" on workspace_entity_bindings
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

-- ─────────────────────────────────────────────────────────────────────────
-- Shared canonical — the board
-- ─────────────────────────────────────────────────────────────────────────
--
-- Workspace-wide read is intentional and was a decision, not an oversight.
-- Developers could not previously discover projects they were not assigned to,
-- which made "All Workspace Projects" impossible and left people unable to see
-- the work they were about to be asked to do.

create policy "members read projects" on projects
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers write projects" on projects
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

create policy "members read agents" on agents
  for select using (alpha.in_workspace(workspace_id));

create policy "developers write agents" on agents
  for all
  using (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'admin'))
  with check (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'admin'));

create policy "members read squads" on squads
  for select using (alpha.in_workspace(workspace_id));

create policy "developers write squads" on squads
  for all
  using (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'admin'))
  with check (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'admin'));

-- Clients are the exception to workspace-wide read. A client is external, and
-- the issue tracker is internal delivery detail: they see specifications and
-- their own messages, not the engineering board.
create policy "internal roles read issues" on issues
  for select using (alpha.in_workspace(workspace_id) and alpha.alpha_role() <> 'client');

create policy "internal roles write issues" on issues
  for all
  using (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'pm', 'admin'))
  with check (alpha.in_workspace(workspace_id) and alpha.alpha_role() in ('dev', 'pm', 'admin'));

create policy "read comments on visible issues" on issue_comments
  for select using (
    exists (
      select 1 from issues i
      where i.id = issue_comments.issue_id
        and alpha.in_workspace(i.workspace_id)
        and alpha.alpha_role() <> 'client'
    )
  );

create policy "write comments on visible issues" on issue_comments
  for insert with check (
    exists (
      select 1 from issues i
      where i.id = issue_comments.issue_id
        and alpha.in_workspace(i.workspace_id)
        and alpha.alpha_role() in ('dev', 'pm', 'admin')
    )
  );

create policy "members read build steps" on project_build_steps
  for select using (alpha.in_workspace(workspace_id));

create policy "overseers write build steps" on project_build_steps
  for all
  using (alpha.in_workspace(workspace_id) and alpha.is_overseer())
  with check (alpha.in_workspace(workspace_id) and alpha.is_overseer());

-- Skills are a catalogue of capabilities, not workspace data, so every signed
-- token reads them and only an admin edits.
create policy "everyone reads skills" on skills
  for select using (alpha.login() is not null);

create policy "admins write skills" on skills
  for all using (alpha.is_admin()) with check (alpha.is_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- Per-developer — the privacy boundary
-- ─────────────────────────────────────────────────────────────────────────
--
-- Conversations are owner-only, with NO overseer bypass. That is deliberate
-- and is the decision this whole split was made for: a developer's prompts are
-- their working notes, not managed output. A PM sees the work — runs, stages,
-- patches, pull requests — and not the thinking that produced it.
--
-- It is also the one place where a policy differs in shape from the existing
-- `canAccessSquad`, which does grant pm/admin a bypass. The difference is
-- intentional; squads are configuration, conversations are not.

create policy "own threads" on chat_threads
  for all
  using (alpha.in_workspace(workspace_id) and owner_id = alpha.login())
  with check (alpha.in_workspace(workspace_id) and owner_id = alpha.login());

-- A message inherits its thread's owner rather than carrying a second copy of
-- that fact, which could drift out of step with it.
create policy "messages in own threads" on chat_messages
  for all
  using (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = alpha.login()
    )
  )
  with check (
    exists (
      select 1 from chat_threads t
      where t.id = chat_messages.thread_id and t.owner_id = alpha.login()
    )
  );

-- `instruction` is the prompt, so the call is as private as the conversation.
create policy "own agent calls" on agent_calls
  for all
  using (alpha.in_workspace(workspace_id) and requested_by = alpha.login())
  with check (alpha.in_workspace(workspace_id) and requested_by = alpha.login());

-- Artifacts are the exception, and the line worth being precise about: a patch
-- is work product that has to be reviewable, so overseers read it. They still
-- cannot read the instruction that produced it.
--
-- Decided from the artifact's own columns, never by reading the parent call.
-- RLS applies inside a policy's subqueries, so `exists (select 1 from
-- agent_calls ...)` would be evaluated under the *caller's* access to
-- agent_calls -- which for a PM is none, by the policy directly above. The
-- grant would silently never fire. A policy can only widen access beyond its
-- parent if it can decide without reading that parent.
create policy "read own or overseen artifacts" on agent_call_artifacts
  for select using (
    alpha.in_workspace(workspace_id) and (owner_id = alpha.login() or alpha.is_overseer())
  );

create policy "write own artifacts" on agent_call_artifacts
  for insert with check (
    alpha.in_workspace(workspace_id) and owner_id = alpha.login()
  );

-- Runs are telemetry, and telemetry is what oversight is made of. This is the
-- Live Build Room: a PM watching a developer's squad hand off between agents.
create policy "read own or overseen runs" on prototype_runs
  for select using (
    alpha.in_workspace(workspace_id) and (owner_id = alpha.login() or alpha.is_overseer())
  );

create policy "write own runs" on prototype_runs
  for all
  using (alpha.in_workspace(workspace_id) and owner_id = alpha.login())
  with check (alpha.in_workspace(workspace_id) and owner_id = alpha.login());

create policy "read own or overseen squad runs" on squad_runs
  for select using (
    alpha.in_workspace(workspace_id) and (owner_id = alpha.login() or alpha.is_overseer())
  );

create policy "write own squad runs" on squad_runs
  for all
  using (alpha.in_workspace(workspace_id) and owner_id = alpha.login())
  with check (alpha.in_workspace(workspace_id) and owner_id = alpha.login());

-- ─────────────────────────────────────────────────────────────────────────
-- Audit
-- ─────────────────────────────────────────────────────────────────────────
--
-- Insert and select only. No update policy, no delete policy — and with RLS
-- enabled, an operation with no policy is denied. An actor who can rewrite
-- their own audit trail has not been audited, so the omission is the feature.

create policy "read own or overseen audit" on remote_actions
  for select using (
    alpha.in_workspace(workspace_id) and (actor = alpha.login() or alpha.is_overseer())
  );

create policy "append to own audit" on remote_actions
  for insert with check (alpha.in_workspace(workspace_id) and actor = alpha.login());
