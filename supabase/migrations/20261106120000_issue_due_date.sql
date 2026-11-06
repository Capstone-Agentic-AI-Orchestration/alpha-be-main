-- A task deadline is distinct from its planned Gantt schedule.
alter table public.issues
  add column due_date date;

comment on column public.issues.due_date is 'Expected finish date for this task; independent of its planned schedule.';
