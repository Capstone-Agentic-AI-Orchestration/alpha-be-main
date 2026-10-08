import { randomUUID } from 'node:crypto';

import type { TicketMessageStore } from '../store/ticketMessageStore.js';
import type { TicketMessageReceipt, TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import { messageCommand, parseTicketNote, parseTicketReply } from '../ticketing/communication.js';
import { assertTicketCommandAccess, assertTicketWritable, decideTicketCommand, TicketWorkflowError } from '../ticketing/workflow.js';
import { authorizeTicketAccess } from './ticketAccess.js';
import { createTicketCommandService } from './ticketCommandService.js';
import { ticketOperationConflict, ticketOperationFingerprint, ticketOperationKey, ticketOperationReceipt } from './ticketOperations.js';

/** No runtime adapter or network side effects. Server generates message identity
 * and timestamps; callers supply only strict text/action/version/operation input.
 */
export function createTicketMessageService(
  store: TicketMessageStore, now: () => Date = () => new Date(), nextId: () => string = randomUUID,
) {
  async function write(target: TicketTarget, subject: TicketSubject, input: unknown, kind: 'message' | 'note'): Promise<TicketMessageReceipt> {
    return store.transaction(async tx => {
      const ticket = await authorizeTicketAccess(tx, target, subject);
      if (kind === 'note' && ticket.actor.kind !== 'pm') {
        throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'You cannot write internal ticket notes.');
      }
      const replyInput = kind === 'message' ? parseTicketReply(input) : null;
      const parsed = replyInput ?? parseTicketNote(input);
      const action = replyInput?.action ?? null;
      if (action) assertTicketCommandAccess(ticket.state, ticket.actor, messageCommand(action, parsed.operationId), ticket.mode ?? 'disabled');
      else if (ticket.mode !== 'enabled') throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
      const key = ticketOperationKey(ticket, parsed.operationId);
      const hash = ticketOperationFingerprint(kind, parsed);
      const saved = await tx.findOperation(key);
      if (saved) {
        if (saved.kind !== kind || saved.fingerprint !== hash) ticketOperationConflict();
        const result = ticketOperationReceipt(saved, key);
        if (!('messageId' in result)) throw new Error('Ticket operation store returned an invalid outcome.');
        return result;
      }
      assertTicketWritable(ticket.state, parsed.expectedVersion);
      const messageId = nextId();
      if (!messageId || messageId.length > 200 || messageId.trim() !== messageId) throw new Error('The server could not assign a message identity.');
      const occurredAt = now().toISOString();
      const audience = kind === 'message' ? 'client' : 'internal';
      // authorizeTicketAccess rejects developers, but keep the data boundary exact.
      if (ticket.actor.kind !== 'pm' && ticket.actor.kind !== 'client') throw new Error('Invalid ticket message author.');
      await tx.insertMessage({
        workspaceId: ticket.state.workspaceId, ticketId: ticket.state.id, id: messageId,
        authorId: ticket.actor.userId, authorKind: ticket.actor.kind, audience, body: parsed.body, createdAt: occurredAt,
      });
      let version = ticket.state.version;
      let status = ticket.state.status;
      if (action) {
        const envelope = {
          schemaVersion: 1 as const, operationId: parsed.operationId, expectedVersion: parsed.expectedVersion,
          command: messageCommand(action, messageId),
        };
        const facts = await tx.loadFacts(ticket, envelope);
        if (!ticket.state.clientId || !facts.clientAccessActive) {
          throw new TicketWorkflowError(409, 'client_access_inactive', 'The client must have active ticket access.');
        }
        const decision = decideTicketCommand(ticket.state, ticket.actor, envelope, facts, ticket.mode ?? 'disabled');
        if (decision.reopenIssueIds.length) throw new Error('A conversation cannot launch or reopen work.');
        if (!await tx.saveWorkflow(target, ticket.state.version, decision.state)) {
          throw new TicketWorkflowError(409, 'ticket_version_conflict', 'The ticket changed. Refresh before making this decision.');
        }
        version = decision.state.version; status = decision.state.status;
        await tx.appendAudit({ key, occurredAt, envelope, event: decision.event, reopenIssueIds: decision.reopenIssueIds });
        await tx.enqueueChange({ key, type: 'ticket_changed', version, occurredAt });
      } else {
        await tx.appendNoteAudit({ key, type: 'internal_note_added', messageId, occurredAt, workflowVersion: version });
      }
      if (!await tx.updateMessageClocks(target, version, audience, occurredAt)) {
        throw new TicketWorkflowError(409, 'ticket_version_conflict', 'The ticket changed. Refresh before making this decision.');
      }
      const result = { ticketId: ticket.state.id, operationId: parsed.operationId, messageId, version, status };
      await tx.insertOperation({ kind, key, fingerprint: hash, receipt: { ticketId: result.ticketId, operationId: result.operationId, version, status }, messageId });
      return { ...result };
    });
  }
  const commands = createTicketCommandService(store, now);
  return {
    reply: (target: TicketTarget, subject: TicketSubject, input: unknown) => write(target, subject, input, 'message'),
    note: (target: TicketTarget, subject: TicketSubject, input: unknown) => write(target, subject, input, 'note'),
    lookup: commands.lookup,
  };
}
