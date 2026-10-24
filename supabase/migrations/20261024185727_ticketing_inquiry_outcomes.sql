-- New decline outcomes only; historical declines are not automatically emailed.
create table alpha_private.ticket_central_intake_outcomes
  (like alpha_private.ticket_central_intake_acknowledgments including all);
alter table alpha_private.ticket_central_intake_outcomes
  add foreign key (organization_key, intake_id)
    references alpha_private.ticket_central_intakes(organization_key,id) on delete restrict;
alter table alpha_private.ticket_central_intake_outcomes enable row level security;
revoke all on alpha_private.ticket_central_intake_outcomes from public,anon,authenticated;
grant select,insert,update on alpha_private.ticket_central_intake_outcomes to service_role;
create index ticket_central_intakes_handled_idx
  on alpha_private.ticket_central_intakes(organization_key,submitted_at desc,id collate "C" desc)
  where status in ('accepted','declined');
