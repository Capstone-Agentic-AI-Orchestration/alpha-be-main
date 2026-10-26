-- Keep a compact, durable cursor for each shared workspace board.  The log
-- stores row keys and operation names only; clients fetch row values through
-- their existing permission-checked path.

create table public.workspace_board_cursors (
  workspace_id text primary key references public.workspaces(id) on delete cascade,
  last_cursor bigint not null default 0 check (last_cursor >= 0),
  last_pruned_at timestamptz,
  retention_days integer not null default 30 check (retention_days > 0)
);

create table public.workspace_board_changes (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  cursor bigint not null check (cursor > 0),
  table_name text not null check (table_name in (
    'projects', 'issues', 'issue_comments', 'agents', 'squads',
    'workspace_squad_owners', 'workspace_squad_projects', 'workspace_project_assignments'
  )),
  row_key jsonb not null check (pg_catalog.jsonb_typeof(row_key) = 'object'),
  operation text not null check (operation in ('insert', 'update', 'delete')),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (workspace_id, cursor)
);

create index workspace_board_changes_workspace_created_idx
  on public.workspace_board_changes (workspace_id, created_at);

alter table public.workspace_board_cursors enable row level security;
alter table public.workspace_board_changes enable row level security;

revoke all on table public.workspace_board_cursors, public.workspace_board_changes
  from public, anon, authenticated;
grant select on table public.workspace_board_cursors, public.workspace_board_changes
  to authenticated;

create policy "members read their workspace board cursor"
  on public.workspace_board_cursors
  for select to authenticated
  using (workspace_id = (select alpha.workspace()));

create policy "members read their workspace board changes"
  on public.workspace_board_changes
  for select to authenticated
  using (workspace_id = (select alpha.workspace()));

-- This helper runs only under the trigger's SECURITY DEFINER context.  The
-- per-workspace counter row is locked until commit, so another write cannot
-- publish a higher cursor while a lower-cursor transaction is still open.
create or replace function alpha.record_workspace_board_change(
  p_workspace_id text,
  p_table_name text,
  p_row_key jsonb,
  p_operation text
)
returns bigint
security invoker
set search_path = ''
language plpgsql
as $$
declare
  v_cursor bigint;
  v_retention_days integer;
begin
  if p_workspace_id is null then
    return null;
  end if;

  insert into public.workspace_board_cursors as existing_cursor (workspace_id, last_cursor)
  values (p_workspace_id, 1)
  on conflict (workspace_id) do update
    set last_cursor = existing_cursor.last_cursor + 1
  returning last_cursor into v_cursor;

  insert into public.workspace_board_changes (workspace_id, cursor, table_name, row_key, operation)
  values (p_workspace_id, v_cursor, p_table_name, p_row_key, p_operation);

  update public.workspace_board_cursors
     set last_pruned_at = pg_catalog.now()
   where workspace_id = p_workspace_id
     and (last_pruned_at is null or last_pruned_at <= pg_catalog.now() - interval '1 day')
  returning retention_days into v_retention_days;

  if found then
    delete from public.workspace_board_changes
     where workspace_id = p_workspace_id
       and created_at < pg_catalog.now() - pg_catalog.make_interval(days => v_retention_days);
  end if;

  perform realtime.send(
    pg_catalog.jsonb_build_object('cursor', v_cursor::text),
    'board_changed',
    'workspace:' || p_workspace_id || ':board',
    true
  );

  return v_cursor;
end;
$$;

revoke all on function alpha.record_workspace_board_change(text, text, jsonb, text)
  from public, anon, authenticated;

-- Keep the two existing issue/project triggers, but replace their former
-- row-payload broadcast with cursor-only announcements. Add the other six
-- board tables here so each write participates in the same durable sequence.
create or replace function alpha.broadcast_board_change()
returns trigger
security definer
set search_path = ''
language plpgsql
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_old_workspace text;
  v_new_workspace text;
  v_old_key jsonb;
  v_new_key jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := pg_catalog.to_jsonb(old);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := pg_catalog.to_jsonb(new);
  end if;

  if tg_table_name = 'issue_comments' then
    if v_old is not null then
      select i.workspace_id into v_old_workspace
        from public.issues as i where i.id = v_old ->> 'issue_id';
    end if;
    if v_new is not null then
      select i.workspace_id into v_new_workspace
        from public.issues as i where i.id = v_new ->> 'issue_id';
    end if;
  else
    v_old_workspace := v_old ->> 'workspace_id';
    v_new_workspace := v_new ->> 'workspace_id';
  end if;

  if v_old is not null then
    v_old_key := pg_catalog.jsonb_build_object('id', v_old ->> 'id');
  end if;
  if v_new is not null then
    v_new_key := pg_catalog.jsonb_build_object('id', v_new ->> 'id');
  end if;

  if v_old is null then
    perform alpha.record_workspace_board_change(
      v_new_workspace, tg_table_name, v_new_key, 'insert'
    );
  elsif v_new is null then
    perform alpha.record_workspace_board_change(
      v_old_workspace, tg_table_name, v_old_key, 'delete'
    );
  elsif v_old_workspace is distinct from v_new_workspace
     or v_old_key is distinct from v_new_key then
    perform alpha.record_workspace_board_change(
      v_old_workspace, tg_table_name, v_old_key, 'delete'
    );
    perform alpha.record_workspace_board_change(
      v_new_workspace, tg_table_name, v_new_key, 'insert'
    );
  else
    perform alpha.record_workspace_board_change(
      v_new_workspace, tg_table_name, v_new_key, 'update'
    );
  end if;

  return null;
end;
$$;

revoke all on function alpha.broadcast_board_change() from public, anon, authenticated;

create trigger board_change_issue_comments
  after insert or update or delete on public.issue_comments
  for each row execute function alpha.broadcast_board_change();

create trigger board_change_agents
  after insert or update or delete on public.agents
  for each row execute function alpha.broadcast_board_change();

create trigger board_change_squads
  after insert or update or delete on public.squads
  for each row execute function alpha.broadcast_board_change();

create trigger board_change_workspace_squad_owners
  after insert or update or delete on public.workspace_squad_owners
  for each row execute function alpha.broadcast_board_change();

create trigger board_change_workspace_squad_projects
  after insert or update or delete on public.workspace_squad_projects
  for each row execute function alpha.broadcast_board_change();

create trigger board_change_workspace_project_assignments
  after insert or update or delete on public.workspace_project_assignments
  for each row execute function alpha.broadcast_board_change();

comment on table public.workspace_board_cursors is
  'Per-workspace commit-ordered cursor and change-log retention settings for the shared board.';
comment on table public.workspace_board_changes is
  'Append-only, row-key-only board changes. Row values remain behind existing workspace and row policies.';
comment on function alpha.broadcast_board_change() is
  'Records shared-board changes transactionally and sends only a cursor marker to the private workspace channel.';
