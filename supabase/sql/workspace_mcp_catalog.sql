-- Workspace-shared MCP definitions.
--
-- Apply this complete file in the Supabase SQL Editor until the Supabase CLI
-- is available to generate and track the repository migration. The backend
-- cloud API also checks workspace roles; RLS protects direct Data API access.

create table if not exists public.workspace_mcp_servers (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  name text not null,
  server_config jsonb not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, name),
  constraint workspace_mcp_servers_name_shape
    check (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$' and position('__' in name) = 0),
  constraint workspace_mcp_servers_config_shape
    check (
      jsonb_typeof(server_config) = 'object'
      and (
        (
          coalesce(server_config ->> 'type', 'stdio') = 'stdio'
          and nullif(btrim(server_config ->> 'command'), '') is not null
        )
        or (
          server_config ->> 'type' in ('http', 'sse')
          and server_config ->> 'url' ~ '^https?://'
        )
      )
    )
);

alter table public.workspace_mcp_servers enable row level security;
revoke all on table public.workspace_mcp_servers from anon, authenticated;
grant select, insert, update, delete on table public.workspace_mcp_servers to authenticated;

drop policy if exists "workspace overseers manage MCP catalog" on public.workspace_mcp_servers;
create policy "workspace overseers manage MCP catalog"
  on public.workspace_mcp_servers
  for all
  to authenticated
  using (
    alpha.in_workspace(workspace_id)
    and alpha.is_overseer()
  )
  with check (
    alpha.in_workspace(workspace_id)
    and alpha.is_overseer()
    and updated_by = alpha.login()
  );

comment on table public.workspace_mcp_servers is
  'Workspace-shared MCP definitions; direct reads and writes are limited to workspace project managers and admins.';
