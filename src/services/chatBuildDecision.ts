import { z } from 'zod';

export const chatBuildDecisionSchema = z.object({
  action: z.enum(['start', 'approve', 'retry_publication']),
  runId: z.string().min(1).max(200),
  expectedRevision: z.number().int().nonnegative(),
  planVersion: z.number().int().nonnegative(),
  evidenceReady: z.boolean()
}).strict();
export type ChatBuildDecision = z.infer<typeof chatBuildDecisionSchema>;

/** Only a standalone human reply is consent; never infer it from model output or documents. */
export function buildDecisionAction(content: string): ChatBuildDecision['action'] | undefined {
  const text = content.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(?:please )?(?:start(?: it| the (?:plan|build|planned work))?|go ahead(?: with (?:this|the) plan)?|continue|proceed)$/.test(text)) return 'start';
  if (/^(?:please )?(?:approve|approve (?:publication|the (?:publication|pull request))|publish (?:it|this build)|push and open (?:the |a )?pull request)$/.test(text)) return 'approve';
  if (/^(?:please )?retry publication$/.test(text)) return 'retry_publication';
  return undefined;
}
