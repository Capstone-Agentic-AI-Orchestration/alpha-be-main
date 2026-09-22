import { Request, Response, Router } from 'express';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AgentCallMode, AgentCallTarget, AgentCallTargetType, ChatMessage } from '../models/index.js';
import { sqliteService } from '../services/sqliteService.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { agentCallService } from '../services/agentCallService.js';
import { agentReadiness } from '../services/agentReadiness.js';
import { resolveProjectWorkspace } from '../services/workspaceService.js';
import { projectStore } from '../store/stores.js';
import { route } from './asyncRoute.js';
import { requireEntityWorkspace, requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';

const execFileAsync = promisify(execFile);
const MODES = new Set<AgentCallMode>(['ask', 'review', 'revise', 'implement']);
const TARGET_TYPES = new Set<AgentCallTargetType>([
  'message',
  'agent_response',
  'issue',
  'specification',
  'file',
  'code',
  'branch',
  'commit',
  'pull_request',
  'diff'
]);

export const agentCallRouter = Router();

function roleModes(req: Request): AgentCallMode[] {
  return req.workspace?.role === 'pm' ? ['ask', 'review'] : ['ask', 'review', 'revise', 'implement'];
}

async function getProject(req: Request, res: Response, projectId: string) {
  if (!requireProjectWorkspace(req, res, projectId)) return null;
  const project = await projectStore().get(req.workspace!.workspaceId, projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found in the active workspace.' });
    return null;
  }
  return project;
}

function safeTarget(value: unknown): AgentCallTarget | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object') throw new Error('target must be an object.');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== 'string' || !TARGET_TYPES.has(candidate.type as AgentCallTargetType)) {
    throw new Error('target.type is not supported.');
  }
  if (typeof candidate.id !== 'string' || !candidate.id.trim() || candidate.id.length > 500) {
    throw new Error('target.id is required and must be at most 500 characters.');
  }
  if (candidate.type === 'file') {
    const id = candidate.id;
    // Repository-relative paths are allowed to contain forward slashes, but
    // no caller can use this field to escape the project working copy.
    if (
      id.includes('\0') ||
      id.includes('\\') ||
      id.startsWith('/') ||
      /^[A-Za-z]:/.test(id) ||
      id.split('/').some(part => part === '..')
    ) {
      throw new Error('File targets must be repository-relative paths.');
    }
  }
  return {
    type: candidate.type as AgentCallTargetType,
    id: candidate.id.trim(),
    label: typeof candidate.label === 'string' ? candidate.label.slice(0, 300) : undefined
  };
}

function getCallForCaller(req: Request, res: Response, id: string) {
  const call = sqliteService.getAgentCall(id);
  if (!call || !req.workspace || call.workspaceId !== req.workspace.workspaceId) {
    res.status(404).json({ error: 'Agent call not found in the active workspace.' });
    return null;
  }
  if (!requireProjectWorkspace(req, res, call.projectId)) return null;
  return call;
}

function requireCurrentProjectAgent(req: Request, res: Response, call: NonNullable<ReturnType<typeof sqliteService.getAgentCall>>): boolean {
  if (!req.workspace || !workspaceRegistry.canAccessProjectAgent(req.workspace, call.projectId, call.squadId, call.agentId)) {
    res.status(404).json({ error: 'The selected agent is no longer available for this project.' });
    return false;
  }
  return true;
}

function responseForCall(call: ReturnType<typeof sqliteService.getAgentCall>) {
  if (!call?.resultMessageId) return undefined;
  return sqliteService.getChatMessages(call.threadId).find(message => message.id === call.resultMessageId);
}

async function branchForProject(project: { resources: Array<{ branchOrMachine?: string; localPath?: string; type: string }> }) {
  const workspace = resolveProjectWorkspace(project as any);
  if (!workspace || !fs.existsSync(workspace.dir)) return undefined;
  try {
    const result = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: workspace.dir,
      maxBuffer: 64 * 1024
    });
    const branch = String(result.stdout || '').trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

