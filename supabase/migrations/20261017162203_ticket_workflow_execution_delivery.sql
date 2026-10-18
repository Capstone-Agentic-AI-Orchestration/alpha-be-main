-- Ticket lifecycle authority. Private, additive and independent of client Auth.
create table alpha_private.ticket_scope_operations (
  workspace_id text not null, ticket_id text not null, actor_id text not null,
  operation_id text not null, fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'), receipt jsonb not null,
  primary key(workspace_id,ticket_id,actor_id,operation_id),
  foreign key(workspace_id,ticket_id) references alpha_private.tickets(workspace_id,id) on delete restrict
);

create table alpha_private.ticket_work_bindings (
  workspace_id text not null, ticket_id text not null, project_id text not null references public.projects(id) on delete restrict,
  issue_id text not null references public.issues(id) on delete restrict, scope_version_id text not null,
  initial_revision_id text not null, current_revision_id text not null, authorized_by text not null, authorized_at timestamptz not null,
  primary key(workspace_id,issue_id),
  foreign key(workspace_id,ticket_id,scope_version_id) references alpha_private.ticket_scopes(workspace_id,ticket_id,id) on delete restrict
);
create index ticket_work_bindings_ticket_idx on alpha_private.ticket_work_bindings(workspace_id,ticket_id,issue_id);
-- Parent deletes/updates validate these single-column references by their
-- referenced key; keep the child lookups indexed as the ticket volume grows.
create index ticket_work_bindings_issue_fk_idx on alpha_private.ticket_work_bindings(issue_id);
create index ticket_work_bindings_project_fk_idx on alpha_private.ticket_work_bindings(project_id);

create table alpha_private.ticket_issue_revisions (
  workspace_id text not null, ticket_id text not null, project_id text not null,
  issue_id text not null, scope_version_id text not null, revision_id text not null,
  previous_revision_id text, instructions text, source text check(source in ('request_fixes','authorize_correction')),
  authorized_by text not null, authorized_at timestamptz not null,
  primary key(workspace_id,issue_id,revision_id),
  foreign key(workspace_id,issue_id) references alpha_private.ticket_work_bindings(workspace_id,issue_id) on delete restrict
);

create table alpha_private.ticket_issue_reviews (
  workspace_id text not null, issue_id text not null, revision_id text not null,
  reviewed_by text not null, verdict text not null check(verdict='passed'),
  run_id text, reviewed_at timestamptz not null default now(), evidence jsonb not null,
  primary key(workspace_id,issue_id,revision_id),
  foreign key(workspace_id,issue_id,revision_id) references alpha_private.ticket_issue_revisions(workspace_id,issue_id,revision_id) on delete restrict
);

create table alpha_private.ticket_execution_claims (
  id text primary key, workspace_id text not null, ticket_id text not null, project_id text not null,
  issue_id text not null, scope_version_id text not null, issue_revision_id text not null,
  developer_id text not null, executor_kind text not null check(executor_kind in ('agent','squad','human')),
  executor_id text not null, phase text not null check(phase in ('reserved','admitted','stopped')),
  run_id text, created_at timestamptz not null default now(), stopped_at timestamptz,
  foreign key(workspace_id,issue_id,issue_revision_id) references alpha_private.ticket_issue_revisions(workspace_id,issue_id,revision_id) on delete restrict
);
create unique index ticket_one_active_issue_claim on alpha_private.ticket_execution_claims(workspace_id,issue_id) where phase in ('reserved','admitted');
create index ticket_execution_claims_ticket_idx on alpha_private.ticket_execution_claims(workspace_id,ticket_id,phase);
create index ticket_execution_claims_revision_fk_idx on alpha_private.ticket_execution_claims(workspace_id,issue_id,issue_revision_id);

create table alpha_private.ticket_execution_operations (
  workspace_id text not null, issue_id text not null, actor_id text not null, operation_id text not null,
  fingerprint text not null, receipt jsonb not null,
  primary key(workspace_id,issue_id,actor_id,operation_id),
  foreign key(workspace_id,issue_id) references alpha_private.ticket_work_bindings(workspace_id,issue_id) on delete restrict
);
create table alpha_private.ticket_execution_dispatches (
  verification_id text primary key, claim_id text not null references alpha_private.ticket_execution_claims(id) on delete restrict,
  run_id text not null, developer_id text not null, executor_kind text not null, executor_id text not null,
  next_member_order integer not null default 0 check(next_member_order>=0),
  unique(claim_id,run_id)
);

create table alpha_private.ticket_ready_manifests (
  id text not null, workspace_id text not null, ticket_id text not null, scope_version_id text not null,
  manifest_hash text not null check(manifest_hash ~ '^[a-f0-9]{64}$'), readiness jsonb not null,
  primary key(workspace_id,ticket_id,id), unique(workspace_id,ticket_id,manifest_hash),
  foreign key(workspace_id,ticket_id,scope_version_id) references alpha_private.ticket_scopes(workspace_id,ticket_id,id) on delete restrict
);
create table alpha_private.ticket_delivery_registrations (
  workspace_id text not null, ticket_id text not null, id text not null, ready_manifest_id text not null,
  snapshot jsonb not null, operation_id text not null, created_by text not null,
  primary key(workspace_id,ticket_id,id), unique(workspace_id,ticket_id,created_by,operation_id),
  foreign key(workspace_id,ticket_id,id) references alpha_private.ticket_deliveries(workspace_id,ticket_id,id) on delete restrict,
  foreign key(workspace_id,ticket_id,ready_manifest_id) references alpha_private.ticket_ready_manifests(workspace_id,ticket_id,id) on delete restrict
);
create table alpha_private.ticket_result_objects (
  workspace_id text not null, ticket_id text not null, asset_id text not null, file_id text not null,
  object_key text not null, object_version text not null check(object_version ~ '^[a-f0-9]{64}$'),
  content bytea not null check(octet_length(content) between 1 and 65536),
  primary key(workspace_id,ticket_id,asset_id,file_id), unique(object_key,object_version),
  foreign key(workspace_id,ticket_id) references alpha_private.tickets(workspace_id,id) on delete restrict
);

-- Revisions, review evidence, registered previews and bytes are append-only.
create function alpha_private.keep_ticket_evidence() returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Ticket evidence is immutable; create a new revision.' using errcode='23514';
end;
$$;
revoke all on function alpha_private.keep_ticket_evidence() from public,anon,authenticated,service_role;

do $$ declare name text; begin
  foreach name in array array['ticket_scope_operations','ticket_work_bindings','ticket_issue_revisions','ticket_issue_reviews',
    'ticket_execution_claims','ticket_execution_operations','ticket_execution_dispatches','ticket_ready_manifests',
    'ticket_delivery_registrations','ticket_result_objects'] loop
    execute format('alter table alpha_private.%I enable row level security',name);
    execute format('revoke all privileges on table alpha_private.%I from public,anon,authenticated,service_role',name);
  end loop;
  foreach name in array array['ticket_issue_revisions','ticket_issue_reviews','ticket_ready_manifests',
    'ticket_delivery_registrations','ticket_result_objects'] loop
    execute format('create trigger keep_ticket_evidence before update or delete on alpha_private.%I for each row execute function alpha_private.keep_ticket_evidence()',name);
  end loop;
end $$;
