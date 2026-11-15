import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase, sqlFor } from './testDatabase.js';
import type { TransactionalSql } from './database.js';
import type { TicketSubject } from './ticketCommandStore.js';
import { PostgresTicketQueueStore } from './ticketQueuePostgresStore.js';
import { createTicketQueueService } from '../services/ticketQueueService.js';
import { PostgresClientProjectPortal } from '../services/clientProjectPortal.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';

/*
 * The PM Clients list on the full migration schema. It must agree with the
 * queue filtered to the same client, with the "All clients" names, and with
 * the projects the client portal shows that client.
 */

const pm: TicketSubject = { kind: 'internal', userId: 'pm', authentication: { kind: 'verified_github_bearer', verificationId: 'verified' } };
const clientA: TicketSubject = { kind: 'client', userId: 'client-a', sessionId: 'a'.repeat(64) };
let pg: PGlite;
let db: TransactionalSql;
let service: ReturnType<typeof createTicketQueueService>;

async function ticket(input: {
  id: string; client: string | null; contact: string; status?: string; project?: string | null;
  visible?: boolean; grant?: boolean; minutesAgo?: number;
}) {
  const state = { ...newTicketWorkflow(input.id, 'workspace-a', input.client), status: input.status ?? 'received' };
  if (['closed', 'declined', 'cancelled'].includes(state.status)) {
    Object.assign(state, { actionOwner: null, nextAction: null, closureReason: state.status === 'closed' ? 'answered' : null });
  }
  if (input.project) state.projectId = input.project;
  const at = `now() - interval '${input.minutesAgo ?? 60} minutes'`;
  await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,
      workflow_state,client_user_id,contact_id,project_id,project_display_name,project_client_visible,created_at,client_updated_at,internal_updated_at,closed_at)
    values ($1,'workspace-a',$1,'Request '||$1,'Description','Client',$2,$3,0,$4,$5,$6,$7,$8,$9,${at},${at},${at},
      case when $3 in ('closed','declined','cancelled') then ${at} else null end)`,
  [input.id, input.client ? 'authenticated_client' : 'public_inquiry', state.status, JSON.stringify(state), input.client,
    input.contact, input.project ?? null, input.project ? `Project ${input.project}` : null, input.visible ?? Boolean(input.project)]);
  if (input.client) {
    await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active) values ('workspace-a',$1,$2,$3)`,
      [input.id, input.client, input.grant ?? true]);
  }
}