agentCallRouter.get('/projects/:projectId/chat/available-agents', async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.read')) return;
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  if (req.workspace?.role === 'client') {
    return res.status(403).json({ error: 'Clients cannot address internal agents.' });
  }

  const project = await getProject(req, res, req.params.projectId);
  if (!project) return;

  const assignedIds = workspaceRegistry.projectSquadIdsFor(req.workspace!, project.id);
  const squads = sqliteService.getSquads().filter(squad => assignedIds.includes(squad.id));
  const agents = sqliteService.getAgents();
  const runtimes = sqliteService.getRuntimes();
  const modes = roleModes(req);
  const visibleSquads = squads.map(squad => {
    const members = (squad.memberAgentIds ?? [])
      .map(agentId => agents.find(agent => agent.id === agentId))
      .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
      .filter(agent => workspaceRegistry.canAccessProjectAgent(req.workspace!, project.id, squad.id, agent.id))
      .filter(agent => agentReadiness(agent, runtimes).status === 'ready')
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        description: agent.description,
        avatar: agent.avatar,
        color: agent.color,
        squadId: squad.id,
        squadName: squad.name,
        availability: 'ready' as const,
        supportedModes: modes
      }));
    return { id: squad.id, name: squad.name, agents: members };
  }).filter(squad => squad.agents.length > 0);

  const workspace = resolveProjectWorkspace(project);
  const hasWorkingCopy = Boolean(workspace && fs.existsSync(workspace.dir));
  res.json({
    project: {
      id: project.id,
      name: project.name,
      key: project.key,
      branch: await branchForProject(project),
      workingCopy: hasWorkingCopy
        ? { status: 'connected', managed: workspace?.managed ?? false }
        : { status: 'not_connected', managed: false },
      assignedSquadNames: visibleSquads.map(squad => squad.name)
    },
    squads: visibleSquads,
    agents: visibleSquads.flatMap(squad => squad.agents)
  });
});

agentCallRouter.post('/projects/:projectId/chat/threads/:threadId/agent-calls', async (req: Request, res: Response) => {
  let savedUserMessageId: string | undefined;
  try {
    if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
    if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
    const project = await getProject(req, res, req.params.projectId);
    if (!project) return;
    if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.threadId)) return;

    const thread = sqliteService.getChatThreads().find(item => item.id === req.params.threadId);
    if (!thread || thread.projectId !== project.id) {
      return res.status(409).json({ error: 'The selected thread is not scoped to this project.' });
    }

    const mode = req.body?.mode as AgentCallMode;
    if (!MODES.has(mode)) return res.status(400).json({ error: 'mode must be ask, review, revise, or implement.' });
    if (!roleModes(req).includes(mode)) {
      return res.status(403).json({ error: 'Your workspace role can only make read-only agent calls.' });
    }

    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
    if (!instruction || instruction.length > 8000) {
      return res.status(400).json({ error: 'instruction is required and must be at most 8,000 characters.' });
    }

    let target: AgentCallTarget | undefined;
    try {
      target = safeTarget(req.body?.target);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    if (mode !== 'ask' && !target) {
      return res.status(400).json({ error: 'A target is required for review, revise, and implement calls.' });
    }

    const { squadId, agentId } = req.body ?? {};
    if (typeof squadId !== 'string' || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'squadId and agentId are required.' });
    }
    if (!workspaceRegistry.canAccessProjectAgent(req.workspace!, project.id, squadId, agentId)) {
      return res.status(404).json({ error: 'That agent is not available for this project.' });
    }

    const agent = sqliteService.getAgents().find(item => item.id === agentId);
    const squad = sqliteService.getSquads().find(item => item.id === squadId);
    if (!agent || !squad || agent.isArchived) {
      return res.status(404).json({ error: 'That agent is not available for this project.' });
    }
    const readiness = agentReadiness(agent, sqliteService.getRuntimes());
    if (readiness.status !== 'ready') {
      return res.status(409).json({ error: readiness.detail });
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: `msg-agent-call-${Date.now()}`,
      threadId: thread.id,
      senderType: 'user',
      senderName: req.body?.senderName || req.workspace!.userId,
      content: instruction,
      messageType: 'user',
      agentId,
      squadId,
      operationMode: mode,
      agentCallStatus: mode === 'implement' ? 'awaiting_confirmation' : 'queued',
      revisionTarget: target,
      timestamp: now
    };
    sqliteService.saveChatMessage(userMessage);
    savedUserMessageId = userMessage.id;

    const call = await agentCallService.create({
      workspaceId: req.workspace!.workspaceId,
      project,
      threadId: thread.id,
      messageId: userMessage.id,
      squadId,
      agent,
      requestedBy: req.workspace!.userId,
      operationMode: mode,
      revisionTarget: target,
      instruction
    });
    res.status(201).json({ call, userMessage, agentMessage: responseForCall(call) });
  } catch (error: any) {
    if (savedUserMessageId) sqliteService.deleteChatMessage(savedUserMessageId);
    res.status(400).json({ error: error.message || 'Failed to create agent call.' });
  }
});

