-- Look up a workspace's tickets by client account.
--
-- The PM Clients list (GET /tickets/clients) and the queue's per-client filter
-- group a workspace's tickets by client_user_id. The existing
-- UNIQUE (workspace_id, id, client_user_id) leads with the ticket id, so it
-- cannot serve that lookup. Tickets from an unverified inquiry have no client
-- account yet and are left out of the index.
create index if not exists tickets_workspace_client_idx
  on alpha_private.tickets (workspace_id, client_user_id)
  where client_user_id is not null;
