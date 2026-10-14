import { z } from 'zod';
import type { TicketSubject, TicketTarget, TicketOperationKey, SavedTicketOperation } from '../store/ticketCommandStore.js';
import type { TicketProjectManagementStore, TicketProjectLinkReceipt } from '../store/ticketProjectManagementStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { ticketOperationConflict, ticketOperationFingerprint } from './ticketOperations.js';

const id = z.string().min(1).max(200).refine(value => value.trim() === value);
const linkSchema = z.object({
  schemaVersion: z.literal(1), operationId: id,
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  projectId: id.nullable(), clientVisible: z.boolean(),
}).strict();

function sameKey(left: TicketOperationKey, right: TicketOperationKey): boolean {
  return left.workspaceId === right.workspaceId && left.ticketId === right.ticketId
    && left.actorKind === right.actorKind && left.actorId === right.actorId && left.operationId === right.operationId;
}
function receipt(value: SavedTicketOperation, key: TicketOperationKey, fingerprint: string): TicketProjectLinkReceipt {
  if (value.kind !== 'command' || !sameKey(value.key, key) || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || value.fingerprint !== fingerprint || value.receipt.ticketId !== key.ticketId
    || value.receipt.operationId !== key.operationId || !Number.isSafeInteger(value.receipt.version)
    || value.receipt.version < 0 || typeof value.receipt.status !== 'string') ticketOperationConflict();
  const savedLink = (value.receipt as typeof value.receipt & { projectId?: unknown; projectName?: unknown; clientVisible?: unknown });
  if ((savedLink.projectId !== null && typeof savedLink.projectId !== 'string')
    || (savedLink.projectName !== null && typeof savedLink.projectName !== 'string')
    || typeof savedLink.clientVisible !== 'boolean') throw new TicketReadInvariantError();
  return {
    ticketId: value.receipt.ticketId, operationId: value.receipt.operationId,
    version: value.receipt.version, status: value.receipt.status as TicketProjectLinkReceipt['status'],
    projectId: savedLink.projectId as string | null, projectName: savedLink.projectName as string | null,
    clientVisible: savedLink.clientVisible,
  };
}

export function createTicketProjectManagementService(
  store: TicketProjectManagementStore,
  now: () => Date = () => new Date(),
) {
  return {
    async linkProject(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketProjectLinkReceipt> {
      if (subject.kind !== 'internal') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'Only a project manager can link a project to a request.');
      const parsed = linkSchema.safeParse(input);
      if (!parsed.success || (parsed.data.projectId === null && parsed.data.clientVisible)) {
        throw new TicketWorkflowError(400, 'invalid_ticket_project_link', 'This project link is invalid.');
      }
      return store.transaction(async tx => {
        const ticket = await tx.lockAuthorizedTicket(target, subject);
        if (!ticket || ticket.actor.kind !== 'pm') throw new TicketWorkflowError(404, 'ticket_not_found', 'Ticket not found.');
        if (ticket.mode !== 'enabled' || ['closed', 'declined', 'cancelled'].includes(ticket.state.status)) {
          throw new TicketWorkflowError(503, 'ticket_writes_disabled', 'Ticket changes are unavailable right now.');
        }
        const key: TicketOperationKey = {
          workspaceId: ticket.state.workspaceId, ticketId: ticket.state.id,
          actorKind: 'pm', actorId: ticket.actor.userId, operationId: parsed.data.operationId,
        };
        const fingerprint = ticketOperationFingerprint('command', { type: 'ticket_project_link', input: parsed.data });
        const saved = await tx.findOperation(key);
        if (saved) return receipt(saved, key, fingerprint);
        if (ticket.state.version !== parsed.data.expectedVersion) {
          throw new TicketWorkflowError(409, 'ticket_version_conflict', 'The ticket changed. Refresh before linking a project.');
        }

        const current = await tx.loadCurrentProjectLink(target);
        let projectName: string | null = null;
        if (parsed.data.projectId !== null) {
          const project = await tx.findWorkspaceProject(target.workspaceId, parsed.data.projectId);
          if (!project) throw new TicketWorkflowError(404, 'ticket_project_not_found', 'Project not found in this workspace.');
          projectName = project.name;
        }
        if ((ticket.state.requiredIssueIds.length > 0 || ticket.state.authorizedScopeVersionId !== null)
          && current.projectId !== parsed.data.projectId) {
          throw new TicketWorkflowError(409, 'ticket_project_has_linked_work', 'This request already has approved work in its linked project. Its project link cannot be changed.');
        }
        const changed = current.projectId !== parsed.data.projectId
          || current.projectName !== projectName || current.clientVisible !== parsed.data.clientVisible;
        const occurredAt = now().toISOString();
        if (!Number.isFinite(Date.parse(occurredAt))) throw new Error('The server clock is invalid.');
        const state = changed ? { ...ticket.state, projectId: parsed.data.projectId, version: ticket.state.version + 1 } : ticket.state;
        if (changed && !await tx.saveProjectLink(target, ticket.state.version, state, projectName, parsed.data.clientVisible, occurredAt)) {
          throw new TicketWorkflowError(409, 'ticket_version_conflict', 'The ticket changed. Refresh before linking a project.');
        }
        const result: TicketProjectLinkReceipt = {
          ticketId: ticket.state.id, operationId: parsed.data.operationId, version: state.version,
          status: state.status, projectId: parsed.data.projectId, projectName, clientVisible: parsed.data.clientVisible,
        };
        const commandReceipt = { ...result };
        if (changed) {
          await tx.appendProjectLinkAudit({ key, occurredAt, previousProjectId: current.projectId,
            projectId: parsed.data.projectId, previousClientVisible: current.clientVisible,
            clientVisible: parsed.data.clientVisible, projectName });
          await tx.enqueueChange({ key, version: state.version, occurredAt });
        }
        await tx.insertOperation({ kind: 'command', key, fingerprint, receipt: commandReceipt });
        return result;
      });
    },

    async setClientRequestsEnabled(target: TicketTarget, subject: TicketSubject, input: unknown) {
      if (subject.kind !== 'internal') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'Only a project manager can change client request access.');
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input as object).some(key => key !== 'acceptsNewRequests')
        || typeof (input as Record<string, unknown>).acceptsNewRequests !== 'boolean') {
        throw new TicketWorkflowError(400, 'invalid_client_request_access', 'This client request setting is invalid.');
      }
      const enabled = (input as { acceptsNewRequests: boolean }).acceptsNewRequests;
      return store.transaction(async tx => ({
        ticketId: target.ticketId,
        acceptsNewRequests: await tx.setClientRequestsEnabled(target, subject, enabled),
      }));
    },
  };
}
