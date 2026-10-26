-- Server-only project previews and per-client project feedback. No client gets
-- project access from these rows: authorization is derived from visible ticket grants.
create unique index projects_workspace_identity_idx on public.projects(workspace_id,id);

create table alpha_private.client_project_previews (
  workspace_id text not null,
  project_id text not null,
  repository text,
  branch text,
  url text,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key(workspace_id,project_id),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id) on delete cascade,
  check ((repository is null and branch is null and url is null) or
    (repository is not null and branch is not null and url is not null
      and repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' and branch in ('main','uat')
      and length(url)<=2048 and url ~ '^https://[A-Za-z0-9.-]+[.]vercel[.]app([/?#][^[:space:]]*)?$'))
);

create table alpha_private.client_project_messages (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  id text not null,
  author_kind text not null check(author_kind in ('pm','client')),
  author_id text not null,
  operation_id text not null check(length(operation_id) between 1 and 200 and operation_id=btrim(operation_id)),
  body text not null check(length(body) between 1 and 4000 and body=btrim(body)),
  created_at timestamptz not null default now(),
  primary key(workspace_id,project_id,client_user_id,id),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id) on delete cascade,
  check(author_kind<>'client' or author_id=client_user_id),
  unique(workspace_id,project_id,client_user_id,author_kind,author_id,operation_id)
);
create index client_project_messages_page_idx on alpha_private.client_project_messages
  (workspace_id,project_id,client_user_id,created_at,id collate "C");

alter table alpha_private.client_project_previews enable row level security;
alter table alpha_private.client_project_messages enable row level security;
revoke all on alpha_private.client_project_previews,alpha_private.client_project_messages from public,anon,authenticated;
grant select,insert,update on alpha_private.client_project_previews to service_role;
grant select,insert on alpha_private.client_project_messages to service_role;
