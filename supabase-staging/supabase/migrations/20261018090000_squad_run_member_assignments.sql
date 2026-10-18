-- Keep the staging control plane aligned with the sequential runner payload.
alter table squad_runs
  add column if not exists member_assignments jsonb not null default '[]'::jsonb;
