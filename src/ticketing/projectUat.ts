import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TicketWorkflowError } from './workflow.js';

export const uatId = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().max(max);
export const uatItemSchema = z.object({
  title: text(300).min(1), steps: text(4000), expectedResult: text(4000).min(1), required: z.boolean(),
}).strict();
export const uatCreateSchema = z.object({
  operationId: uatId, clientId: uatId, repository: text(200).regex(/^[\w.-]+\/[\w.-]+$/),
  title: text(300).min(1), items: z.array(uatItemSchema).min(1).max(100),
}).strict();
export const uatCommandSchema = z.object({
  operationId: uatId, expectedVersion: z.number().int().nonnegative(),
  action: z.enum(['ready', 'publish', 'withdraw']),
}).strict();
export const uatResultSchema = z.object({
  operationId: uatId, expectedVersion: z.number().int().nonnegative(),
  status: z.enum(['not_tested', 'passed', 'failed', 'blocked']), notes: text(4000),
  reproduction: text(4000), device: text(100),
}).strict().superRefine((value, ctx) => {
  if (['failed', 'blocked'].includes(value.status) && !value.notes) ctx.addIssue({ code: 'custom', message: 'Describe the problem or blocker.', path: ['notes'] });
  if (value.status === 'failed' && !value.reproduction) ctx.addIssue({ code: 'custom', message: 'Add reproduction steps.', path: ['reproduction'] });
});
export const uatSubmitSchema = z.object({ operationId: uatId, expectedVersion: z.number().int().nonnegative() }).strict();
export type UatItemInput = z.infer<typeof uatItemSchema>;
export type UatResult = Omit<z.infer<typeof uatResultSchema>, 'operationId' | 'expectedVersion'>;
export interface UatBuildPart {
  repository: string; branch: 'uat'; deploymentId: string; commitSha: string; url: string;
}
export interface UatBuild {
  frontend: UatBuildPart; backends: UatBuildPart[]; verifiedAt: string; embeddable: boolean; reason: string | null;
}
export type UatLifecycle = 'draft' | 'published' | 'submitted' | 'withdrawn' | 'superseded';
export function uatError(status: 400|401|403|404|409|503, code: string, message: string): never { throw new TicketWorkflowError(status, code, message); }
export function parseUat<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) uatError(400, 'invalid_uat_input', parsed.error.issues[0]?.message ?? 'Check the review details.');
  return parsed.data;
}
export function buildKey(build: UatBuild): string {
  return createHash('sha256').update(JSON.stringify([build.frontend,
    [...build.backends].sort((a,b) => a.repository.localeCompare(b.repository))])).digest('hex');
}
export function uatOutcome(items: Array<{required: boolean; status: UatResult['status']}>): 'passed' | 'changes_requested' | 'blocked' {
  if (items.some(item => item.required && item.status === 'not_tested')) uatError(409, 'uat_incomplete', 'Test every required check before submitting.');
  if (items.some(item => item.status === 'failed')) return 'changes_requested';
  if (items.some(item => item.status === 'blocked')) return 'blocked';
  return 'passed';
}
