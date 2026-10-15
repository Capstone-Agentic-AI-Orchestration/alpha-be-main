-- Record only whether a client explicitly completed Alpha password setup.
-- The actual password remains exclusively in Supabase Auth.
create table alpha_private.ticket_client_password_credentials (
  client_user_id text primary key check (btrim(client_user_id) <> ''),
  configured_at timestamptz not null default now()
);

alter table alpha_private.ticket_client_password_credentials enable row level security;
revoke all on alpha_private.ticket_client_password_credentials from public, anon, authenticated;
