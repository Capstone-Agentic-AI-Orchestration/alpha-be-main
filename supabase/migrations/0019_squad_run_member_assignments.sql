-- Freeze each member's role-specific work boundary when a sequential build starts.
alter table squad_runs
  add column if not exists member_assignments jsonb not null default '[]'::jsonb;
