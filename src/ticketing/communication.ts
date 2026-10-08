import { z } from 'zod';

import { TicketWorkflowError, type TicketCommand } from './workflow.js';

const id = z.string().min(1).max(200).refine(value => value.trim() === value);
const base = {
  schemaVersion: z.literal(1), operationId: id,
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  body: z.string().trim().min(1).max(4000),
};
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reply') }).strict(),
  z.object({ type: z.literal('request_details') }).strict(),
  z.object({ type: z.literal('answer_close') }).strict(),
  z.object({ type: z.literal('request_correction'), deliveryId: id }).strict(),
]);
const replySchema = z.object({ ...base, action: action.default({ type: 'reply' }) }).strict();
const noteSchema = z.object(base).strict();
export type TicketReplyInput = z.infer<typeof replySchema>;
export type TicketNoteInput = z.infer<typeof noteSchema>;

export function parseTicketReply(input: unknown): TicketReplyInput {
  const parsed = replySchema.safeParse(input);
  if (!parsed.success) throw new TicketWorkflowError(400, 'invalid_ticket_message', 'This ticket message is invalid.');
  return parsed.data;
}
export function parseTicketNote(input: unknown): TicketNoteInput {
  const parsed = noteSchema.safeParse(input);
  if (!parsed.success) throw new TicketWorkflowError(400, 'invalid_ticket_message', 'This ticket message is invalid.');
  return parsed.data;
}
export function messageCommand(action: TicketReplyInput['action'], messageId: string): TicketCommand {
  return { ...action, messageId };
}
