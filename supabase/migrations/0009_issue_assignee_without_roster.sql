-- Alpha cloud control plane — an issue may name an agent the cloud has not met
--
-- `issues.assigned_agent_id` references `agents`, and the cloud's `agents`
-- table is empty: the roster still lives in each machine's SQLite, and moves
-- here in the slice after this one. Meanwhile the board does move, and a PM
-- assigning an agent to a card is an ordinary thing to do -- so the foreign
-- key would refuse the write, or the write would have to silently drop the
-- assignment. Both are worse than an unenforced reference.
--
-- So the column stays and the constraint goes, for exactly as long as the two
-- halves live in different places. When agents land in Postgres, the
-- constraint comes back -- and the migration that restores it has to decide
-- what to do with any assignment that names an agent that no longer exists,
-- which is a question worth asking out loud rather than answering by deleting
-- rows now.
--
-- `assigned_squad_id` never had a foreign key, for the same reason it does not
-- need one now.

alter table issues
  drop constraint if exists issues_assigned_agent_id_fkey;

comment on column issues.assigned_agent_id is
  'Agent that owns this issue. Not a foreign key while the roster is per-machine; see 0009.';
