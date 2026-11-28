import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase, sqlFor } from '../store/testDatabase.js';
import type { TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { PostgresProjectStore } from '../store/postgresProjectStore.js';
import { PostgresTicketQueueStore } from '../store/ticketQueuePostgresStore.js';
import { PostgresTicketClientActivationStore } from '../store/ticketClientActivationPostgresStore.js';
import { createTicketQueueService } from './ticketQueueService.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { ClientRemoval } from './clientRemoval.js';

/**
 * Removing a client on the complete migration schema: access ends, their own
 * projects are archived while a project another client uses is kept, they
 * leave the Clients page, and the same person can come back on a new account.
 * GitHub and Supabase Auth are faked; the database is real.
 */

const pm: TicketSubject = { kind: 'internal', userId: 'pm', authentication: { kind: 'verified_github_bearer', verificationId: 'verified' } };
let pg: PGlite;
let db: TransactionalSql;
let projects: PostgresProjectStore;
let archived: string[];
let retired: string[];

function removal(identity = true) {
  return new ClientRemoval(db, {
    projects: () => projects,
    archive: async ({ workspaceId, project, by }) => {
      archived.push(project.id);
      const updated = await projects.setArchived(workspaceId, project.id, { at: new Date().toISOString(), by });
      return { project: updated!, repositories: [{ repo: 'org/' + project.key.toLowerCase(), state: 'archived' }] };
    },
    identity: identity ? { deleteUser: async userId => { retired.push(userId); } } : null,
  });
}

async function ticket(user: string, projectId: string, n: number) {
  const state = { ...newTicketWorkflow(`ticket-${user}-${n}`, 'workspace-a', user), projectId };
  await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,
    workflow_state,client_user_id,project_id,project_display_name,project_client_visible,created_at,client_updated_at,internal_updated_at)
    values ($1,'workspace-a',$1,'Request','Description','Client','authenticated_client','received',0,$2,$3,$4,'Project',true,now(),now(),now())`,
  [state.id, JSON.stringify(state), user, projectId]);
  await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active) values ('workspace-a',$1,$2,true)`,
    [state.id, user]);
}

