import { z } from 'zod';

import type { TicketWorkflow } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';

const statuses = ['received', 'under_review', 'awaiting_client', 'in_progress', 'ready_for_review', 'on_hold', 'closed', 'declined', 'cancelled'] as const;
const actions = ['review_ticket', 'reply', 'agree_scope', 'authorize_work', 'execute_work', 'assess_result', 'share_result', 'review_result', 'close_ticket', 'triage_correction', 'handle_withdrawal', 'resolve_hold'] as const;
const actionOwners = ['pm', 'client', 'developer'] as const;

const deliverySchema = z.object({
  id: z.string(), scopeVersionId: z.string(), pinnedAssetId: z.string(),
  issueRevisionIds: z.array(z.string()), assessedByPmId: z.string(), shared: z.boolean(),
  acceptedByClientId: z.string().nullable(),
}).strict();

const workflowSchema = z.object({
  id: z.string(), workspaceId: z.string(), version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(statuses), clientId: z.string().nullable(), scopeVersionId: z.string().nullable(),
  agreedScopeVersionId: z.string().nullable(), authorizedScopeVersionId: z.string().nullable(),
  projectId: z.string().nullable(), requiredIssueIds: z.array(z.string()), delivery: deliverySchema.nullable(),
  correctionRequestedFor: z.string().nullable(), withdrawalRequested: z.boolean(),
  actionOwner: z.enum(actionOwners).nullable(), nextAction: z.enum(actions).nullable(),
  hold: z.object({ status: z.enum(statuses), actionOwner: z.enum(actionOwners).nullable(), nextAction: z.enum(actions).nullable() }).strict().nullable(),
  closureReason: z.enum(['accepted', 'answered', 'cancelled']).nullable(),
}).strict();

function invalid(): never { throw new TicketReadInvariantError(); }

/** Parse only the server-owned JSON representation; never return it wholesale. */
export function decodeTicketWorkflow(value: unknown): TicketWorkflow {
  let source = value;
  if (typeof value === 'string') {
    try { source = JSON.parse(value) as unknown; } catch { return invalid(); }
  }
  const parsed = workflowSchema.safeParse(source);
  if (!parsed.success) return invalid();
  return parsed.data;
}

/** Unknown or absent workspace config fails closed for ticket writes. */
export function ticketWriteMode(value: unknown): 'enabled' | 'disabled' | 'maintenance' {
  return value === 'enabled' || value === 'disabled' || value === 'maintenance' ? value : 'disabled';
}

export function ticketSqlIso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return invalid();
  return date.toISOString();
}
