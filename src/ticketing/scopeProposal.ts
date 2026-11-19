import { z } from 'zod';
import { TicketWorkflowError } from './workflow.js';

const id = z.string().min(1).max(200).refine(value => value.trim() === value);
const proposalSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: id,
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  publicSummary: z.string().trim().min(1).max(4000),
  developerBrief: z.string().trim().min(1).max(12000),
  /** 'skipped' lets the PM start without waiting for the client's approval. */
  clientApproval: z.enum(['required', 'skipped']).optional(),
}).strict();

export type TicketScopeProposalInput = z.infer<typeof proposalSchema>;

export function parseTicketScopeProposal(input: unknown): TicketScopeProposalInput {
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) {
    throw new TicketWorkflowError(400, 'invalid_ticket_scope', 'This scope proposal is invalid.');
  }
  return parsed.data;
}
