import { z } from 'zod';

export const chatBuildDecisionSchema = z.object({
  // Old clients may supply a hint. It is never authority to execute an action: the Orchestrator
  // decides from the person's words, and each action checks its own rules (chatActions.ts).
  action: z.enum(['start', 'approve', 'retry_publication']).optional(),
  runId: z.string().min(1).max(200),
  expectedRevision: z.number().int().nonnegative(),
  planVersion: z.number().int().nonnegative(),
  evidenceReady: z.boolean()
}).strict();
export type ChatBuildDecision = z.infer<typeof chatBuildDecisionSchema>;