agentCallRouter.get('/agent-calls/:id', (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.read')) return;
  const call = getCallForCaller(req, res, req.params.id);
  if (!call) return;
  res.json({ call, agentMessage: responseForCall(call) });
});

agentCallRouter.get('/projects/:projectId/chat/threads/:threadId/agent-calls', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'chat.read')) return;
  const project = await getProject(req, res, req.params.projectId);
  if (!project) return;
  if (!requireEntityWorkspace(req, res, 'chat_threads', req.params.threadId)) return;
  const thread = sqliteService.getChatThreads().find(item => item.id === req.params.threadId);
  if (!thread || thread.projectId !== project.id) {
    return res.status(404).json({ error: 'Thread not found in the selected project.' });
  }
  const calls = sqliteService.getAgentCalls({
    workspaceId: req.workspace!.workspaceId,
    projectId: project.id,
    threadId: thread.id
  });
  res.json({ calls });
}));

agentCallRouter.post('/agent-calls/:id/confirm', async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
    if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
    const call = getCallForCaller(req, res, req.params.id);
    if (!call) return;
    if (call.operationMode !== 'implement') return res.status(409).json({ error: 'Only implement calls require confirmation.' });
    if (!requireCurrentProjectAgent(req, res, call)) return;
    const updated = await agentCallService.confirm(call.id);
    res.json({ call: updated, agentMessage: responseForCall(updated) });
  } catch (error: any) {
    res.status(409).json({ error: error.message || 'Could not confirm the implementation call.' });
  }
});

agentCallRouter.post('/agent-calls/:id/apply-patch', async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'agent.run')) return;
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Explicit patch confirmation is required.' });
    const call = getCallForCaller(req, res, req.params.id);
    if (!call) return;
    const result = await agentCallService.applyPatch(call.id);
    res.json(result);
  } catch (error: any) {
    res.status(409).json({ error: error.message || 'The patch could not be applied.' });
  }
});

agentCallRouter.post('/agent-calls/:id/cancel', (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
    const call = getCallForCaller(req, res, req.params.id);
    if (!call) return;
    res.json({ call: agentCallService.cancel(call.id) });
  } catch (error: any) {
    res.status(409).json({ error: error.message || 'The call could not be cancelled.' });
  }
});

agentCallRouter.post('/agent-calls/:id/retry', async (req: Request, res: Response) => {
  try {
    if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
    const call = getCallForCaller(req, res, req.params.id);
    if (!call) return;
    if (!requireCurrentProjectAgent(req, res, call)) return;
    if (!roleModes(req).includes(call.operationMode)) return res.status(403).json({ error: 'Your workspace role cannot retry this call.' });
    const updated = await agentCallService.retry(call.id);
    res.json({ call: updated, agentMessage: responseForCall(updated) });
  } catch (error: any) {
    res.status(409).json({ error: error.message || 'The call could not be retried.' });
  }
});

agentCallRouter.post('/agent-calls/:id/follow-up', async (req: Request, res: Response) => {
  let savedFollowUpMessageId: string | undefined;
  try {
    if (!requireWorkspaceCapability(req, res, 'chat.write')) return;
    const previous = getCallForCaller(req, res, req.params.id);
    if (!previous) return;
    if (!roleModes(req).includes(previous.operationMode)) return res.status(403).json({ error: 'Your workspace role cannot continue this call.' });
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
    if (!instruction || instruction.length > 8000) return res.status(400).json({ error: 'A follow-up instruction is required.' });

    const message: ChatMessage = {
      id: `msg-agent-follow-up-${Date.now()}`,
      threadId: previous.threadId,
      senderType: 'user',
      senderName: req.workspace!.userId,
      content: instruction,
      messageType: 'user',
      agentId: previous.agentId,
      squadId: previous.squadId,
      operationMode: previous.operationMode,
      agentCallStatus: previous.operationMode === 'implement' ? 'awaiting_confirmation' : 'queued',
      revisionTarget: previous.revisionTarget,
      timestamp: new Date().toISOString()
    };
    sqliteService.saveChatMessage(message);
    savedFollowUpMessageId = message.id;
    const updated = await agentCallService.followUp(previous.id, instruction, message.id);
    res.status(201).json({ call: updated, userMessage: message, agentMessage: responseForCall(updated) });
  } catch (error: any) {
    if (savedFollowUpMessageId) sqliteService.deleteChatMessage(savedFollowUpMessageId);
    res.status(400).json({ error: error.message || 'The follow-up could not be created.' });
  }
});
