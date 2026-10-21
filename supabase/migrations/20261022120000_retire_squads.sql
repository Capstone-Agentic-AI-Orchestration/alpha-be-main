-- Squads were removed from Alpha. The Orchestrator assigns agents to each build
-- task by role, and project agent access follows each agent's own visibility.
--
-- Existing squad rows stay readable so old issues, build history, and Live
-- Build Room runs still load. Nothing may create, edit, delete, own, or assign
-- a squad any more. The read policies from 0013_policy_hygiene are kept.
--
-- squad_runs keeps its write policies on purpose: a legacy run that is still
-- open when a desktop upgrades must be able to finish or be cancelled, and the
-- desktop syncs that status with an upsert, which row level security checks
-- against the insert policy as well as the update policy.

drop policy if exists "developers add squads" on squads;
drop policy if exists "developers change squads" on squads;
drop policy if exists "developers remove squads" on squads;

drop policy if exists "claim squad ownership" on workspace_squad_owners;
drop policy if exists "change squad ownership" on workspace_squad_owners;
drop policy if exists "release squad ownership" on workspace_squad_owners;

drop policy if exists "overseers assign squads" on workspace_squad_projects;
drop policy if exists "overseers change squad assignments" on workspace_squad_projects;
drop policy if exists "overseers unassign squads" on workspace_squad_projects;
