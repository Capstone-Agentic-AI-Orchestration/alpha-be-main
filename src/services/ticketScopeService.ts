import { randomUUID } from 'node:crypto';

import type { TicketOperationKey, TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketScopeProposalReceipt, TicketScopeStore } from '../store/ticketScopeStore.js';
import { parseTicketScopeProposal } from '../ticketing/scopeProposal.js';
import { assertTicketCommandAccess, decideTicketCommand, TicketWorkflowError } from '../ticketing/workflow.js';
import { authorizeTicketAccess } from './ticketAccess.js';
import { ticketOperationConflict, ticketOperationFingerprint, ticketOperationKey } from './ticketOperations.js';

const opaque = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value;

function sameKey(left: TicketOperationKey, right: TicketOperationKey): boolean {
  return left.workspaceId === right.workspaceId
    && left.ticketId === right.ticketId
    && left.actorKind === right.actorKind
    && left.actorId === right.actorId
    && left.operationId === right.operationId;
}

function validReceipt(value: TicketScopeProposalReceipt, ticketId: string, operationId: string): boolean {
  return value?.ticketId === ticketId && value.operationId === operationId
    && opaque(value.scopeVersionId) && Number.isSafeInteger(value.version) && value.version > 0
    && value.status === 'awaiting_client';
}

/** Creates one immutable, client-visible scope version and proposes it atomically. */
export function createTicketScopeService(
  store: TicketScopeStore,
  now: () => Date = () => new Date(),
  nextId: () => string = randomUUID,
) {
  return {
    async propose(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketScopeProposalReceipt> {
      return store.transaction(async tx => {
        const ticket = await authorizeTicketAccess(tx, target, subject);
        if (ticket.actor.kind !== 'pm') {
          throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot propose ticket scope.');
        }
        const parsed = parseTicketScopeProposal(input);
        const key = ticketOperationKey(ticket, parsed.operationId);
        const fingerprint = ticketOperationFingerprint('command', { type: 'scope_proposal', input: parsed });
        const saved = await tx.findScopeProposal(key);
        if (saved) {
          if (!sameKey(saved.key, key) || !/^[a-f0-9]{64}$/.test(saved.fingerprint)
            || !validReceipt(saved.receipt, ticket.state.id, parsed.operationId)) {
            throw new Error('Ticket scope operation store returned an invalid outcome.');
          }
          if (saved.fingerprint !== fingerprint) ticketOperationConflict();
          return { ...saved.receipt };
        }
        // Prevent an operation ID already used by a different PM ticket action
        // from being repurposed as a scope proposal.
        if (await tx.findOperation(key)) ticketOperationConflict();

        const occurredAt = now().toISOString();
        const scopeVersionId = nextId();
        if (!opaque(scopeVersionId) || !Number.isFinite(Date.parse(occurredAt))) {
          throw new Error('The server could not prepare this scope proposal.');
        }
        const envelope = {
          schemaVersion: 1 as const,
          operationId: parsed.operationId,
          expectedVersion: parsed.expectedVersion,
          command: { type: 'propose_scope' as const, scopeVersionId },
        };
        assertTicketCommandAccess(ticket.state, ticket.actor, envelope.command, ticket.mode ?? 'disabled');

        // The store must return this exact just-inserted version from loadFacts;
        // all writes below share one transaction and roll back together.
        await tx.insertScopeVersion({
          workspaceId: ticket.state.workspaceId,
          ticketId: ticket.state.id,
          id: scopeVersionId,
          publicSummary: parsed.publicSummary,
          developerBrief: parsed.developerBrief,
          proposedAt: occurredAt,
          proposedByPmId: ticket.actor.userId,
          immutable: true,
          clientVisible: true,
        });
        const facts = await tx.loadFacts(ticket, envelope);
        const decision = decideTicketCommand(ticket.state, ticket.actor, envelope, facts, ticket.mode ?? 'disabled');
        if (!await tx.saveWorkflow(target, ticket.state.version, decision.state)) {
          throw new TicketWorkflowError(409, 'ticket_version_conflict', 'The ticket changed. Refresh before proposing scope.');
        }

        const receipt: TicketScopeProposalReceipt = {
          ticketId: decision.state.id,
          operationId: parsed.operationId,
          version: decision.state.version,
          status: decision.state.status,
          scopeVersionId,
        };
        const commandReceipt = {
          ticketId: receipt.ticketId, operationId: receipt.operationId,
          version: receipt.version, status: receipt.status,
        };
        const operationFingerprint = ticketOperationFingerprint('command', envelope);
        await tx.appendAudit({ key, occurredAt, envelope, event: decision.event, reopenIssueIds: decision.reopenIssueIds });
        await tx.enqueueChange({ key, type: 'ticket_changed', version: receipt.version, occurredAt });
        await tx.insertOperation({ kind: 'command', key, fingerprint: operationFingerprint, receipt: commandReceipt });
        await tx.insertScopeProposal({ key, fingerprint, receipt });
        return { ...receipt };
      });
    },
  };
}
