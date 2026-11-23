import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, sqlFor } from '../store/testDatabase.js';
import type { TransactionalSql } from '../store/database.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { PostgresClientProjectPortal } from './clientProjectPortal.js';
import { ClientProjectConversation } from './clientProjectConversation.js';
import { ClientProjectStages } from './clientProjectStages.js';

export const client: TicketSubject = { kind: 'client', userId: 'client-a', sessionId: 'a'.repeat(64) };
export const other: TicketSubject = { kind: 'client', userId: 'client-b', sessionId: 'b'.repeat(64) };
export const pm: TicketSubject = { kind: 'internal', userId: 'pm', authentication: { kind: 'verified_github_bearer', verificationId: 'verified' } };
const target = { workspaceId: 'workspace-a', projectId: 'project-a' };
let pg: PGlite;
let db: TransactionalSql;
let stages: ClientProjectStages;
let conversation: ClientProjectConversation;
let portal: PostgresClientProjectPortal;
let op = 0;
const cmd = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, operationId: `op-${++op}`, ...extra });
const draft = {
  title: 'Booking site', summary: 'A site where customers book a table.',
  features: [{ title: 'Online booking', detail: 'Pick a date and time' }, { title: 'Email confirmation', detail: '' }],
  screens: ['Home', 'Booking'], outOfScope: 'Payments', note: '',
};

async function ticket(id: string, user: string, project = 'project-a') {
  const state = { ...newTicketWorkflow(id, 'workspace-a', user), projectId: project, status: 'received' };
  await db.query(`insert into alpha_private.tickets(id,workspace_id,reference,title,description,client_safe_company_label,source,status,version,
    workflow_state,client_user_id,project_id,project_display_name,project_client_visible,created_at,client_updated_at,internal_updated_at)
    values ($1,'workspace-a',$1,'Request','Details','Client','authenticated_client','received',0,$2,$3,$4,'Project A',true,now(),now(),now())`,
  [id, JSON.stringify(state), user, project]);
  await db.query(`insert into alpha_private.ticket_client_grants(workspace_id,ticket_id,client_user_id,active) values ('workspace-a',$1,$2,true)`, [id, user]);
}

beforeAll(async () => {
  pg = await createTestDatabase();
  db = { ...sqlFor(pg), transaction: work => pg.transaction(tx => work(sqlFor(tx as unknown as PGlite))) };
  portal = new PostgresClientProjectPortal(db);
  stages = new ClientProjectStages(db, portal);
  conversation = new ClientProjectConversation(db, portal);
}, 60000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.exec('truncate public.workspaces cascade');
  await pg.exec('delete from alpha_private.ticket_client_sessions');
  await db.query(`insert into public.workspaces(id,name,slug,status,settings_json) values
    ('workspace-a','A','a','active','{"ticketing_write_mode":"enabled"}')`);
  await db.query(`insert into public.workspace_members(id,workspace_id,user_id,role) values ('member','workspace-a','pm','pm')`);
  await db.query(`insert into public.projects(id,workspace_id,name,key,status) values ('project-a','workspace-a','Project A','A','active')`);
  for (const [user, session] of [['client-a', 'a'.repeat(64)], ['client-b', 'b'.repeat(64)]]) {
    await db.query(`insert into alpha_private.ticket_service_grants(id,workspace_id,client_user_id,status,display_name,write_mode)
      values ($1,'workspace-a',$2,'active','Client '||$2,'enabled')`, [user, user]);
    await db.query(`insert into alpha_private.ticket_client_sessions(session_id_hash,client_user_id,csrf_hash,created_at,expires_at)
      values ($1,$2,$3,now()-interval '1 minute',now()+interval '1 day')`, [session, user, 'c'.repeat(64)]);
  }
  await ticket('t-1', 'client-a');
});

