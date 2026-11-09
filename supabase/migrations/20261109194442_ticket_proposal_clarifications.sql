-- Keep a proposal in the PM intake queue while the client answers a clarification.
alter table alpha_private.ticket_central_intakes
  drop constraint ticket_central_intakes_state_check,
  add constraint ticket_central_intakes_state_check check (
    (status in ('pending','awaiting_client')
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
  add constraint ticket_central_intakes_clarification_kind_check
    check (status <> 'awaiting_client' or kind = 'project_proposal');

drop index alpha_private.ticket_central_intakes_pending_idx;
create index ticket_central_intakes_pending_idx
  on alpha_private.ticket_central_intakes(organization_key, submitted_at desc, id collate "C" desc)
  where status in ('pending','awaiting_client');
drop index alpha_private.ticket_central_intakes_client_proposals_idx;
create index ticket_central_intakes_client_proposals_idx
  on alpha_private.ticket_central_intakes(organization_key,client_user_id,submitted_at desc)
  where kind='project_proposal' and status in ('pending','awaiting_client','declined');

alter table alpha_private.ticket_central_intake_events
  drop constraint ticket_central_intake_events_event_type_check,
  drop constraint ticket_central_intake_events_actor_check,
  add constraint ticket_central_intake_events_event_type_check check (
    event_type in ('inquiry_received','project_proposal_received','inquiry_accepted','inquiry_declined',
      'proposal_clarification_requested','proposal_clarification_replied')),
  add constraint ticket_central_intake_events_actor_check check (
    (event_type = 'inquiry_received' and actor_kind = 'anonymous' and actor_id is null
      and workspace_id is null and ticket_id is null)
    or (event_type = 'project_proposal_received' and actor_kind = 'client' and actor_id is not null
      and workspace_id is null and ticket_id is null)
    or (event_type = 'inquiry_accepted' and actor_kind = 'pm' and actor_id is not null
      and workspace_id is not null and ticket_id is not null)
    or (event_type = 'inquiry_declined' and actor_kind = 'pm' and actor_id is not null
      and workspace_id is not null and ticket_id is null)
    or (event_type = 'proposal_clarification_requested' and actor_kind = 'pm' and actor_id is not null
      and workspace_id is not null and ticket_id is null)
    or (event_type = 'proposal_clarification_replied' and actor_kind = 'client' and actor_id is not null
      and workspace_id is null and ticket_id is null)
  );
