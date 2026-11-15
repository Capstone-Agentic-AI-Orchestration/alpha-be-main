/**
 * SQL that decides who a ticket's client is and what that client can see.
 *
 * The PM queue, the "All clients" filter, the PM Clients list and the client
 * portal each need the same answers. Written out in each query they drift: a
 * PM would see a client under one name in the filter and another in the list,
 * or see a project on a client's page that the client cannot open. Each answer
 * is therefore written once, here.
 *
 * Every fragment reads the ticket as alias `t` (`alpha_private.tickets`).
 */

/**
 * The client grouping key: `client:<account>` once the person has a client
 * account, otherwise `ticket:<id>` for an unverified inquiry. Never derived
 * from an email address.
 */
export const CLIENT_GROUP_KEY_SQL = `case when t.client_user_id is not null then 'client:' || t.client_user_id
  else 'ticket:' || t.id end`;

/**
 * The contact rows a client's name comes from, as `unverified_contact` and
 * `verified_contact`. `onlyWhen` lets a query that serves several audiences
 * skip the lookups for the ones that never see a name.
 */
export function clientContactJoinsSql(onlyWhen = 'true'): string {
  return `left join lateral (
           select contact.full_name
           from alpha_private.ticket_contacts contact
           where ${onlyWhen} and t.client_user_id is null
             and contact.workspace_id = t.workspace_id and contact.id = t.contact_id
           limit 1
         ) unverified_contact on true
         left join lateral (
           select contact.full_name, contact.company
           from alpha_private.tickets linked_ticket
           join alpha_private.ticket_contacts contact
             on contact.workspace_id = linked_ticket.workspace_id and contact.id = linked_ticket.contact_id
           where ${onlyWhen} and t.client_user_id is not null
             and linked_ticket.workspace_id = t.workspace_id and linked_ticket.client_user_id = t.client_user_id
             and contact.email_verified
           order by linked_ticket.created_at, linked_ticket.id collate "C"
           limit 1
         ) verified_contact on true`;
}

/**
 * The client's display name, from the joins above and the service grant's
 * display name (`serviceGrantName`, a column expression in the caller's query).
 */
export function clientGroupNameSql(serviceGrantName: string): string {
  return `case when t.client_user_id is null
    then coalesce(nullif(btrim(unverified_contact.full_name), ''), 'Unverified inquiry')
    else coalesce(nullif(btrim(verified_contact.full_name), ''),
      nullif(btrim(verified_contact.company), ''),
      nullif(nullif(btrim(${serviceGrantName}), ''), 'Client portal'), 'Client account')
  end`;
}

/**
 * A ticket whose client can reach it now: an active workspace, the client's
 * active service grant there (`sg`) and an active grant on this ticket (`cg`).
 * Inner joins, so a ticket without them is not returned. No session: the
 * client portal adds its own session check, the PM view has none to add.
 */
export const CLIENT_TICKET_ACCESS_JOINS_SQL = `join public.workspaces w on w.id = t.workspace_id and w.status = 'active'
 join alpha_private.ticket_service_grants sg on sg.workspace_id = t.workspace_id and sg.client_user_id = t.client_user_id
   and sg.status = 'active' and sg.revoked_at is null
 join alpha_private.ticket_client_grants cg on cg.workspace_id = t.workspace_id and cg.ticket_id = t.id
   and cg.client_user_id = t.client_user_id and cg.active and cg.revoked_at is null`;

/** The ticket's project is linked, shared with the client, and still exists. */
export const CLIENT_VISIBLE_PROJECT_SQL = `t.project_id is not null and t.project_client_visible
 and exists(select 1 from public.projects p where p.id = t.project_id and p.workspace_id = t.workspace_id)`;
