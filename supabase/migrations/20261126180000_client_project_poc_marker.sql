-- The POC stage becomes a marker. There is no written proof of concept any more:
-- the features live as tasks on the project's board. The PM moves the project
-- from POC to the contract ('poc_completed'), and the contract's scope is
-- written in the contract itself.
--
-- client_project_poc_versions stays: contracts issued before this change still
-- reference the POC version they were drafted from. New contracts reference none.

alter table alpha_private.client_project_contracts alter column poc_version_id drop not null;

alter table alpha_private.client_project_stage_events drop constraint client_project_stage_events_action_check;
alter table alpha_private.client_project_stage_events add constraint client_project_stage_events_action_check check (action in (
  'stage_set','poc_completed','poc_published','poc_changes_requested','poc_approved',
  'contract_issued','contract_voided','contract_signed','contract_countersigned',
  'build_shared','round_submitted','round_classified',
  'request_made','request_answered',
  'final_delivered','final_accepted'));
