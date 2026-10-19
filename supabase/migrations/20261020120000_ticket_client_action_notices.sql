-- Client "waiting on you" notices and one reminder per request.
--
-- Messages and documents already queue a generic email. A PM sharing a proposed scope or a finished
-- result changes only the ticket state, so the client was never told. The notification worker now
-- queues two more kinds from that state: "action" (a scope or result is waiting) and "reminder"
-- (still waiting after a few days). Both reuse the existing durable queue, lease, retry and
-- dead-letter columns; the unique (workspace_id, dedupe_key) makes each request notify once.
--
-- Additive and safe in either deploy order: until it is applied the worker's sweep fails by itself
-- (and logs it) while message and document emails keep sending.
alter table alpha_private.ticket_communication_notifications
  drop constraint ticket_communication_notifications_notification_kind_check,
  add constraint ticket_communication_notifications_notification_kind_check
    check (notification_kind in ('message', 'document', 'action', 'reminder'));
