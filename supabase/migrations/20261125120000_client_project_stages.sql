-- Project stages in the PM–client conversation.
--
-- Alpha's contract process, per client and project (the same key as the
-- project conversation: workspace, project, client account):
--   POC          the PM publishes versioned proofs of concept (written scope);
--                the client may ask for changes any number of times.
--   Contract     generated from the approved POC; the client signs, the PM
--                countersigns.
--   Development  the PM shares builds; the client sends feedback rounds. A set
--                number of rounds is included; later rounds are quoted.
--   Completed    final delivery accepted; new work is a quoted change request.
--
-- Approval and signing are typed-name sign-offs: who, when, and a hash of the
-- exact content that was approved or signed.
--
-- Threads that already exist start as 'unset' and keep working as before until
-- the PM picks their starting stage. New threads start in 'poc' on first use.

create table alpha_private.client_project_stages (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  stage text not null check (stage in ('unset','poc','contract','development','completed')),
  revision_limit integer not null default 3 check (revision_limit between 0 and 20),
  revisions_offset integer not null default 0 check (revisions_offset between 0 and 20),
  version integer not null default 0 check (version >= 0),
  final_delivered_at timestamptz,
  final_delivered_note text check (final_delivered_note is null or length(final_delivered_note) <= 4000),
  final_accepted_at timestamptz,
  final_accepted_name text check (final_accepted_name is null or length(final_accepted_name) between 2 and 200),
  stage_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, project_id, client_user_id),
  foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete cascade,
  check ((final_accepted_at is null) = (final_accepted_name is null)),
  check (final_accepted_at is null or final_delivered_at is not null),
  check (stage <> 'completed' or final_accepted_at is not null or final_delivered_at is null)
);

