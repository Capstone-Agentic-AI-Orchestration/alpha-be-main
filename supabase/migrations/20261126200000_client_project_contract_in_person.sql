-- The development contract is drafted and signed in person, outside Alpha.
-- The PM starts development directly from the POC stage ('development_started'),
-- recording the revision rounds the signed contract includes.
--
-- client_project_contracts stays: contracts countersigned in Alpha before this
-- change are still shown read-only. Projects left in the 'contract' stage start
-- development the same way as POC projects.

alter table alpha_private.client_project_stage_events drop constraint client_project_stage_events_action_check;
alter table alpha_private.client_project_stage_events add constraint client_project_stage_events_action_check check (action in (
  'stage_set','poc_completed','development_started','poc_published','poc_changes_requested','poc_approved',
  'contract_issued','contract_voided','contract_signed','contract_countersigned',
  'build_shared','round_submitted','round_classified',
  'request_made','request_answered',
  'final_delivered','final_accepted'));