beforeAll(async () => {
  pg = await createTestDatabase();
  db = { ...sqlFor(pg), transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
  service = createTicketQueueService(new PostgresTicketQueueStore(db));
}, 60000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.exec('truncate public.workspaces cascade');
  await pg.exec('delete from alpha_private.ticket_client_sessions');
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json) values ('workspace-a','A','a','active','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values ('member','workspace-a','pm','pm')`);
  await db.query(`insert into public.projects(id,workspace_id,name,key,status) values
    ('gh-repo-1','workspace-a','Resort Website','R','active'),('gh-repo-2','workspace-a','Booking System','B','active')`);
  await db.query(`insert into alpha_private.ticket_contacts(id,workspace_id,full_name,company,email_verified) values
    ('contact-a','workspace-a','Ana Cruz','Resort Co',true),
    ('contact-b','workspace-a','Ben Unverified',null,false),
    ('contact-u','workspace-a','Walk In',null,false)`);
  await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,write_mode) values
    ('grant-a','workspace-a','client-a','active','Client portal','enabled'),
    ('grant-b','workspace-a','client-b','revoked','Ben Co','enabled')`);
  await db.query(`update alpha_private.ticket_service_grants set revoked_at = now() where id = 'grant-b'`);
  await db.query(`insert into alpha_private.ticket_client_sessions(session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
    values ($1,'client-a',$2,now()-interval '1 minute',now()+interval '1 day')`, ['a'.repeat(64), 'c'.repeat(64)]);

  // Ana: a shared project with a published preview, a request with no project,
  // and a request on another project whose ticket grant was revoked.
  await ticket({ id: 't-a1', client: 'client-a', contact: 'contact-a', project: 'gh-repo-1', minutesAgo: 5 });
  await ticket({ id: 't-a2', client: 'client-a', contact: 'contact-a' });
  await ticket({ id: 't-a3', client: 'client-a', contact: 'contact-a', project: 'gh-repo-2', grant: false });
  await db.query(`insert into alpha_private.client_uat_rounds(workspace_id,project_id,client_user_id,id,number,title,status,build,build_key,
      reviewed_by,reviewed_at,reviewed_build_key,created_by,published_at)
    values ('workspace-a','gh-repo-1','client-a','round-1',1,'First look','published',
      '{"frontend":{"branch":"uat","repository":"org/repo","url":"https://demo.vercel.app/path"}}','key','pm',now(),'key','pm',now())`);
  // Ben: account switched off, one finished request.
  await ticket({ id: 't-b1', client: 'client-b', contact: 'contact-b', status: 'closed', minutesAgo: 10 });
  // An inquiry from someone with no account yet.
  await ticket({ id: 't-u1', client: null, contact: 'contact-u' });
});

describe('PM clients on the complete migration schema', () => {
  it('lists client accounts only, needing the PM first, with counts, access and projects', async () => {
    const clients = await service.listClients('workspace-a', pm);
    expect(clients.map(client => client.key)).toEqual(['client:client-a', 'client:client-b']);
    expect(clients[0]).toMatchObject({
      displayName: 'Ana Cruz', company: 'Resort Co', access: 'active',
      tickets: { needsPm: 3, waitingClient: 0, open: 3, closed: 0, unlinkedOpen: 1, accessRevoked: 1 },
      projects: [{ projectId: 'gh-repo-1', name: 'Resort Website', previewPublished: true }],
    });
    // Unverified contact and a revoked account: named from the service grant, shown as inactive.
    expect(clients[1]).toMatchObject({
      displayName: 'Ben Co', company: null, access: 'inactive',
      tickets: { needsPm: 0, open: 0, closed: 1, unlinkedOpen: 0, accessRevoked: 0 }, projects: [],
    });
  });

  it('shows the PM exactly the projects the client portal shows that client', async () => {
    const portal = await new PostgresClientProjectPortal(db).projects(clientA);
    const [ana] = await service.listClients('workspace-a', pm);
    expect(ana.projects.map(project => project.projectId)).toEqual(portal.items.map(project => project.projectId));
  });

  it('agrees with the queue counters for the same client', async () => {
    const [ana, ben] = await service.listClients('workspace-a', pm);
    for (const client of [ana, ben]) {
      const page = await service.list('workspace-a', pm, { clientGroupKey: client.key });
      expect(page.counters).toMatchObject({ kind: 'pm', needsPm: client.tickets.needsPm, waitingClient: client.tickets.waitingClient });
    }
    const all = await service.list('workspace-a', pm, {});
    // The unfiltered queue still counts everyone, including the unverified inquiry.
    expect(all.counters).toMatchObject({ kind: 'pm', needsPm: 4 });
  });

  it('names clients the same way in the list, the filter and the queue', async () => {
    const [clients, groups, page] = await Promise.all([
      service.listClients('workspace-a', pm), service.listClientGroups('workspace-a', pm), service.list('workspace-a', pm, {}),
    ]);
    const names = new Map(groups.map(group => [group.key, group.displayName]));
    for (const client of clients) expect(names.get(client.key)).toBe(client.displayName);
    expect(names.get('ticket:t-u1')).toBe('Walk In');
    for (const item of page.items) {
      const group = (item as { internal?: { clientGroup?: { key: string; displayName: string } } }).internal?.clientGroup;
      if (group) expect(names.get(group.key)).toBe(group.displayName);
    }
  });

  it('refuses the list to a client', async () => {
    await expect(service.listClients('workspace-a', clientA)).rejects.toMatchObject({ status: 403 });
  });
});
