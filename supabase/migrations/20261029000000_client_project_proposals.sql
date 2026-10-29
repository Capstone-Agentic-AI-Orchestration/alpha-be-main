-- Authenticated proposals reuse private PM intake; existing RLS remains in force.
alter table alpha_private.ticket_central_intakes
 add column kind text not null default 'public_inquiry' check(kind in ('public_inquiry','project_proposal')),
 add column client_user_id text,
 add constraint ticket_central_intake_proposal_owner check
 ((kind='public_inquiry' and client_user_id is null) or
 (kind='project_proposal' and client_user_id is not null and length(client_user_id)>0));
create index ticket_central_intakes_client_proposals_idx
 on alpha_private.ticket_central_intakes(organization_key,client_user_id,submitted_at desc)
 where kind='project_proposal' and status in ('pending','declined');

-- Proposal receipt has an authenticated actor; anonymous receipt keeps its original rule.
alter table alpha_private.ticket_central_intake_events
 drop constraint ticket_central_intake_events_event_type_check,
 drop constraint ticket_central_intake_events_actor_kind_check,
 drop constraint ticket_central_intake_events_actor_check,
 add constraint ticket_central_intake_events_event_type_check
 check(event_type in ('inquiry_received','project_proposal_received','inquiry_accepted','inquiry_declined')),
 add constraint ticket_central_intake_events_actor_kind_check check(actor_kind in ('anonymous','pm','client')),
 add constraint ticket_central_intake_events_actor_check check(
 (event_type='inquiry_received' and actor_kind='anonymous' and actor_id is null and workspace_id is null and ticket_id is null)
 or (event_type='project_proposal_received' and actor_kind='client' and actor_id is not null and workspace_id is null and ticket_id is null)
 or (event_type='inquiry_accepted' and actor_kind='pm' and actor_id is not null and workspace_id is not null and ticket_id is not null)
 or (event_type='inquiry_declined' and actor_kind='pm' and actor_id is not null and workspace_id is not null and ticket_id is null));
