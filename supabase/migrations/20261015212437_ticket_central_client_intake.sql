-- Anonymous inquiries begin in one PM intake pool, without selecting a workspace.
-- Only a PM acceptance creates the existing workspace-owned ticket.
create table alpha_private.ticket_central_intakes (
  organization_key text not null,
  id text not null,
  operation_id text not null,
  fingerprint char(64) not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_key_id text not null,
  full_name text not null,
  email text not null,
  company text,
  title text not null,
  description text not null,
  requested_deadline text,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  submitted_at timestamptz not null default now(),
  accepted_by text,
  accepted_workspace_id text references public.workspaces(id) on delete restrict,
  accepted_ticket_id text,
  acceptance_operation_id text,
  accepted_at timestamptz,
  primary key (organization_key, id),
  unique (organization_key, operation_id),
  unique (organization_key, acceptance_operation_id),
  foreign key (accepted_workspace_id, accepted_ticket_id)
    references alpha_private.tickets(workspace_id, id) on delete restrict,
  check ((status = 'pending' and accepted_by is null and accepted_workspace_id is null
      and accepted_ticket_id is null and acceptance_operation_id is null and accepted_at is null)
    or (status = 'accepted' and accepted_by is not null and accepted_workspace_id is not null
      and accepted_ticket_id is not null and acceptance_operation_id is not null and accepted_at is not null)),
  check (requested_deadline is null or requested_deadline ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

create index ticket_central_intakes_pending_idx
  on alpha_private.ticket_central_intakes(organization_key, submitted_at desc, id collate "C" desc)
  where status = 'pending';

create table alpha_private.ticket_central_intake_events (
  id text primary key,
  organization_key text not null,
  intake_id text not null,
  event_type text not null check (event_type in ('inquiry_received', 'inquiry_accepted')),
  actor_kind text not null check (actor_kind in ('anonymous', 'pm')),
  actor_id text,
  workspace_id text references public.workspaces(id) on delete restrict,
  ticket_id text,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  foreign key (organization_key, intake_id)
    references alpha_private.ticket_central_intakes(organization_key, id) on delete restrict,
  foreign key (workspace_id, ticket_id)
    references alpha_private.tickets(workspace_id, id) on delete restrict,
  check ((event_type = 'inquiry_received' and actor_kind = 'anonymous' and actor_id is null
      and workspace_id is null and ticket_id is null)
    or (event_type = 'inquiry_accepted' and actor_kind = 'pm' and actor_id is not null
      and workspace_id is not null and ticket_id is not null))
);

create index ticket_central_intake_events_timeline_idx
  on alpha_private.ticket_central_intake_events(organization_key, intake_id, occurred_at, id);

create table alpha_private.ticket_central_intake_rate_buckets (
  organization_key text not null,
  bucket_kind text not null check (bucket_kind in ('source', 'organization')),
  subject_hash char(64) not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  window_seconds integer not null check (window_seconds between 1 and 86400),
  attempts integer not null check (attempts >= 0),
  updated_at timestamptz not null,
  primary key (organization_key, bucket_kind, subject_hash, window_started_at)
);

create index ticket_central_intake_rate_cleanup_idx
  on alpha_private.ticket_central_intake_rate_buckets(window_started_at, window_seconds);

alter table alpha_private.ticket_central_intakes enable row level security;
alter table alpha_private.ticket_central_intake_events enable row level security;
alter table alpha_private.ticket_central_intake_rate_buckets enable row level security;
revoke all on alpha_private.ticket_central_intakes from public, anon, authenticated;
revoke all on alpha_private.ticket_central_intake_events from public, anon, authenticated;
revoke all on alpha_private.ticket_central_intake_rate_buckets from public, anon, authenticated;
