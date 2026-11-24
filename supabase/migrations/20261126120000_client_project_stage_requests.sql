-- Project stages without money (follows 20261125120000_client_project_stages.sql).
--
-- Alpha takes no payments. A round past the included revisions is "extra": the
-- client is reminded it costs additional, confirms, and the round goes to the
-- PM as usual. Out-of-scope notes and requests after closure become change
-- requests the PM answers with "will do" or "won't do", with no price.
--
-- The quote table and the quote-linked rounds are replaced. They held no rows
-- when this was written; the guard below stops the migration if they do.

do $$
begin
  if exists (select 1 from alpha_private.client_project_quotes)
    or exists (select 1 from alpha_private.client_project_revision_rounds) then
    raise exception 'client_project_quotes or client_project_revision_rounds has rows; migrate them by hand';
  end if;
end $$;

drop table alpha_private.client_project_revision_items;
drop table alpha_private.client_project_revision_rounds;
drop table alpha_private.client_project_quotes;

create table alpha_private.client_project_revision_rounds (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  id text not null,
  number integer not null check (number > 0),
  status text not null check (status in ('open','submitted','classified')),
  build_note text not null default '' check (length(build_note) <= 4000),
  preview_url text check (preview_url is null or length(preview_url) <= 2048),
  counts boolean,
  -- Sent after the included rounds were used; the client confirmed it costs additional.
  extra boolean not null default false,
  opened_by text not null,
  opened_at timestamptz not null default now(),
  submitted_at timestamptz,
  classified_at timestamptz,
  primary key (workspace_id, project_id, client_user_id, id),
  unique (workspace_id, project_id, client_user_id, number),
  foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete cascade,
  check ((status = 'open') = (submitted_at is null)),
  check ((status = 'classified') = (classified_at is not null and counts is not null)),
  check (not extra or submitted_at is not null)
);
create unique index client_project_round_one_active on alpha_private.client_project_revision_rounds
  (workspace_id, project_id, client_user_id) where status in ('open','submitted');

create table alpha_private.client_project_revision_items (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  round_id text not null,
  id text not null,
  position integer not null check (position >= 0),
  body text not null check (length(body) between 1 and 4000 and body = btrim(body)),
  classification text check (classification in ('revision','fix','out_of_scope')),
  pm_note text not null default '' check (length(pm_note) <= 2000),
  primary key (workspace_id, project_id, client_user_id, round_id, id),
  unique (workspace_id, project_id, client_user_id, round_id, position),
  foreign key (workspace_id, project_id, client_user_id, round_id)
    references alpha_private.client_project_revision_rounds(workspace_id, project_id, client_user_id, id) on delete cascade
);

create table alpha_private.client_project_requests (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  id text not null,
  -- The round whose out-of-scope note this came from, when the PM raised it.
  round_id text,
  title text not null check (length(title) between 1 and 300),
  description text not null default '' check (length(description) <= 8000),
  status text not null check (status in ('open','will_do','wont_do')),
  requested_by_kind text not null check (requested_by_kind in ('pm','client')),
  requested_at timestamptz not null default now(),
  reply text not null default '' check (length(reply) <= 4000),
  answered_by text,
  answered_at timestamptz,
  primary key (workspace_id, project_id, client_user_id, id),
  foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete cascade,
  check ((status = 'open') = (answered_at is null)),
  check (status = 'open' or answered_by is not null)
);

alter table alpha_private.client_project_stage_events drop constraint client_project_stage_events_action_check;
alter table alpha_private.client_project_stage_events add constraint client_project_stage_events_action_check check (action in (
  'stage_set','poc_published','poc_changes_requested','poc_approved',
  'contract_issued','contract_voided','contract_signed','contract_countersigned',
  'build_shared','round_submitted','round_classified',
  'request_made','request_answered',
  'final_delivered','final_accepted'));

alter table alpha_private.client_project_revision_rounds enable row level security;
alter table alpha_private.client_project_revision_items enable row level security;
alter table alpha_private.client_project_requests enable row level security;
revoke all on alpha_private.client_project_revision_rounds, alpha_private.client_project_revision_items,
  alpha_private.client_project_requests from public, anon, authenticated;
grant select, insert, update, delete on alpha_private.client_project_revision_rounds, alpha_private.client_project_revision_items,
  alpha_private.client_project_requests to service_role;
