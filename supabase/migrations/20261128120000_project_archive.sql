-- Archived projects leave the project lists but keep their board, history and
-- client tickets, and can be restored. Archiving a project also archives its
-- GitHub repositories (read-only on GitHub); restoring unarchives them.
-- A PM removing a client archives that client's projects this way.
alter table public.projects
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text;

comment on column public.projects.archived_at is 'When the project was archived; null while it is active.';
comment on column public.projects.archived_by is 'Who archived the project.';
