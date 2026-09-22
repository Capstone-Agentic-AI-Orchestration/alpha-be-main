-- Alpha cloud control plane — browser sessions
--
-- Sessions lived in the Render service's SQLite file, on a disk that is
-- replaced on every deploy and every free-tier spin-down, so each of those
-- signed everybody out. They move here.
--
-- A session row is a credential. `id` is the SHA-256 of the cookie, which
-- cannot be turned back into one, and the GitHub token is AES-256-GCM
-- ciphertext under ALPHA_SESSION_SECRET, which lives only in the cloud's
-- environment. Neither is usable from the database alone -- but the rows still
-- say who is signed in, from when, and they are nobody's business but the
-- server's. So they sit where the Data API cannot reach:
--
--   - `alpha_private` is not an exposed schema, so PostgREST serves it to no
--     one, whatever key or token they hold.
--   - anon and authenticated get no USAGE on it, so nothing they can call --
--     an rpc, a view someone adds later -- can name these tables either.
--   - RLS is on with no policies: the last line, if a grant slips in.
--
-- The cloud connects as the tables' owner, which RLS does not restrict.

create schema if not exists alpha_private;
revoke all on schema alpha_private from public, anon, authenticated;

create table if not exists alpha_private.sessions (
  id           text primary key,
  login        text not null,
  name         text,
  role         text not null check (role in ('client', 'dev', 'pm', 'admin')),
  token_cipher text not null,
  token_iv     text not null,
  token_tag    text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz
);

-- Revoking everyone a login holds, and sweeping the expired.
create index if not exists idx_sessions_login on alpha_private.sessions (login);
create index if not exists idx_sessions_expires on alpha_private.sessions (expires_at);

alter table alpha_private.sessions enable row level security;
revoke all on alpha_private.sessions from public, anon, authenticated;