beforeAll(async () => {
  pg = await createTestDatabase();
  db = { ...sqlFor(pg), transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
  projects = new PostgresProjectStore(db);
}, 60000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  archived = [];
  retired = [];
  await pg.exec('truncate public.workspaces cascade');
  await pg.exec('delete from alpha_private.ticket_client_sessions');
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json) values
    ('workspace-a','A','a','active','{"ticketing_write_mode":"enabled"}'),
    ('workspace-b','B','b','active','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values ('member','workspace-a','pm','pm')`);
  await db.query(`insert into public.projects(id,workspace_id,name,key,status,resources) values
    ('own','workspace-a','Own site','OWN','active','[{"id":"r1","type":"github_repo","pathOrUrl":"https://github.com/org/own"}]'),
    ('shared','workspace-a','Shared portal','SHR','active','[]')`);
  for (const user of ['client-a', 'client-b']) {
    await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,write_mode)
      values ($1,'workspace-a',$1,'active',$2,'enabled')`, [user, user === 'client-a' ? 'Acme' : 'Beta']);
    await db.query(`insert into alpha_private.ticket_client_sessions(session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
      values ($1,$2,$3,now()-interval '1 minute',now()+interval '1 day')`, [(user === 'client-a' ? 'a' : 'b').repeat(64), user, 'c'.repeat(64)]);
  }
  await ticket('client-a', 'own', 1);
  await ticket('client-a', 'shared', 2);
  await ticket('client-b', 'shared', 3);
});

const clientKeys = async () =>
  (await createTicketQueueService(new PostgresTicketQueueStore(db)).listClients('workspace-a', pm)).map(client => client.key);

describe('removing a client', () => {
  it('previews the projects it would archive and the one another client keeps', async () => {
    const preview = await removal().preview('workspace-a', pm, 'client:client-a');
    expect(preview).toMatchObject({ key: 'client:client-a', displayName: 'Acme', tickets: 2 });
    expect(preview.projects).toEqual([
      { projectId: 'own', name: 'Own site', key: 'OWN', repositories: ['org/own'], archived: false, sharedWithOtherClients: false },
      { projectId: 'shared', name: 'Shared portal', key: 'SHR', repositories: [], archived: false, sharedWithOtherClients: true },
    ]);
  });

  it('needs the client named as confirmation', async () => {
    await expect(removal().remove('workspace-a', pm, 'client:client-a', { confirm: 'client:client-b' }))
      .rejects.toMatchObject({ status: 400 });
    expect(await clientKeys()).toContain('client:client-a');
  });

  it('revokes access, archives only their own projects, retires the sign-in and leaves the Clients page', async () => {
    const result = await removal().remove('workspace-a', pm, 'client:client-a', { confirm: 'client:client-a' });

    expect(result).toMatchObject({ displayName: 'Acme', ticketsRevoked: 2, signIn: 'retired' });
    expect(result.projects.map(p => [p.projectId, p.outcome])).toEqual([['own', 'archived'], ['shared', 'kept_shared']]);
    expect(archived).toEqual(['own']);
    expect(retired).toEqual(['client-a']);
    expect((await projects.get('workspace-a', 'own'))?.archivedAt).toBeTruthy();
    expect((await projects.get('workspace-a', 'shared'))?.archivedAt).toBeUndefined();

    const grants = await db.query<{ client_user_id: string; status: string; revoked: boolean }>(
      `select client_user_id, status, revoked_at is not null as revoked from alpha_private.ticket_service_grants order by client_user_id`);
    expect(grants.rows).toEqual([
      { client_user_id: 'client-a', status: 'revoked', revoked: true },
      { client_user_id: 'client-b', status: 'active', revoked: false },
    ]);
    const ticketGrants = await db.query<{ ticket_id: string; active: boolean }>(
      'select ticket_id, active from alpha_private.ticket_client_grants order by ticket_id');
    expect(ticketGrants.rows.map(row => [row.ticket_id, row.active])).toEqual([
      ['ticket-client-a-1', false], ['ticket-client-a-2', false], ['ticket-client-b-3', true],
    ]);
    const sessions = await db.query<{ client_user_id: string; revoked: boolean }>(
      'select client_user_id, revoked_at is not null as revoked from alpha_private.ticket_client_sessions order by client_user_id');
    expect(sessions.rows).toEqual([{ client_user_id: 'client-a', revoked: true }, { client_user_id: 'client-b', revoked: false }]);
    const audit = await db.query<{ ticket_id: string }>(
      `select ticket_id from alpha_private.ticket_audit_events where event_type = 'client_removed' order by ticket_id`);
    expect(audit.rows.map(row => row.ticket_id)).toEqual(['ticket-client-a-1', 'ticket-client-a-2']);
    // Their tickets stay; only the client is gone from the page.
    expect(await clientKeys()).toEqual(['client:client-b']);
    expect(await projects.linkedToTickets('workspace-a', 'own')).toBe(true);
  });

  it('lets the same person come back on a new account, never on the removed one', async () => {
    await removal().remove('workspace-a', pm, 'client:client-a', { confirm: 'client:client-a' });
    const activation = new PostgresTicketClientActivationStore(db);
    const grant = (user: string) => activation.transaction(tx => tx.ensureClientServiceGrant('workspace-a', user, new Date().toISOString()));
    expect(await grant('client-a')).toBe(false);
    expect(await grant('client-a-new-account')).toBe(true);
  });

  it('keeps the sign-in of a client another workspace still grants access', async () => {
    await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,write_mode)
      values ('client-a-b','workspace-b','client-a','active','Acme','enabled')`);
    const result = await removal().remove('workspace-a', pm, 'client:client-a', { confirm: 'client:client-a' });
    expect(result.signIn).toBe('kept_other_access');
    expect(retired).toEqual([]);
    const session = await db.query<{ revoked: boolean }>(
      `select revoked_at is not null as revoked from alpha_private.ticket_client_sessions where client_user_id = 'client-a'`);
    expect(session.rows[0]?.revoked).toBe(false);
  });

  it('says when the sign-in could not be retired here', async () => {
    const result = await removal(false).remove('workspace-a', pm, 'client:client-a', { confirm: 'client:client-a' });
    expect(result.signIn).toBe('unavailable');
  });
});