describe('project stages: POC', () => {
  it('starts a new conversation in the POC stage, waiting on the PM', async () => {
    const summary = await stages.summary(target, client);
    expect(summary).toMatchObject({ stage: 'poc', revisionLimit: 3, revisionsUsed: 0, poc: null, pocDraft: null,
      nextAction: { who: 'pm', kind: 'publish_poc' } });
    expect('clientId' in summary).toBe(false);
    expect((await stages.summary(target, pm, 'client-a')).clientId).toBe('client-a');
  });

  it('keeps drafts with the PM, publishes versions, and lets the client ask for changes any number of times', async () => {
    let summary = await stages.savePocDraft(target, pm, draft, 'client-a');
    expect(summary.pocDraft).toMatchObject({ number: 1, status: 'draft', title: 'Booking site' });
    expect((await stages.summary(target, client)).poc).toBeNull();
    expect((await stages.summary(target, client)).pocDraft).toBeNull();

    const v1 = summary.pocDraft!.id;
    const published = await stages.publishPoc(target, pm, v1, cmd(), 'client-a');
    expect(published.receipt).toMatchObject({ action: 'poc_published', refId: v1 });
    summary = await stages.summary(target, client);
    expect(summary.poc).toMatchObject({ id: v1, number: 1, status: 'published' });
    expect(summary.poc?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.nextAction).toMatchObject({ who: 'client', kind: 'review_poc' });

    for (let round = 0; round < 2; round += 1) {
      const current = (await stages.summary(target, client)).poc!;
      await stages.requestPocChanges(target, client, current.id, cmd({ body: `Change ${round}` }));
      const pmView = await stages.summary(target, pm, 'client-a');
      expect(pmView.poc).toMatchObject({ status: 'changes_requested', changeRequest: { body: `Change ${round}` } });
      expect(pmView.nextAction?.who).toBe('pm');
      const next = await stages.savePocDraft(target, pm, { ...draft, summary: `Revised ${round}` }, 'client-a');
      await stages.publishPoc(target, pm, next.pocDraft!.id, cmd(), 'client-a');
    }
    summary = await stages.summary(target, client);
    expect(summary.poc).toMatchObject({ number: 3, status: 'published', summary: 'Revised 1' });
    expect(summary.pocHistory.map(item => [item.number, item.status])).toEqual([[3, 'published'], [2, 'superseded'], [1, 'superseded']]);
  });

  it('approves exactly the version the client read, then moves to the contract stage', async () => {
    const saved = await stages.savePocDraft(target, pm, draft, 'client-a');
    await stages.publishPoc(target, pm, saved.pocDraft!.id, cmd(), 'client-a');
    const poc = (await stages.summary(target, client)).poc!;

    await expect(stages.approvePoc(target, client, poc.id, cmd({ contentHash: 'f'.repeat(64), fullName: 'Juan Dela Cruz', consent: true })))
      .rejects.toMatchObject({ code: 'poc_changed' });
    await expect(stages.approvePoc(target, client, poc.id, cmd({ contentHash: poc.contentHash, fullName: 'Juan Dela Cruz', consent: false })))
      .rejects.toMatchObject({ code: 'invalid_stage_input' });
    await expect(stages.approvePoc(target, pm, poc.id, cmd({ contentHash: poc.contentHash, fullName: 'PM', consent: true }), ))
      .rejects.toMatchObject({ code: 'stage_action_not_allowed' });

    const approval = cmd({ contentHash: poc.contentHash, fullName: 'Juan Dela Cruz', consent: true });
    const result = await stages.approvePoc(target, client, poc.id, approval);
    expect(result.stage).toMatchObject({ stage: 'contract', poc: { status: 'approved', approvedName: 'Juan Dela Cruz' },
      nextAction: { who: 'pm', kind: 'issue_contract' } });
    // A repeated request returns the same receipt; reusing its id for something else is refused.
    const replay = await stages.approvePoc(target, client, poc.id, approval);
    expect(replay.receipt).toEqual(result.receipt);
    await expect(stages.requestPocChanges(target, client, poc.id, { schemaVersion: 1, operationId: approval.operationId, body: 'x' }))
      .rejects.toMatchObject({ code: 'stage_operation_conflict' });
    expect((await stages.operation(target, client, approval.operationId)).receipt).toEqual(result.receipt);

    await expect(stages.savePocDraft(target, pm, draft, 'client-a')).rejects.toMatchObject({ code: 'stage_mismatch' });
    await expect(stages.requestPocChanges(target, client, poc.id, cmd({ body: 'Too late' }))).rejects.toMatchObject({ code: 'stage_mismatch' });
  });

  it('shows stage events in the project conversation for both sides', async () => {
    const saved = await stages.savePocDraft(target, pm, draft, 'client-a');
    await stages.publishPoc(target, pm, saved.pocDraft!.id, cmd(), 'client-a');
    await stages.requestPocChanges(target, client, saved.pocDraft!.id, cmd({ body: 'Add a menu page' }));
    const items = (await conversation.timeline(target, client)).items.filter(item => item.kind === 'stage_event');
    expect(items.map(item => [item.author, item.stage?.action, item.stage?.number, item.body])).toEqual([
      ['pm', 'poc_published', 1, ''], ['client', 'poc_changes_requested', 1, 'Add a menu page']]);
    expect((await conversation.timeline(target, pm, 'client-a')).items.some(item => item.stage?.action === 'poc_published')).toBe(true);
  });

  it('keeps each client’s stage to that client', async () => {
    await ticket('t-b', 'client-b');
    const saved = await stages.savePocDraft(target, pm, draft, 'client-a');
    await stages.publishPoc(target, pm, saved.pocDraft!.id, cmd(), 'client-a');
    expect((await stages.summary(target, other)).poc).toBeNull();
    await expect(stages.requestPocChanges(target, other, saved.pocDraft!.id, cmd({ body: 'Mine?' }))).rejects.toMatchObject({ code: 'stage_mismatch' });
    await expect(stages.summary({ ...target, projectId: 'project-x' }, client)).rejects.toMatchObject({ status: 404 });
    await expect(stages.summary(target, pm)).rejects.toMatchObject({ code: 'project_thread_client_required' });
  });

  it('refuses writes while ticket writes are off', async () => {
    await db.query(`update public.workspaces set settings_json='{"ticketing_write_mode":"disabled"}'`);
    await expect(stages.savePocDraft(target, pm, draft, 'client-a')).rejects.toMatchObject({ status: 503 });
  });

  it('lets the PM choose where a project that predates stages starts, once', async () => {
    await db.query(`insert into alpha_private.client_project_stages(workspace_id,project_id,client_user_id,stage)
      values ('workspace-a','project-a','client-a','unset')`);
    expect((await stages.summary(target, client)).nextAction).toMatchObject({ who: 'pm', kind: 'set_stage' });
    await expect(stages.setStartingStage(target, client, cmd({ stage: 'development' }))).rejects.toMatchObject({ code: 'stage_action_not_allowed' });
    const result = await stages.setStartingStage(target, pm, cmd({ stage: 'development', revisionsUsed: 2 }), 'client-a');
    expect(result.stage).toMatchObject({ stage: 'development', revisionsUsed: 2, revisionLimit: 3 });
    await expect(stages.setStartingStage(target, pm, cmd({ stage: 'poc' }), 'client-a')).rejects.toMatchObject({ code: 'stage_mismatch' });
  });

  it('puts the stage on the client’s project list', async () => {
    const { items } = await portal.projects(client);
    expect(items[0]?.stage).toMatchObject({ stage: 'poc', label: 'Proof of concept', waitingOn: 'pm' });
  });
});

