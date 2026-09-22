-- Alpha cloud control plane — the invite code, removed
--
-- Joining a workspace by code is gone: a project manager puts people in one,
-- against a name, as a decision they are accountable for. A code is the
-- opposite of that. It names nobody, it outlives the message it was pasted
-- into, and whoever ends up holding the string decides the staffing.
--
-- The route, the registry method, the directory interface and both store
-- implementations went with that change. This is the column they read, left
-- behind so that dropping it could be its own migration rather than smuggled
-- into a refactor.
--
-- ## Why it goes rather than staying harmlessly
--
-- It is not harmless. `summary()` still handed the code to admins, so the API
-- went on publishing a credential that nothing could redeem -- an invitation
-- to paste it somewhere and wonder why it did nothing. And a column that
-- exists is a column someone can write a query against: the next person to
-- want "let people join" would find a join_code sitting there and build the
-- door again without ever reading why it was closed.
--
-- ## Nothing is lost
--
-- The codes were never a record of anything. They granted access at the moment
-- they were typed and said nothing about who used one; membership itself lives
-- in `workspace_members`, which is untouched. There is no history here to keep.

drop index if exists idx_workspaces_join_code;

alter table workspaces drop column if exists join_code;
