import { describe, expect, it, vi } from 'vitest';

import type { TicketScopeStore, TicketScopeVersionRecord } from '../store/ticketScopeStore.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import { newTicketWorkflow } from '../ticketing/workflow.js';
import { createTicketScopeService } from './ticketScopeService.js';

const target: TicketTarget = { workspaceId: 'workspace-1', ticketId: 'ticket-1' };
const pm: TicketSubject = { kind: 'internal', userId: 'pm-1', authentication: { kind: 'session', sessionId: 'pm-session' } };
const input = {
  schemaVersion: 1 as const, operationId: 'scope-operation-1', expectedVersion: 4,
  publicSummary: 'Build the agreed project dashboard.',
  developerBrief: 'Internal plan: use the existing project and preserve its deployment configuration.',
};

function fixture(canSave = true) {
  const state = {
    ...newTicketWorkflow(target.ticketId, target.workspaceId, 'client-1'),
    version: 4, status: 'under_review' as const, actionOwner: 'pm' as const, nextAction: 'reply' as const,
  };
  const actor = {
    kind: 'pm' as const, userId: pm.userId, workspaceId: target.workspaceId,
    membershipActive: true, canManageTickets: true,
  };
  const versions = new Map<string, TicketScopeVersionRecord>();
  const proposals = new Map<string, any>();
  const operations = new Map<string, any>();
  const audits: unknown[] = [];
  const signals: unknown[] = [];
  const tx = {
    lockAuthorizedTicket: vi.fn(async () => ({ state: structuredClone(state), actor, mode: 'enabled' as const })),
    findScopeProposal: vi.fn(async (key: unknown) => proposals.get(JSON.stringify(key)) ?? null),
    findOperation: vi.fn(async (key: unknown) => operations.get(JSON.stringify(key)) ?? null),
    insertScopeVersion: vi.fn(async (version: TicketScopeVersionRecord) => { versions.set(version.id, structuredClone(version)); }),
    loadFacts: vi.fn(async (_ticket: unknown, command: any) => {
      const version = versions.get(command.command.scopeVersionId);
      return {
        clientAccessActive: true,
        scope: version ? { id: version.id, ticketId: version.ticketId, workspaceId: version.workspaceId } : undefined,
      };
    }),
    saveWorkflow: vi.fn(async (_target: unknown, expectedVersion: number, next: typeof state) => {
      if (!canSave || expectedVersion !== state.version) return false;
      Object.assign(state, structuredClone(next));
      return true;
    }),
    appendAudit: vi.fn(async (audit: unknown) => { audits.push(structuredClone(audit)); }),
    enqueueChange: vi.fn(async (signal: unknown) => { signals.push(structuredClone(signal)); }),
    insertOperation: vi.fn(async (operation: any) => { operations.set(JSON.stringify(operation.key), structuredClone(operation)); }),
    insertScopeProposal: vi.fn(async (proposal: any) => { proposals.set(JSON.stringify(proposal.key), structuredClone(proposal)); }),
  };
  const store = { transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as TicketScopeStore;
  const service = createTicketScopeService(store, () => new Date('2026-10-08T12:00:00.000Z'), () => 'scope-version-1');
  return { service, tx, state, versions, proposals, operations, audits, signals };
}

describe('PM scope proposal application service', () => {
  it('creates a new immutable scope and keeps the developer brief out of the client receipt and events', async () => {
    const f = fixture();

    const receipt = await f.service.propose(target, pm, input);

    expect(receipt).toEqual({
      ticketId: target.ticketId, operationId: input.operationId, version: 5,
      status: 'awaiting_client', scopeVersionId: 'scope-version-1',
    });
    expect(f.state).toMatchObject({ scopeVersionId: receipt.scopeVersionId, status: 'awaiting_client', actionOwner: 'client', nextAction: 'agree_scope' });
    expect(f.versions.get(receipt.scopeVersionId)).toEqual({
      workspaceId: target.workspaceId, ticketId: target.ticketId, id: receipt.scopeVersionId,
      publicSummary: input.publicSummary, developerBrief: input.developerBrief,
      proposedAt: '2026-10-08T12:00:00.000Z', proposedByPmId: pm.userId,
      immutable: true, clientVisible: true,
    });
    expect(JSON.stringify({ receipt, audits: f.audits, signals: f.signals }))
      .not.toContain(input.developerBrief);
    expect(f.audits).toHaveLength(1);
    expect(f.signals).toEqual([expect.objectContaining({ type: 'ticket_changed', version: 5 })]);
  });

  it('returns the saved outcome for an exact retry without adding a second scope version', async () => {
    const f = fixture();
    const first = await f.service.propose(target, pm, input);

    await expect(f.service.propose(target, pm, input)).resolves.toEqual(first);

    expect(f.versions.size).toBe(1);
    expect(f.audits).toHaveLength(1);
    expect(f.signals).toHaveLength(1);
    expect(f.tx.insertScopeVersion).toHaveBeenCalledTimes(1);
  });

  it('refuses reuse of an operation ID with a different scope payload', async () => {
    const f = fixture();
    await f.service.propose(target, pm, input);

    await expect(f.service.propose(target, pm, { ...input, developerBrief: 'A different private instruction.' }))
      .rejects.toMatchObject({ status: 409, code: 'ticket_operation_conflict' });

    expect(f.versions.size).toBe(1);
    expect(f.audits).toHaveLength(1);
    expect(f.signals).toHaveLength(1);
  });

  it('does not report a proposal committed when the workflow compare-and-set loses', async () => {
    const f = fixture(false);

    await expect(f.service.propose(target, pm, input))
      .rejects.toMatchObject({ status: 409, code: 'ticket_version_conflict' });

    expect(f.tx.appendAudit).not.toHaveBeenCalled();
    expect(f.tx.enqueueChange).not.toHaveBeenCalled();
    expect(f.tx.insertOperation).not.toHaveBeenCalled();
    expect(f.tx.insertScopeProposal).not.toHaveBeenCalled();
  });
});
