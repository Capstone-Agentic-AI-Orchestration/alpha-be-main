-- Alpha cloud control plane — the board moves for everyone, as it moves
--
-- Until now a change reached other people when they next asked: the web app
-- re-syncs when it regains focus, a desktop when someone presses Sync. So a
-- project manager watching a developer's run saw the card move some time
-- after it moved, and two people editing the same board spent the interval
-- looking at different truths.
--
-- The database says so instead. Every write to `issues` and `projects` is
-- broadcast on that workspace's own channel, and the people in that workspace
-- are the only ones who may listen to it.
--
-- ## Why broadcast rather than `postgres_changes`
--
-- `postgres_changes` would mean adding these tables to the `supabase_realtime`
-- publication and letting Realtime decide per subscriber what they may see,
-- which is a second, weaker copy of the rules in `0002`. A broadcast carries
-- only what this workspace's members may already read, and the policy below is
-- one line rather than a per-row filter.
--
-- ## Why the payload is not trusted
--
-- The message carries the row, but a client is expected to re-read what it
-- needs. A broadcast is a nudge ("the board moved"), not the board: it can
-- arrive out of order, and a row a client cannot see must not become visible
-- because it was mentioned in a message.

create or replace function alpha.broadcast_board_change()
returns trigger
security definer
set search_path = ''
language plpgsql
as $$
declare
  board_workspace text;
begin
  -- `new` is unassigned on a delete, and `old` on an insert; only the field
  -- access needs the branch, since passing the record itself is safe.
  if tg_op = 'DELETE' then
    board_workspace := old.workspace_id;
  else
    board_workspace := new.workspace_id;
  end if;

  if board_workspace is null then
    return null;
  end if;

  perform realtime.broadcast_changes(
    'workspace:' || board_workspace || ':board',  -- topic
    tg_op,                                        -- event
    tg_op,                                        -- operation
    tg_table_name,                                -- table
    tg_table_schema,                              -- schema
    new,                                          -- the row as it now is
    old                                           -- and as it was
  );
  return null;
end;
$$;

comment on function alpha.broadcast_board_change() is
  'Announces a board write on the workspace channel. SECURITY DEFINER so the announcement is not subject to the writer''s own row policies -- a developer''s write must not fail because they may not publish.';

drop trigger if exists broadcast_issue_changes on issues;
create trigger broadcast_issue_changes
  after insert or update or delete on issues
  for each row execute function alpha.broadcast_board_change();

drop trigger if exists broadcast_project_changes on projects;
create trigger broadcast_project_changes
  after insert or update or delete on projects
  for each row execute function alpha.broadcast_board_change();

-- Who may listen: the people in that workspace, and nobody else. The claim is
-- the same one every other policy reads, so a token minted for one workspace
-- cannot hear another's board.
create policy "listen to your workspace board" on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and alpha.workspace() is not null
    and realtime.topic() = 'workspace:' || alpha.workspace() || ':board'
  );
