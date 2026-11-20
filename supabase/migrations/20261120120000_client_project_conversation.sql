-- One conversation per client and project.
--
-- The conversation itself is read from the stores that already exist: the
-- project thread (client_project_messages), each request's messages
-- (ticket_messages) and an accepted proposal's clarifications. Two small
-- tables complete it:
--
-- request_task_links: a board task made for, or linked to, a client's request
--   from the conversation or the New task dialog. Formal plan approval keeps
--   using ticket_work_bindings; this link needs no approved plan. One request
--   per task.
-- client_request_checks: the request checklist. The client (or the PM) ticks a
--   request done or reopens it without changing the ticket's own workflow,
--   whose closed states stay read-only.

create table alpha_private.request_task_links (
  workspace_id text not null,
  issue_id text not null references public.issues(id) on delete cascade,
  ticket_id text not null,
  project_id text not null,
  source text not null check (source in ('conversation','task_dialog')),
  linked_by text not null check (length(linked_by) between 1 and 200),
  linked_at timestamptz not null default now(),
  primary key (workspace_id, issue_id),
  foreign key (workspace_id, ticket_id) references alpha_private.tickets(workspace_id, id) on delete cascade,
  foreign key (workspace_id, project_id) references public.projects(workspace_id, id) on delete cascade
);
create index request_task_links_ticket_idx on alpha_private.request_task_links (workspace_id, ticket_id);

create table alpha_private.client_request_checks (
  workspace_id text not null,
  ticket_id text not null,
  done boolean not null,
  changed_by_kind text not null check (changed_by_kind in ('pm','client')),
  changed_by text not null check (length(changed_by) between 1 and 200),
  changed_at timestamptz not null default now(),
  primary key (workspace_id, ticket_id),
  foreign key (workspace_id, ticket_id) references alpha_private.tickets(workspace_id, id) on delete cascade
);

alter table alpha_private.request_task_links enable row level security;
alter table alpha_private.client_request_checks enable row level security;
revoke all on alpha_private.request_task_links, alpha_private.client_request_checks from public, anon, authenticated;
grant select, insert, update, delete on alpha_private.request_task_links, alpha_private.client_request_checks to service_role;
