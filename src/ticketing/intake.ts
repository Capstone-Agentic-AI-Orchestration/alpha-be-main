import { z } from 'zod';
import { TicketWorkflowError } from './workflow.js';

const id = z.string().min(1).max(200).refine(value => value.trim() === value);
const title = z.string().trim().min(1).max(160);
const description = z.string().trim().min(1).max(6000);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export function isTicketRequestedDeadline(value: unknown): value is string { return calendarDate.safeParse(value).success; }
const preference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_sure') }).strict(),
  z.object({ kind: z.literal('new_project') }).strict(),
  z.object({ kind: z.literal('shared_project'), optionId: id }).strict(),
]);
const createSchema = z.object({
  schemaVersion: z.literal(1), operationId: id, title, description,
  relatedTicketId: id.nullable().default(null),
  projectPreference: preference.default({ kind: 'not_sure' }),
  requestedDeadline: calendarDate.nullable().default(null),
}).strict();
export type TicketCreateInput = z.infer<typeof createSchema>;
const contactFields = {
  fullName: z.string().trim().min(1).max(160),
  email: z.string().trim().max(254).email(),
  company: z.string().trim().min(1).max(160).nullable().default(null),
};
export function isTicketInquiryContact(value: unknown): boolean { return z.object(contactFields).safeParse(value).success; }

/** Public contact is unverified. This contract is not a public route or proof of
 * anti-abuse/email ownership; those must precede the future intake write.
 */
const inquirySchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().uuid(),
  ...contactFields,
  title, description,
  requestedDeadline: calendarDate.nullable().default(null),
}).strict();
export type PublicTicketInquiryInput = z.infer<typeof inquirySchema>;
export function parseTicketCreate(input: unknown): TicketCreateInput {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new TicketWorkflowError(400, 'invalid_ticket_intake', 'This ticket request is invalid.');
  return parsed.data;
}
export function parsePublicTicketInquiry(input: unknown): PublicTicketInquiryInput {
  const parsed = inquirySchema.safeParse(input);
  if (!parsed.success) throw new TicketWorkflowError(400, 'invalid_ticket_intake', 'This ticket request is invalid.');
  return parsed.data;
}