/** A thread whose POC v1 is approved: the contract stage. */
export async function toContractStage() {
  const saved = await stages.savePocDraft(target, pm, draft, 'client-a');
  await stages.publishPoc(target, pm, saved.pocDraft!.id, cmd(), 'client-a');
  const poc = (await stages.summary(target, client)).poc!;
  await stages.approvePoc(target, client, poc.id, cmd({ contentHash: poc.contentHash, fullName: 'Juan Dela Cruz', consent: true }));
}

describe('project stages: contract', () => {
  it('drafts the contract from the approved POC and keeps the draft with the PM', async () => {
    await toContractStage();
    const summary = await stages.saveContractDraft(target, pm, {}, 'client-a');
    expect(summary.contract).toMatchObject({ status: 'draft', terms: { projectName: 'Project A', clientName: 'Client client-a',
      revisionLimit: 3, deliverables: ['Online booking', 'Email confirmation'], scope: { pocNumber: 1, title: 'Booking site' } } });
    expect(summary.contract?.terms.clauses).toHaveLength(5);
    expect((await stages.summary(target, client)).contract).toBeNull();
    const edited = await stages.saveContractDraft(target, pm, { notes: 'Launch before March.', deliverables: ['Booking site'] }, 'client-a');
    expect(edited.contract?.terms).toMatchObject({ notes: 'Launch before March.', deliverables: ['Booking site'], revisionLimit: 3 });
    await expect(stages.saveContractDraft(target, pm, { revisionLimit: 9 }, 'client-a')).rejects.toMatchObject({ code: 'invalid_stage_input' });
  });

  it('has the client sign exactly what was issued, then the PM countersigns and development starts', async () => {
    await toContractStage();
    const draftContract = (await stages.saveContractDraft(target, pm, {}, 'client-a')).contract!;
    await stages.issueContract(target, pm, draftContract.id, cmd(), 'client-a');
    const issued = (await stages.summary(target, client)).contract!;
    expect(issued).toMatchObject({ status: 'issued' });
    expect(issued.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await stages.summary(target, client)).nextAction).toMatchObject({ who: 'client', kind: 'sign_contract' });
    await expect(stages.saveContractDraft(target, pm, { notes: 'x' }, 'client-a')).rejects.toMatchObject({ code: 'stage_mismatch' });
    await expect(stages.countersignContract(target, pm, issued.id, cmd({ fullName: 'Pat PM' }), 'client-a')).rejects.toMatchObject({ code: 'stage_mismatch' });
    await expect(stages.signContract(target, client, issued.id, cmd({ contentHash: 'b'.repeat(64), fullName: 'Juan Dela Cruz', consent: true })))
      .rejects.toMatchObject({ code: 'contract_changed' });

    const signed = await stages.signContract(target, client, issued.id, cmd({ contentHash: issued.contentHash, fullName: 'Juan Dela Cruz', consent: true }));
    expect(signed.stage.contract).toMatchObject({ status: 'client_signed', clientSignedName: 'Juan Dela Cruz' });
    expect(signed.stage.nextAction).toMatchObject({ who: 'pm', kind: 'countersign_contract' });
    await expect(stages.voidContract(target, pm, issued.id, cmd(), 'client-a')).rejects.toMatchObject({ code: 'stage_mismatch' });

    const countersigned = await stages.countersignContract(target, pm, issued.id, cmd({ fullName: 'Pat PM' }), 'client-a');
    expect(countersigned.stage).toMatchObject({ stage: 'development', revisionsUsed: 0, contract: { status: 'countersigned', pmSignedName: 'Pat PM' },
      nextAction: { who: 'pm', kind: 'share_build' } });
    const actions = (await conversation.timeline(target, client)).items.filter(item => item.kind === 'stage_event').map(item => item.stage?.action);
    expect(actions).toEqual(['poc_published', 'poc_approved', 'contract_issued', 'contract_signed', 'contract_countersigned']);
  });

  it('lets the PM withdraw an unsigned contract and issue a corrected one', async () => {
    await toContractStage();
    const first = (await stages.saveContractDraft(target, pm, {}, 'client-a')).contract!;
    await stages.issueContract(target, pm, first.id, cmd(), 'client-a');
    const voided = await stages.voidContract(target, pm, first.id, cmd(), 'client-a');
    expect(voided.stage.contract).toBeNull();
    expect(voided.stage.nextAction).toMatchObject({ who: 'pm', kind: 'issue_contract' });
    const second = (await stages.saveContractDraft(target, pm, { notes: 'Corrected' }, 'client-a')).contract!;
    expect(second.id).not.toBe(first.id);
    await stages.issueContract(target, pm, second.id, cmd(), 'client-a');
    expect((await stages.summary(target, client)).contract).toMatchObject({ id: second.id, status: 'issued', terms: { notes: 'Corrected' } });
  });
});

