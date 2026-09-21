-- Alpha cloud control plane — trust only tokens Alpha issued
--
-- The claim accessors in 0002 read whatever `auth.jwt()` returns. Supabase
-- verifies a token's signature, not who issued it, and more than Alpha signs
-- with this project's secret: Supabase Auth mints session tokens (sign-ups are
-- off today, but that is one dashboard toggle), and the project's API keys are
-- JWTs too. A Supabase Auth session carries a `sub`, and "everyone reads
-- skills" granted read to any token with a subject.
--
-- So the accessors now take claims only from a token whose issuer is 'alpha',
-- which `supabaseTokenService` stamps on every token it mints. Anything else
-- reads as no login, no workspace and the lowest role -- the same as the anon
-- key. One accessor holds the check, so no policy can read around it.
--
-- `create or replace` keeps each function's grants and every policy that calls
-- it; nothing else needs recreating.
--
-- Left as they are, on purpose, and flagged by Supabase's advisors:
--
--   - `search_path` is not pinned on these functions. A SET clause stops a SQL
--     function being inlined, so every policy would call it once per row. They
--     are SECURITY INVOKER -- they run with the caller's own rights -- and
--     PostgREST callers cannot set search_path, so pinning it buys nothing
--     until the policies are rewritten to call them as `(select ...)` initplans.
--   - "multiple permissive policies": each `for all` write policy also applies
--     to SELECT beside its read policy. A cost per row, not a hole; worth
--     splitting when the tables are large enough to notice.

create or replace function alpha.claims() returns jsonb
language sql stable as $$
  select case when auth.jwt() ->> 'iss' = 'alpha' then auth.jwt() else '{}'::jsonb end
$$;

create or replace function alpha.login() returns text
language sql stable as $$
  select nullif(alpha.claims() ->> 'sub', '')
$$;

create or replace function alpha.workspace() returns text
language sql stable as $$
  select nullif(alpha.claims() ->> 'workspace_id', '')
$$;

create or replace function alpha.alpha_role() returns text
language sql stable as $$
  select coalesce(alpha.claims() ->> 'alpha_role', 'client')
$$;
