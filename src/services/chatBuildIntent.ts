import { BUILD_INTENT_PROMPT, buildIntentJsonSchema, parseBuildIntent } from './chatBuildDecision.js';
import { defaultAssistantCandidates } from './defaultAssistant.js';
import { resolveAgent } from './personaService.js';
import { runCliTurn } from './cliRunner.js';
import { sqliteService } from './sqliteService.js';
import { runWithWorkspace } from './workspaceContext.js';

/** A fresh, bounded interpretation turn. No repository, attachments, tools or resumed session. */
export async function interpretBuildIntent(input: {
  workspaceId: string; threadId: string; runId: string; cwd: string;
  message: string; status: string; goal?: string; pendingCount: number;
  recentConversation: Array<{ role: string; content: string }>;
}) {
  const agents = runWithWorkspace(input.workspaceId, () => sqliteService.getAgents());
  const orchestrator = agents.find(agent => agent.templateKey === 'orchestrator' && !agent.isArchived);
  const settings = orchestrator ? resolveAgent(orchestrator, { includeMemory: false }) : undefined;
  const runtime = defaultAssistantCandidates(sqliteService.getRuntimes(), settings ? {
    provider: settings.modelProvider, modelName: settings.modelName,
    reasoningEffort: settings.reasoningEffort ?? null, agentName: orchestrator!.name
  } : undefined)[0];
  if (!runtime) throw new Error('No signed-in AI runtime can interpret this reply. Nothing was authorized.');
  const pendingTarget = input.status === 'awaiting_plan_approval' ? 'plan'
    : input.status === 'awaiting_approval' ? 'publication' : input.status === 'publishing' ? 'publication_retry' : 'none';
  const result = await runCliTurn({
    usageContext: { threadId: input.threadId }, runId: input.runId, cwd: input.cwd,
    provider: runtime.provider, modelName: runtime.modelName, codexBaseUrl: runtime.endpoint,
    mode: 'chat', approvalMode: 'ask', skills: [], mcpServers: [], projectRoots: [],
    autonomyLevel: 'Supervised', priorSession: null, timeoutMs: 60_000,
    responseSchema: buildIntentJsonSchema, toolFree: true, systemPrompt: BUILD_INTENT_PROMPT,
    prompt: JSON.stringify({ message: input.message, pendingStatus: input.status, pendingTarget,
      goal: input.goal?.slice(0, 2000), pendingCount: input.pendingCount,
      recentConversation: input.recentConversation })
  });
  if (result.cancelled) throw new Error('Interpretation was stopped. Nothing was authorized.');
  if (result.failureKind) throw new Error('The AI runtime could not interpret this reply. Nothing was authorized.');
  if (result.tools.some(tool => tool.toolName !== 'StructuredOutput')) throw new Error('The interpreter attempted an unexpected tool. Nothing was authorized.');
  const intent = parseBuildIntent(result.content, input.message);
  if (intent.intent === 'consent' && (intent.target !== pendingTarget || input.pendingCount !== 1)) {
    return { intent: 'clarify', target: 'none', evidence: '' } as const;
  }
  return intent;
}
