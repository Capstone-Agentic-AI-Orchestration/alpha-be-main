-- Alpha cloud control plane — private run channels
--
-- The desktop streams a run's stages, log chunks and activity over Supabase
-- Realtime broadcast on `run:<id>`. Broadcast channels sit outside table
-- policies: a public channel can be joined, read and written by anyone holding
-- the anon key -- which the web bundle ships -- who knows or guesses a run id.
-- Log chunks carry what an agent printed, which can include the prompt and the
-- code the privacy split keeps from everyone but the owner and their overseers.
--
-- Realtime Authorization checks a *private* channel against RLS on
-- `realtime.messages`: SELECT to receive, INSERT to send. These policies make
-- a run's channel exactly as visible as the run itself. `prototype_runs` is
-- read inside the policy with the caller's own rights, so its policies decide:
-- the owner and their workspace's PMs and admins can listen, nobody else can,
-- and only the owner can publish. A token Alpha did not issue reads as nobody
-- (0004), so it can do neither.
--
-- The rule takes effect once the project stops admitting public channels:
-- Supabase → Realtime → Settings → "Allow public access" off. Turn that off
-- after the clients that open private channels are deployed, or the current
-- broadcasts stop.

create policy "listen to runs you can see" on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and exists (
      select 1 from public.prototype_runs r
      where 'run:' || r.id = realtime.topic()
    )
  );

create policy "publish to your own runs" on realtime.messages
  for insert to authenticated
  with check (
    extension = 'broadcast'
    and exists (
      select 1 from public.prototype_runs r
      where 'run:' || r.id = realtime.topic()
        and r.owner_id = alpha.login()
    )
  );
