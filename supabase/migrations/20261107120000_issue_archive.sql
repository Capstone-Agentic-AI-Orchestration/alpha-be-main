-- Archived cards leave the board but keep their comments and history, and can
-- be restored. Agents archive; only a person deletes a card permanently.
alter table public.issues
  add column archived_at timestamptz,
  add column archived_by text;

comment on column public.issues.archived_at is 'When the card was archived; null while it is on the board.';
comment on column public.issues.archived_by is 'Who archived the card, or the agent and the person it acted for.';