/** A thread whose contract is countersigned: the development stage. */
async function toDevelopmentStage() {
  await toContractStage();
  const drafted = (await stages.saveContractDraft(target, pm, {}, 'client-a')).contract!;
  await stages.issueContract(target, pm, drafted.id, cmd(), 'client-a');
  const issued = (await stages.summary(target, client)).contract!;
  await stages.signContract(target, client, issued.id, cmd({ contentHash: issued.contentHash, fullName: 'Juan Dela Cruz', consent: true }));
  await stages.countersignContract(target, pm, issued.id, cmd({ fullName: 'Pat PM' }), 'client-a');
}

/** Share a build, send one round of notes, and label them; returns the round's summary entry. */
async function feedbackRound(notes: string[], labels: Array<'revision' | 'fix' | 'out_of_scope'>) {
  const shared = await stages.shareBuild(target, pm, cmd({ note: 'New build' }), 'client-a');
  const roundId = shared.receipt.refId!;
  const saved = await stages.saveRoundItems(target, client, roundId, { items: notes });
  const items = saved.rounds.find(round => round.id === roundId)!.items;
  await stages.submitRound(target, client, roundId, cmd());
  const classified = await stages.classifyRound(target, pm, roundId, cmd({ items: items.map((item, index) => ({ id: item.id, classification: labels[index] })) }), 'client-a');
  return classified.stage;
}

