-- Alpha cloud control plane — an agent's execution config stays on the machine
--
-- `custom_cli_args` and `env_vars` are input to a process the desktop spawns:
-- flags appended to the agent CLI's command line, and variables merged over
-- its environment. In a shared table they are writable by every developer in
-- the workspace ("developers write agents") and readable by every member
-- ("members read agents"). So:
--
--   - a developer could set NODE_OPTIONS, PATH or BASH_ENV on a shared agent
--     and have it run code on every teammate's machine that runs that agent.
--     `custom_cli_args` is filtered by a denylist, which is a weaker promise
--     than never receiving the value at all;
--   - an API key someone kept in env_vars -- which is what it is for -- would
--     be readable by every member of the workspace, clients included.
--
-- Neither is shared state. Like a path, they only mean something on one
-- machine, and they stay in the desktop's SQLite: the rule 0001 states for
-- paths applies to anything that would execute there, too.
--
-- Dropped rather than locked with column privileges. Supabase grants table
-- privileges to `authenticated`, and in Postgres a column-level REVOKE does not
-- subtract from a table-level GRANT -- `revoke update (env_vars) on agents`
-- would have run cleanly and changed nothing.
--
-- The store driver must not map these two fields onto cloud rows.

alter table agents drop column if exists custom_cli_args;
alter table agents drop column if exists env_vars;
