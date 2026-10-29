-- Server-only, project/recipient scoped UAT. Preview configuration never publishes a review.
create table alpha_private.client_uat_rounds (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  id text not null,
  number integer not null check(number > 0),
  title text not null check(length(title) between 1 and 300),
  status text not null default 'draft' check(status in ('draft','published','submitted','withdrawn','superseded')),
  version integer not null default 0 check(version >= 0),
  build jsonb not null,
  build_key text not null,
  reviewed_by text,
  reviewed_at timestamptz,
  reviewed_build_key text,
  outcome text check(outcome in ('passed','changes_requested','blocked')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  submitted_at timestamptz,
  primary key(workspace_id,project_id,client_user_id,id),
  unique(workspace_id,project_id,client_user_id,number),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id) on delete cascade,
  check(build->'frontend'->>'branch' = 'uat'),
  check(status not in ('published','submitted') or
    (reviewed_by is not null and reviewed_at is not null and reviewed_build_key=build_key and published_at is not null)),
  check((status='submitted') = (submitted_at is not null and outcome is not null))
);
create unique index client_uat_one_published on alpha_private.client_uat_rounds(workspace_id,project_id,client_user_id) where status='published';

create table alpha_private.client_uat_items (
  workspace_id text not null, project_id text not null, client_user_id text not null, round_id text not null,
  id text not null, position integer not null, title text not null, steps text not null, expected_result text not null, required boolean not null,
  primary key(workspace_id,project_id,client_user_id,round_id,id),
  unique(workspace_id,project_id,client_user_id,round_id,position),
  foreign key(workspace_id,project_id,client_user_id,round_id) references alpha_private.client_uat_rounds(workspace_id,project_id,client_user_id,id) on delete cascade
);
create table alpha_private.client_uat_results (
  workspace_id text not null, project_id text not null, client_user_id text not null, round_id text not null, item_id text not null,
  status text not null check(status in ('not_tested','passed','failed','blocked')),
  notes text not null default '' check(length(notes)<=4000), reproduction text not null default '' check(length(reproduction)<=4000),
  device text not null default '' check(length(device)<=100), updated_at timestamptz not null default now(),
  primary key(workspace_id,project_id,client_user_id,round_id,item_id),
  foreign key(workspace_id,project_id,client_user_id,round_id,item_id) references alpha_private.client_uat_items(workspace_id,project_id,client_user_id,round_id,id) on delete cascade,
  check(status not in ('failed','blocked') or length(btrim(notes))>0),
  check(status<>'failed' or length(btrim(reproduction))>0)
);
create table alpha_private.client_uat_events (
  workspace_id text not null, project_id text not null, client_user_id text not null, round_id text not null,
  id text not null, actor_kind text not null check(actor_kind in ('pm','client')), actor_id text not null,
  action text not null, operation_id text not null, fingerprint text not null, receipt jsonb not null,
  created_at timestamptz not null default now(),
  primary key(workspace_id,project_id,client_user_id,id),
  unique(workspace_id,project_id,actor_kind,actor_id,operation_id),
  foreign key(workspace_id,project_id,client_user_id,round_id) references alpha_private.client_uat_rounds(workspace_id,project_id,client_user_id,id) on delete cascade,
  check(actor_kind<>'client' or actor_id=client_user_id)
);
create index client_uat_history on alpha_private.client_uat_events(workspace_id,project_id,client_user_id,round_id,created_at);

alter table alpha_private.client_uat_rounds enable row level security;
alter table alpha_private.client_uat_items enable row level security;
alter table alpha_private.client_uat_results enable row level security;
alter table alpha_private.client_uat_events enable row level security;
revoke all on alpha_private.client_uat_rounds,alpha_private.client_uat_items,alpha_private.client_uat_results,alpha_private.client_uat_events from public,anon,authenticated;
grant select,insert,update on alpha_private.client_uat_rounds,alpha_private.client_uat_results to service_role;
grant select,insert on alpha_private.client_uat_items,alpha_private.client_uat_events to service_role;
grant delete on alpha_private.client_uat_items to service_role;