describe('project stages: development', () => {
  it('counts a round only when it holds a revision, and turns out-of-scope notes into change requests', async () => {
    await toDevelopmentStage();
    let summary = await feedbackRound(['The login button is broken'], ['fix']);
    expect(summary.revisionsUsed).toBe(0);
    summary = await feedbackRound(['Make the header blue', 'Add a loyalty program'], ['revision', 'out_of_scope']);
    expect(summary.revisionsUsed).toBe(1);
    expect(summary.rounds[0]).toMatchObject({ number: 2, status: 'classified', counts: true });
    expect(summary.quotes).toEqual([expect.objectContaining({ kind: 'change_request', status: 'requested', title: 'Add a loyalty program', requestedBy: 'pm' })]);
    expect(summary.nextAction).toMatchObject({ who: 'pm', kind: 'send_quote' });
  });

  it('asks for a quote once the included rounds are used', async () => {
    await toDevelopmentStage();
    for (let round = 0; round < 3; round += 1) await feedbackRound([`Change ${round}`], ['revision']);
    expect((await stages.summary(target, client)).revisionsUsed).toBe(3);

    const shared = await stages.shareBuild(target, pm, cmd({ note: 'Build 4' }), 'client-a');
    const roundId = shared.receipt.refId!;
    await stages.saveRoundItems(target, client, roundId, { items: ['One more change'] });
    await expect(stages.submitRound(target, client, roundId, cmd())).rejects.toMatchObject({ code: 'revision_limit_reached' });
    const paid = await stages.submitRound(target, client, roundId, cmd({ acceptPaid: true }));
    expect(paid.stage.rounds[0]).toMatchObject({ number: 4, status: 'awaiting_quote', paid: true });
    expect(paid.stage.quotes[0]).toMatchObject({ kind: 'paid_revision', status: 'requested', title: 'Revision round 4', amount: null });
    expect(paid.stage.revisionsUsed).toBe(3);
    expect(paid.stage.nextAction).toMatchObject({ who: 'pm', kind: 'send_quote' });
  });

  it('keeps one round open at a time and refuses empty or repeated sends', async () => {
    await toDevelopmentStage();
    const shared = await stages.shareBuild(target, pm, cmd({ note: '' }), 'client-a');
    expect(shared.stage.nextAction).toMatchObject({ who: 'client', kind: 'submit_round' });
    await expect(stages.shareBuild(target, pm, cmd({ note: '' }), 'client-a')).rejects.toMatchObject({ code: 'stage_mismatch' });
    await expect(stages.submitRound(target, client, shared.receipt.refId, cmd())).rejects.toMatchObject({ code: 'round_empty' });
    await stages.saveRoundItems(target, client, shared.receipt.refId!, { items: ['A'] });
    await stages.submitRound(target, client, shared.receipt.refId, cmd());
    await expect(stages.saveRoundItems(target, client, shared.receipt.refId!, { items: ['B'] })).rejects.toMatchObject({ code: 'stage_mismatch' });
    await expect(stages.classifyRound(target, pm, shared.receipt.refId, cmd({ items: [] }), 'client-a')).rejects.toMatchObject({ status: 400 });
  });

  it('closes the contract when the client accepts the final delivery', async () => {
    await toDevelopmentStage();
    await expect(stages.acceptFinal(target, client, cmd({ fullName: 'Juan Dela Cruz', consent: true }))).rejects.toMatchObject({ code: 'stage_mismatch' });
    const delivered = await stages.markFinalDelivery(target, pm, cmd({ note: 'All deliverables are live.' }), 'client-a');
    expect(delivered.stage).toMatchObject({ final: { note: 'All deliverables are live.', acceptedAt: null }, nextAction: { who: 'client', kind: 'accept_final' } });
    const accepted = await stages.acceptFinal(target, client, cmd({ fullName: 'Juan Dela Cruz', consent: true }));
    expect(accepted.stage).toMatchObject({ stage: 'completed', final: { acceptedName: 'Juan Dela Cruz' }, nextAction: null });
    await expect(stages.shareBuild(target, pm, cmd({ note: '' }), 'client-a')).rejects.toMatchObject({ code: 'stage_mismatch' });
  });

  it('takes back an unaccepted final delivery when the PM shares another build', async () => {
    await toDevelopmentStage();
    await stages.markFinalDelivery(target, pm, cmd({ note: 'Done?' }), 'client-a');
    const shared = await stages.shareBuild(target, pm, cmd({ note: 'One more fix' }), 'client-a');
    expect(shared.stage.final).toBeNull();
  });
});

