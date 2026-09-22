-- Alpha cloud control plane — the agent columns the roster actually needs
--
-- `agents` was created from the desktop's table as it stood, and five columns
-- have been added there since. Two of them decide behaviour that matters here:
--
--   allowed_users     who may address this agent -- 'everyone', 'team',
--                     'admins' or 'private'. Absent, every agent reads as
--                     'team', which is more access than 'private' was meant to
--                     grant. It is the column `canAccessProjectAgent` asks
--                     about, so without it the check cannot be made at all.
--   is_seeded,        which of Alpha's official roles a row is, and at which
--   template_key,     revision. Seeding is idempotent per workspace, and
--   template_version  without the key it has nothing to be idempotent on: each
--                     deploy would add another copy of every official agent.
--   phase             the delivery phase an official role belongs to.
--
-- The partial unique index is what makes "seed if absent" a single statement:
-- one row per template per workspace, with hand-made agents (no template key)
-- unconstrained.

alter table agents add column if not exists allowed_users    text;
alter table agents add column if not exists template_key     text;
alter table agents add column if not exists template_version integer;
alter table agents add column if not exists phase            text;
alter table agents add column if not exists is_seeded        boolean not null default false;

create unique index if not exists idx_agents_workspace_template
  on agents (workspace_id, template_key)
  where template_key is not null;
