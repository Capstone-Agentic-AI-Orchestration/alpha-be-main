-- Alpha cloud control plane — one owner per squad
--
-- `workspace_squad_owners` was created unique on (workspace_id, squad_id,
-- user_id), which says a squad may have any number of owners as long as each
-- person appears once. The code says the opposite and always has: binding an
-- owner upserts on (workspace_id, squad_id), replacing whoever held it, and
-- `squadOwnerId()` reads a single owner per squad. Ownership is what decides
-- whether a developer can see a squad at all, so "several owners" is not a
-- shape this product has an answer for.
--
-- SQLite has had the intended constraint since the table existed. This makes
-- Postgres agree, before the cloud starts writing these rows.
--
-- Nothing is lost: the table is empty in every deployment, because the cloud
-- has never written to it. Were it not, this would fail loudly on the
-- duplicate rather than choosing an owner on its own -- which is the right
-- outcome for a row that decides access.

alter table workspace_squad_owners
  drop constraint if exists workspace_squad_owners_workspace_id_squad_id_user_id_key;

alter table workspace_squad_owners
  add constraint workspace_squad_owners_workspace_id_squad_id_key
  unique (workspace_id, squad_id);
