-- Additive, private setup state. Passwords remain exclusively in Supabase Auth.
create table alpha_private.ticket_client_account_setups (
  id_hash text primary key check (id_hash ~ '^[a-f0-9]{64}$'),
  client_user_id text not null,
  email text not null,
  action text not null check (action in ('set_password','sign_in','reset_password')),
  csrf_hash text not null check (csrf_hash ~ '^[a-f0-9]{64}$'),
  protected_proof text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  processing_until timestamptz,
  lease_id text,
  check (expires_at > created_at),
  check (consumed_at is not null or protected_proof is not null)
);
create index ticket_client_account_setups_user_idx
  on alpha_private.ticket_client_account_setups(client_user_id) where consumed_at is null;
create index ticket_client_account_setups_expiry_idx
  on alpha_private.ticket_client_account_setups(expires_at) where consumed_at is null;
alter table alpha_private.ticket_client_account_setups enable row level security;
revoke all on alpha_private.ticket_client_account_setups from public, anon, authenticated;
