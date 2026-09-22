-- Alpha cloud control plane — the roster is shared, so an agent is readable
-- only by whoever the agent says may address it, and an issue's assignee is a
-- real agent again.
--
-- Until now the roster lived on each machine and the cloud's copy was seeded
-- fresh per deploy, so neither of these mattered. Desktops now publish their
-- agents and squads here, which makes both urgent:
--
--   * A developer's agent carries a system prompt they wrote. `members read
--     agents` let every member of the workspace read every agent row through
--     the Data API, while the application has always hidden an agent marked
--     `private` from everyone but its owner, and one marked `admins` from
--     everyone but administrators. The policy now says the same thing, so
--     publishing a private agent does not hand its prompt to the team.
--
--   * `0009` dropped the foreign key on `issues.assigned_agent_id` because the
--     roster was per-machine and the cloud could not have known the agent an
--     issue named. It can now, so the reference is enforced again.
--
-- `owner` holds a GitHub login for agents made from now on; older rows hold
-- the placeholder 'You', which matches no login. A `private` agent of theirs
-- is therefore readable by nobody, which is exactly how the application has
-- always behaved for them -- `canAccessProjectAgent` makes the same
-- comparison -- so this changes no answer anyone was getting.

drop policy if exists "members read agents" on agents;

create policy "members read agents they may address" on agents
  for select using (
    alpha.in_workspace(workspace_id) and (
      coalesce(allowed_users, 'team') = 'everyone'
      or (coalesce(allowed_users, 'team') = 'team' and alpha.alpha_role() <> 'client')
      or (allowed_users = 'admins' and alpha.is_admin())
      or (allowed_users = 'private' and owner = alpha.login())
    )
  );

-- Writing follows reading: a developer may add and change the workspace's
-- agents, but not someone else's private one -- which they cannot read either.
--
-- Three policies rather than one `for all`, because a `for all` policy's
-- `using` clause also grants SELECT, and permissive policies are OR'd: the
-- old one handed every developer the agents marked for administrators only,
-- through the very rule meant to govern writing.
drop policy if exists "developers write agents" on agents;

create policy "developers add agents" on agents
  for insert
  with check (
    alpha.in_workspace(workspace_id)
    and alpha.alpha_role() in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = alpha.login())
  );

create policy "developers change agents" on agents
  for update
  using (
    alpha.in_workspace(workspace_id)
    and alpha.alpha_role() in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = alpha.login())
  )
  with check (
    alpha.in_workspace(workspace_id)
    and alpha.alpha_role() in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = alpha.login())
  );

create policy "developers remove agents" on agents
  for delete
  using (
    alpha.in_workspace(workspace_id)
    and alpha.alpha_role() in ('dev', 'admin')
    and (coalesce(allowed_users, 'team') <> 'private' or owner = alpha.login())
  );

-- An assignment naming an agent that is not here is cleared rather than
-- carried: the card stays, and its assignee is empty instead of pointing at
-- something nobody can resolve. This is the question `0009` said should be
-- asked out loud rather than answered by deleting rows.
update issues
   set assigned_agent_id = null
 where assigned_agent_id is not null
   and not exists (select 1 from agents a where a.id = issues.assigned_agent_id);

alter table issues
  drop constraint if exists issues_assigned_agent_id_fkey;

-- `on delete set null`, not cascade: deleting an agent must not delete the
-- work it was assigned, which is the whole board's worth of cards for a role
-- somebody retires.
alter table issues
  add constraint issues_assigned_agent_id_fkey
  foreign key (assigned_agent_id) references agents(id) on delete set null;

comment on column issues.assigned_agent_id is
  'Agent that owns this issue. A real reference again since 0011; cleared if that agent is deleted.';