describe('project stages: quotes', () => {
  it('prices a paid round; accepting the quote sends the round to the PM', async () => {
    await toDevelopmentStage();
    for (let round = 0; round < 3; round += 1) await feedbackRound([`Change ${round}`], ['revision']);
    const shared = await stages.shareBuild(target, pm, cmd({ note: 'Build 4' }), 'client-a');
    await stages.saveRoundItems(target, client, shared.receipt.refId!, { items: ['One more change'] });
    const paid = await stages.submitRound(target, client, shared.receipt.refId, cmd({ acceptPaid: true }));
    const quote = paid.stage.quotes[0]!;

    await expect(stages.decideQuote(target, client, quote.id, cmd({ decision: 'accept', fullName: 'Juan Dela Cruz', consent: true })))
      .rejects.toMatchObject({ code: 'stage_mismatch' });
    const sent = await stages.sendQuote(target, pm, quote.id, cmd({ amount: 2500, currency: 'PHP' }), 'client-a');
    expect(sent.stage.quotes[0]).toMatchObject({ status: 'sent', amount: '2500.00', currency: 'PHP' });
    expect(sent.stage.nextAction).toMatchObject({ who: 'client', kind: 'decide_quote' });
    await expect(stages.decideQuote(target, client, quote.id, cmd({ decision: 'accept' }))).rejects.toMatchObject({ code: 'invalid_stage_input' });

    const accepted = await stages.decideQuote(target, client, quote.id, cmd({ decision: 'accept', fullName: 'Juan Dela Cruz', consent: true }));
    expect(accepted.stage.quotes[0]).toMatchObject({ status: 'accepted', decidedName: 'Juan Dela Cruz' });
    expect(accepted.stage.rounds[0]).toMatchObject({ number: 4, status: 'submitted', paid: true });
    expect(accepted.stage.nextAction).toMatchObject({ who: 'pm', kind: 'classify_round' });
    const items = accepted.stage.rounds[0]!.items;
    const classified = await stages.classifyRound(target, pm, accepted.stage.rounds[0]!.id, cmd({ items: items.map(item => ({ id: item.id, classification: 'revision' })) }), 'client-a');
    expect(classified.stage.revisionsUsed).toBe(3);
  });

  it('reopens a paid round when its quote is declined', async () => {
    await toDevelopmentStage();
    await db.query(`update alpha_private.client_project_stages set revision_limit=0`);
    const shared = await stages.shareBuild(target, pm, cmd({ note: '' }), 'client-a');
    await stages.saveRoundItems(target, client, shared.receipt.refId!, { items: ['Paid change'] });
    const paid = await stages.submitRound(target, client, shared.receipt.refId, cmd({ acceptPaid: true }));
    await stages.sendQuote(target, pm, paid.stage.quotes[0]!.id, cmd({ amount: 900 }), 'client-a');
    const declined = await stages.decideQuote(target, client, paid.stage.quotes[0]!.id, cmd({ decision: 'decline' }));
    expect(declined.stage.quotes[0]).toMatchObject({ status: 'declined', decidedName: null });
    expect(declined.stage.rounds[0]).toMatchObject({ status: 'open', paid: false, quoteId: null, submittedAt: null });
  });

  it('lets the client ask for new work after closure, quoted before anything starts', async () => {
    await toDevelopmentStage();
    await stages.markFinalDelivery(target, pm, cmd({ note: '' }), 'client-a');
    await stages.acceptFinal(target, client, cmd({ fullName: 'Juan Dela Cruz', consent: true }));
    const asked = await stages.requestChange(target, client, cmd({ title: 'Add a gift card page', description: 'For the holidays.' }));
    expect(asked.stage).toMatchObject({ stage: 'completed', nextAction: { who: 'pm', kind: 'send_quote' },
      quotes: [expect.objectContaining({ kind: 'change_request', title: 'Add a gift card page', requestedBy: 'client', amount: null })] });
    await stages.sendQuote(target, pm, asked.receipt.refId, cmd({ amount: 12000, description: 'Design and build, 1 week.' }), 'client-a');
    const accepted = await stages.decideQuote(target, client, asked.receipt.refId, cmd({ decision: 'accept', fullName: 'Juan Dela Cruz', consent: true }));
    expect(accepted.stage).toMatchObject({ stage: 'completed', nextAction: null,
      quotes: [expect.objectContaining({ status: 'accepted', amount: '12000.00', description: 'Design and build, 1 week.' })] });
    const timeline = (await conversation.timeline(target, client)).items.filter(item => item.stage?.action === 'quote_requested');
    expect(timeline[0]?.body).toBe('Add a gift card page\n\nFor the holidays.');
  });

  it('refuses change requests before development', async () => {
    await expect(stages.requestChange(target, client, cmd({ title: 'Too early' }))).rejects.toMatchObject({ code: 'stage_mismatch' });
  });
});
