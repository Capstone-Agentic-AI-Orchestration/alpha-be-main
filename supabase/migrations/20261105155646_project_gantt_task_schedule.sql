-- Planned dates and dependency links power the project Gantt view. Dates are
-- calendar dates (not timestamps); dependency IDs stay on the issue row so
-- the existing project issue sync remains the single source of task data.
alter table public.issues
  add column planned_start_date date,
  add column planned_end_date date,
  add column depends_on_issue_ids jsonb not null default '[]'::jsonb,
  add constraint issues_depends_on_issue_ids_array
    check (pg_catalog.jsonb_typeof(depends_on_issue_ids) = 'array'),
  add constraint issues_planned_dates_order
    check (planned_start_date is null or planned_end_date is null or planned_end_date >= planned_start_date);

comment on column public.issues.planned_start_date is 'Planned calendar start date for project scheduling.';
comment on column public.issues.planned_end_date is 'Planned calendar end date for project scheduling.';
comment on column public.issues.depends_on_issue_ids is 'Issue IDs that must finish before this issue can start.';
