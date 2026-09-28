-- Who changed a hosted repository's environment, and how -- never what to.
--
-- Alpha writes environment variables into Render services and Vercel
-- projects for people and for agents. Every change is recorded here: the
-- repository, the environment, the keys, whether a person or an agent made
-- it (and which run), and whether the platform accepted it.
--
-- Values are never stored. There is no column that could hold one, and the
-- keys column only admits environment-variable names, so a value cannot be
-- smuggled in where a key belongs.
--
-- Server-only, like sessions (0007): `alpha_private` is not an exposed
-- schema, nothing is granted on it, and RLS is on with no policies as the
-- last line should a grant ever slip in. The API reads and writes it with
-- its own connection.

create schema if not exists alpha_private;
revoke all on schema alpha_private from public, anon, authenticated;

create table if not exists alpha_private.hosting_audit (
  id           uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  repo         text not null check (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  environment  text check (environment in ('main', 'uat', 'dev')),
  action       text not null check (action in ('env_set', 'env_delete', 'redeploy')),
  keys         text[] not null default '{}'
               check (array_to_string(keys, ',') ~ '^([A-Z_][A-Z0-9_]*(,[A-Z_][A-Z0-9_]*)*)?$'),
  actor_login  text not null,
  actor_kind   text not null check (actor_kind in ('user', 'agent')),
  run_id       text,
  agent_id     text,
  result       text not null check (result in ('ok', 'partial', 'failed')),
  error        text check (char_length(error) <= 500),
  created_at   timestamptz not null default now()
);

create index if not exists hosting_audit_repo_created
  on alpha_private.hosting_audit (workspace_id, repo, created_at desc);

alter table alpha_private.hosting_audit enable row level security;
revoke all on alpha_private.hosting_audit from public, anon, authenticated;
