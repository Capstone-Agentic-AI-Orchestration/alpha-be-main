-- Keep a usable receipt for anonymous central inquiries and retain explicit
-- PM decline decisions without turning them into tickets or client accounts.
alter table alpha_private.ticket_central_intakes
  add column public_reference text,
  add column declined_by text,
  add column declined_workspace_id text references public.workspaces(id) on delete restrict,
  add column decline_operation_id text,
  add column declined_at timestamptz,
  add column decline_reason text;

update alpha_private.ticket_central_intakes
   set public_reference = 'INQ-' || upper(md5(organization_key || ':' || id));

alter table alpha_private.ticket_central_intakes
  alter column public_reference set not null,
  drop constraint ticket_central_intakes_status_check,
  drop constraint ticket_central_intakes_check,
  add constraint ticket_central_intakes_public_reference_key unique (organization_key, public_reference),
  add constraint ticket_central_intakes_decline_operation_key unique (organization_key, decline_operation_id),
  add constraint ticket_central_intakes_state_check check (
    (status = 'pending'
      and accepted_by is null and accepted_workspace_id is null and accepted_ticket_id is null
      and acceptance_operation_id is null and accepted_at is null
      and declined_by is null and declined_workspace_id is null and decline_operation_id is null
      and declined_at is null and decline_reason is null)
    or (status = 'accepted'
      and accepted_by is not null and accepted_workspace_id is not null and accepted_ticket_id is not null
      and acceptance_operation_id is not null and accepted_at is not null
      and declined_by is null and declined_workspace_id is null and decline_operation_id is null
      and declined_at is null and decline_reason is null)
    or (status = 'declined'
      and accepted_by is null and accepted_workspace_id is null and accepted_ticket_id is null
      and acceptance_operation_id is null and accepted_at is null
      and declined_by is not null and declined_workspace_id is not null and decline_operation_id is not null
      and declined_at is not null)
  ),
  add constraint ticket_central_intakes_decline_reason_check check (
    decline_reason is null or (char_length(decline_reason) between 1 and 1000 and btrim(decline_reason) <> '')
  );

drop index alpha_private.ticket_central_intakes_pending_idx;
create index ticket_central_intakes_pending_idx
  on alpha_private.ticket_central_intakes(organization_key, submitted_at desc, id collate "C" desc)
  where status = 'pending';

alter table alpha_private.ticket_central_intake_events
  drop constraint ticket_central_intake_events_event_type_check,
  drop constraint ticket_central_intake_events_check,
  add constraint ticket_central_intake_events_event_type_check
    check (event_type in ('inquiry_received', 'inquiry_accepted', 'inquiry_declined')),
  add constraint ticket_central_intake_events_actor_check check (
    (event_type = 'inquiry_received' and actor_kind = 'anonymous' and actor_id is null
      and workspace_id is null and ticket_id is null)
    or (event_type = 'inquiry_accepted' and actor_kind = 'pm' and actor_id is not null
      and workspace_id is not null and ticket_id is not null)
    or (event_type = 'inquiry_declined' and actor_kind = 'pm' and actor_id is not null
      and workspace_id is not null and ticket_id is null)
  );

-- Durable generic receipt emails. The existing worker/provider handles the
-- sender's test-recipient restriction; a rejected recipient never blocks the
-- saved inquiry or gets redirected to another address.
create table alpha_private.ticket_central_intake_acknowledgments (
  organization_key text not null,
  intake_id text not null,
  idempotency_key uuid not null,
  status text not null default 'pending' check (status in ('pending', 'retry', 'leased', 'delivered', 'dead')),
  attempt integer not null default 0 check (attempt >= 0),
  available_at timestamptz not null default now(),
  lease_token_hash char(64) check (lease_token_hash is null or lease_token_hash ~ '^[a-f0-9]{64}$'),
  lease_until timestamptz,
  dispatch_identity char(64) check (dispatch_identity is null or dispatch_identity ~ '^[a-f0-9]{64}$'),
  first_attempt_at timestamptz,
  failure_code text check (failure_code is null or failure_code in ('provider_failure', 'secret_integrity_failure', 'attempt_limit_reached')),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (organization_key, intake_id),
  foreign key (organization_key, intake_id)
    references alpha_private.ticket_central_intakes(organization_key, id) on delete restrict,
  check ((status = 'leased' and lease_token_hash is not null and lease_until is not null)
      or (status <> 'leased' and lease_token_hash is null and lease_until is null)),
  check ((status = 'delivered' and delivered_at is not null) or status <> 'delivered')
);
create index ticket_central_intake_acknowledgments_due_idx
  on alpha_private.ticket_central_intake_acknowledgments(available_at, created_at, intake_id)
  where status in ('pending', 'retry', 'leased');

-- PM-specific read cursors make a client reply stay visibly unread until that
-- PM actually loads the corresponding conversation page.
create table alpha_private.ticket_pm_read_cursors (
  workspace_id text not null,
  ticket_id text not null,
  pm_user_id text not null,
  last_read_at timestamptz not null,
  primary key (workspace_id, ticket_id, pm_user_id),
  foreign key (workspace_id, ticket_id)
    references alpha_private.tickets(workspace_id, id) on delete cascade
);

-- One PM-selected hosted frontend preview per project. Only authenticated
-- ticket reads may project this URL, and only for a ticket linked to the
-- project whose name has also been made client-visible.
create table alpha_private.ticket_project_client_previews (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  project_id text not null references public.projects(id) on delete cascade,
  ticket_id text not null,
  repository text not null check (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  branch text not null check (branch in ('main', 'uat')),
  url text not null check (url ~ '^https://[A-Za-z0-9.-]+[.]vercel[.]app([/?#][^[:space:]]*)?$'),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, ticket_id),
  foreign key (workspace_id, ticket_id) references alpha_private.tickets(workspace_id, id) on delete cascade
);
create index ticket_project_client_previews_project_idx
  on alpha_private.ticket_project_client_previews(workspace_id, project_id);

-- Legacy rows are not validated here. New ticket links must reference a real
-- project, and deleting a referenced project is always rejected by Postgres.
alter table alpha_private.tickets
  add constraint tickets_project_link_fk foreign key (project_id)
    references public.projects(id) on delete restrict not valid;
create index tickets_project_link_fk_idx on alpha_private.tickets(project_id) where project_id is not null;

alter table alpha_private.ticket_central_intake_acknowledgments enable row level security;
alter table alpha_private.ticket_pm_read_cursors enable row level security;
alter table alpha_private.ticket_project_client_previews enable row level security;
revoke all on alpha_private.ticket_central_intake_acknowledgments from public, anon, authenticated;
revoke all on alpha_private.ticket_pm_read_cursors from public, anon, authenticated;
revoke all on alpha_private.ticket_project_client_previews from public, anon, authenticated;
