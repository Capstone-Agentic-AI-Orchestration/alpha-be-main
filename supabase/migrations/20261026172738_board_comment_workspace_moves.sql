-- Keep comments in the same workspace as their parent issue in the durable
-- board log, even though moving an issue does not update comment rows.
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
  v_comment_id text;
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

    if tg_table_name = 'issues'
       and v_old_workspace is distinct from v_new_workspace then
      for v_comment_id in
        select c.id from public.issue_comments as c where c.issue_id = v_new ->> 'id'
      loop
        perform alpha.record_workspace_board_change(
          v_old_workspace,
          'issue_comments',
          pg_catalog.jsonb_build_object('id', v_comment_id),
          'delete'
        );
        perform alpha.record_workspace_board_change(
          v_new_workspace,
          'issue_comments',
          pg_catalog.jsonb_build_object('id', v_comment_id),
          'insert'
        );
      end loop;
    end if;
  else
    perform alpha.record_workspace_board_change(
      v_new_workspace, tg_table_name, v_new_key, 'update'
    );
  end if;

  return null;
end;
$$;

revoke all on function alpha.broadcast_board_change() from public, anon, authenticated;

comment on function alpha.broadcast_board_change() is
  'Records shared-board changes transactionally, follows issue workspace moves for existing comments, and sends only cursor markers to private workspace channels.';