create table alpha_private.client_project_poc_versions (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  id text not null,
  number integer not null check (number > 0),
  status text not null check (status in ('draft','published','changes_requested','superseded','approved')),
  title text not null check (length(title) between 1 and 300),
  summary text not null check (length(summary) between 1 and 8000),
  features jsonb not null check (jsonb_typeof(features) = 'array'),
  screens jsonb not null default '[]'::jsonb check (jsonb_typeof(screens) = 'array'),
  out_of_scope text not null default '' check (length(out_of_scope) <= 4000),
  note text not null default '' check (length(note) <= 4000),
  content_hash text check (content_hash is null or content_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  approved_at timestamptz,
  approved_name text check (approved_name is null or length(approved_name) between 2 and 200),
  approved_hash text,
  primary key (workspace_id, project_id, client_user_id, id),
  unique (workspace_id, project_id, client_user_id, number),
  foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete cascade,
  check ((status = 'draft') = (published_at is null)),
  check (status = 'draft' or content_hash is not null),
  check ((status = 'approved') = (approved_at is not null and approved_name is not null and approved_hash is not null)),
  check (approved_hash is null or approved_hash = content_hash)
);
create unique index client_project_poc_one_draft on alpha_private.client_project_poc_versions
  (workspace_id, project_id, client_user_id) where status = 'draft';
create unique index client_project_poc_one_approved on alpha_private.client_project_poc_versions
  (workspace_id, project_id, client_user_id) where status = 'approved';

create table alpha_private.client_project_contracts (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  id text not null,
  poc_version_id text not null,
  status text not null check (status in ('draft','issued','client_signed','countersigned','void')),
  terms jsonb not null check (jsonb_typeof(terms) = 'object'),
  content_hash text check (content_hash is null or content_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  issued_by text,
  issued_at timestamptz,
  client_signed_name text check (client_signed_name is null or length(client_signed_name) between 2 and 200),
  client_signed_at timestamptz,
  client_signed_hash text,
  pm_signed_by text,
  pm_signed_name text check (pm_signed_name is null or length(pm_signed_name) between 2 and 200),
  pm_signed_at timestamptz,
  voided_at timestamptz,
  primary key (workspace_id, project_id, client_user_id, id),
  foreign key (workspace_id, project_id, client_user_id, poc_version_id)
    references alpha_private.client_project_poc_versions(workspace_id, project_id, client_user_id, id) on delete cascade,
  check (status = 'draft' or status = 'void' or (issued_at is not null and issued_by is not null and content_hash is not null)),
  check ((client_signed_at is not null) = (client_signed_name is not null and client_signed_hash is not null)),
  check (client_signed_hash is null or client_signed_hash = content_hash),
  check (status not in ('client_signed','countersigned') or client_signed_at is not null),
  check ((status = 'countersigned') = (pm_signed_at is not null and pm_signed_name is not null and pm_signed_by is not null)),
  check ((status = 'void') = (voided_at is not null)),
  check (status <> 'void' or client_signed_at is null)
);
create unique index client_project_contract_one_live on alpha_private.client_project_contracts
  (workspace_id, project_id, client_user_id) where status <> 'void';

create table alpha_private.client_project_quotes (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  id text not null,
  kind text not null check (kind in ('paid_revision','change_request')),
  round_id text,
  title text not null check (length(title) between 1 and 300),
  description text not null default '' check (length(description) <= 8000),
  amount numeric(12,2) check (amount is null or amount >= 0),
  currency text not null default 'PHP' check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('requested','sent','accepted','declined','withdrawn')),
  requested_by_kind text not null check (requested_by_kind in ('pm','client')),
  requested_at timestamptz not null default now(),
  sent_by text,
  sent_at timestamptz,
  decided_name text check (decided_name is null or length(decided_name) between 2 and 200),
  decided_at timestamptz,
  primary key (workspace_id, project_id, client_user_id, id),
  foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete cascade,
  check (status = 'requested' or status = 'withdrawn' or (amount is not null and sent_at is not null and sent_by is not null)),
  check ((status in ('accepted','declined')) = (decided_at is not null)),
  check (status <> 'accepted' or decided_name is not null),
  check (kind <> 'paid_revision' or round_id is not null)
);

create table alpha_private.client_project_revision_rounds (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  id text not null,
  number integer not null check (number > 0),
  status text not null check (status in ('open','awaiting_quote','submitted','classified')),
  build_note text not null default '' check (length(build_note) <= 4000),
  preview_url text check (preview_url is null or length(preview_url) <= 2048),
  counts boolean,
  paid boolean not null default false,
  quote_id text,
  opened_by text not null,
  opened_at timestamptz not null default now(),
  submitted_at timestamptz,
  classified_at timestamptz,
  primary key (workspace_id, project_id, client_user_id, id),
  unique (workspace_id, project_id, client_user_id, number),
  foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete cascade,
  foreign key (workspace_id, project_id, client_user_id, quote_id)
    references alpha_private.client_project_quotes(workspace_id, project_id, client_user_id, id),
  check ((status = 'open') = (submitted_at is null)),
  check ((status = 'classified') = (classified_at is not null and counts is not null)),
  check (not paid or quote_id is not null)
);
create unique index client_project_round_one_active on alpha_private.client_project_revision_rounds
  (workspace_id, project_id, client_user_id) where status in ('open','awaiting_quote','submitted');

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

create table alpha_private.client_project_stage_events (
  workspace_id text not null,
  project_id text not null,
  client_user_id text not null,
  id text not null,
  actor_kind text not null check (actor_kind in ('pm','client')),
  actor_id text not null check (length(actor_id) between 1 and 200),
  action text not null check (action in (
    'stage_set','poc_published','poc_changes_requested','poc_approved',
    'contract_issued','contract_voided','contract_signed','contract_countersigned',
    'build_shared','round_submitted','round_classified',
    'quote_requested','quote_sent','quote_accepted','quote_declined',
    'final_delivered','final_accepted')),
  ref_id text,
  body text check (body is null or length(body) between 1 and 4000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  operation_id text not null check (length(operation_id) between 1 and 200 and operation_id = btrim(operation_id)),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, project_id, client_user_id, id),
  unique (workspace_id, project_id, client_user_id, actor_kind, actor_id, operation_id),
  foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete cascade,
  check (actor_kind <> 'client' or actor_id = client_user_id)
);
create index client_project_stage_events_history on alpha_private.client_project_stage_events
  (workspace_id, project_id, client_user_id, created_at);

-- Existing conversations keep working as they do today until the PM picks a stage.
insert into alpha_private.client_project_stages (workspace_id, project_id, client_user_id, stage)
select distinct t.workspace_id, t.project_id, t.client_user_id, 'unset'
from alpha_private.tickets t
join alpha_private.ticket_client_grants cg on cg.workspace_id = t.workspace_id and cg.ticket_id = t.id
  and cg.client_user_id = t.client_user_id and cg.active and cg.revoked_at is null
join public.projects p on p.workspace_id = t.workspace_id and p.id = t.project_id
where t.project_id is not null and t.client_user_id is not null and t.project_client_visible
on conflict do nothing;

alter table alpha_private.client_project_stages enable row level security;
alter table alpha_private.client_project_poc_versions enable row level security;
alter table alpha_private.client_project_contracts enable row level security;
alter table alpha_private.client_project_quotes enable row level security;
alter table alpha_private.client_project_revision_rounds enable row level security;
alter table alpha_private.client_project_revision_items enable row level security;
alter table alpha_private.client_project_stage_events enable row level security;
revoke all on alpha_private.client_project_stages, alpha_private.client_project_poc_versions,
  alpha_private.client_project_contracts, alpha_private.client_project_quotes,
  alpha_private.client_project_revision_rounds, alpha_private.client_project_revision_items,
  alpha_private.client_project_stage_events from public, anon, authenticated;
grant select, insert, update, delete on alpha_private.client_project_stages, alpha_private.client_project_poc_versions,
  alpha_private.client_project_contracts, alpha_private.client_project_quotes,
  alpha_private.client_project_revision_rounds, alpha_private.client_project_revision_items to service_role;
grant select, insert on alpha_private.client_project_stage_events to service_role;
