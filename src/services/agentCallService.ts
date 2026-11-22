import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { RUNS_DIR } from '../config/env.js';
import {
  Agent,
  AgentCall,
  AgentCallActivity,
  AgentCallActivityKind,
  AgentCallMode,
  AgentCallTarget,
  ChatMessage,
  Project
} from '../models/index.js';
import { sqliteService } from './sqliteService.js';
import { resolveProjectWorkspace, allowAttachedWorkspace, repoOfGitHubUrl } from './workspaceService.js';
import { resolveAgentLogged } from './personaService.js';
import { runCliTurn } from './cliRunner.js';
import { agentReadiness } from './agentReadiness.js';
import { logInfo } from '../utils/logger.js';
import { saveChatMessageAndShare } from './chatWriteThrough.js';
import { runWithWorkspace } from './workspaceContext.js';
import { getHeadCommit } from '../utils/gitUtils.js';
import { projectMemoryBlock } from './repositoryMemory.js';

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 2_000_000;
/**
 * Stored in the legacy, non-null agent_calls.squad_id column for direct calls.
 * Squads were removed; nothing reads this value to authorize a call.
 */
export const DIRECT_AGENT_CALL_SQUAD_ID = 'alpha-direct';

export interface CreateAgentCallInput {
  id?: string;
  workspaceId: string;
  project: Project;
  threadId: string;
  messageId?: string;
  agent: Agent;
  requestedBy: string;
  operationMode: AgentCallMode;
  revisionTarget?: AgentCallTarget;
  instruction: string;
}

export interface StartChatTurnActivityInput {
  workspaceId: string;
  project: Project;
  threadId: string;
  messageId: string;
  agent: Agent;
  requestedBy: string;
  instruction: string;
}

export interface AgentCallWorkspaceInfo {
  dir: string;
  managed: boolean;
  temporary: boolean;
  repo?: string;
}

const MAX_AGENT_CALL_ACTIVITIES = 500;

function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)]
    .map(match => match[1].trim())
    .filter(value => value && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => part === '..'))
    .slice(0, 100);
}

function safeToolPaths(input: unknown, cwd: string): string[] {
  const candidates: string[] = [];
  const visit = (value: unknown, key = '', depth = 0) => {
    if (depth > 4 || candidates.length >= 20) return;
    if (typeof value === 'string' && /(?:^|_)(?:file)?path$|file.?name/i.test(key)) {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach(item => visit(item, key, depth + 1));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey, depth + 1));
    }
  };
  visit(input);

  const root = path.resolve(cwd);
  const paths = new Set<string>();
  for (const value of candidates) {
    const candidate = value.trim();
    if (!candidate || candidate.length > 300 || candidate.includes('\0')) continue;
    const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const normalized = relative.split(path.sep).join('/');
    if (normalized.split('/').some(part => part === '..') || /^[A-Za-z]:/.test(normalized)) continue;
    paths.add(normalized);
  }
  return [...paths].slice(0, 8);
}

function safeCommandSummary(input: unknown, cwd: string): string | undefined {
  let command: string | undefined;
  const visit = (value: unknown, key = '', depth = 0) => {
    if (command || depth > 4) return;
    if (typeof value === 'string' && /^(?:command|cmd|script)$/i.test(key)) {
      command = value;
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey, depth + 1));
    }
  };
  visit(input);
  if (!command) return undefined;
  const escapedCwd = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return command
    .replace(new RegExp(escapedCwd, 'gi'), '.')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[redacted]')
    .replace(/(--?(?:api[_-]?key|token|secret|password|auth)(?:=|\s+))\S+/gi, '$1[redacted]')
    .replace(/([A-Za-z]:\\[^\s"']+|\\\\[^\s"']+)/g, '[local path]')
    .replace(/(^|[\s="'(])\/(?!\/)[^\s"'`]+/g, '$1[local path]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:access[_-]?token|api[_-]?key|token|key|secret|password|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 180);
}

function safeErrorDetail(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[redacted]')
    .replace(/([A-Za-z]:\\[^\s"']+|\\\\[^\s"']+)/g, '[local path]')
    .replace(/\/(?:[^\s"']+\/)*[^\s"']+/g, '[local path]')
    .slice(0, 240);
}

/**
 * The repository a call's target is in, when it says: a pull request by its
 * URL, an issue by the repository it was filed in. Null leaves the choice to
 * `resolveProjectWorkspace`'s default.
 */
function repoOfTarget(target: AgentCallTarget | undefined): string | null {
  if (!target?.id) return null;
  if (target.type === 'pull_request') return repoOfGitHubUrl(target.id);
  if (target.type === 'issue') return sqliteService.getIssues().find(issue => issue.id === target.id)?.githubRepo ?? null;
  return null;
}

/**
 * The authoritative execution rail for project-scoped chat calls.
 *
 * A call is deliberately not a normal chat turn. It has a project, squad,
 * agent, mode and target recorded before the model is started. Read-only modes
 * get no Alpha skills, MCP servers or resumable session, and every proposed
 * change is returned as an artifact rather than applied. Implementation has a
 * second confirmation transition and patch application is a third explicit
 * action.
 */
export class AgentCallService extends EventEmitter {
  async startChatTurn(input: StartChatTurnActivityInput): Promise<AgentCall> {
    const now = new Date().toISOString();
    const workspace = resolveProjectWorkspace(input.project);
    const hasWorkspace = Boolean(workspace && fs.existsSync(workspace.dir));
    const call: AgentCall = {
      id: `chat-turn-${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.project.id,
      threadId: input.threadId,
      messageId: input.messageId,
      // Reserved value for the legacy column; it keeps chat replies in the
      // same activity timeline.
      squadId: 'alpha-chat',
      agentId: input.agent.id,
      requestedBy: input.requestedBy,
      operationMode: 'ask',
      origin: 'chat_turn',
      status: 'running',
      instruction: input.instruction,
      workingCopyId: hasWorkspace ? `${input.project.id}:${workspace!.managed ? 'managed' : 'attached'}` : undefined,
      workingBranch: hasWorkspace ? await this.currentBranch(workspace!.dir) : undefined,
      createdAt: now,
      startedAt: now,
      artifacts: [],
      activities: []
    };
    sqliteService.saveAgentCall(call);
    this.recordActivity(call.id, 'status', 'Agent started a turn from project chat');
    this.emit('agent_call.created', sqliteService.getAgentCall(call.id));
    this.emit('agent_call.started', sqliteService.getAgentCall(call.id));
    return sqliteService.getAgentCall(call.id)!;
  }

  recordChatTurnCliEvent(id: string, event: import('./streamParser.js').ParsedEvent, cwd: string): void {
    this.recordCliActivity(id, event, cwd);
  }

  recordChatTurnHandoff(id: string, fromAgentName: string): void {
    this.recordActivity(id, 'handoff', `Received project chat context from ${fromAgentName.slice(0, 80)}`);
  }

  recordChatTurnAttachment(id: string, name: string, contentType: string): void {
    this.recordActivity(id, 'attachment', `Attached ${name.slice(0, 100)} (${contentType.slice(0, 80)})`);
  }

  recordChatTurnSteering(id: string, instruction: string, state: 'queued' | 'applied'): void {
    this.recordActivity(id, 'steering', state === 'queued' ? 'User direction queued for the next safe point' : 'User direction applied', {
      detail: instruction.slice(0, 300)
    });
  }

  cancelChatTurn(id: string, reason = 'The user stopped this chat turn.'): void {
    const current = sqliteService.getAgentCall(id);
    if (!current || current.origin !== 'chat_turn' || current.status !== 'running') return;
    const updated = sqliteService.updateAgentCall(id, {
      status: 'cancelled', error: reason.slice(0, 500), completedAt: new Date().toISOString()
    });
    if (!updated) return;
    this.recordActivity(id, 'status', 'Chat turn stopped after the specialist process exited');
    this.emit('agent_call.cancelled', sqliteService.getAgentCall(id));
  }

  completeChatTurn(id: string, resultMessageId: string): void {
    const updated = sqliteService.updateAgentCall(id, {
      status: 'completed',
      resultMessageId,
      completedAt: new Date().toISOString()
    });
    if (!updated) return;
    this.recordActivity(id, 'summary', 'Project chat agent turn completed');
    this.emit('agent_call.completed', sqliteService.getAgentCall(id));
  }

  failChatTurn(id: string, message: string): void {
    const updated = sqliteService.updateAgentCall(id, {
      status: 'failed',
      error: safeErrorDetail(message),
      completedAt: new Date().toISOString()
    });
    if (!updated) return;
    this.recordActivity(id, 'error', 'Project chat agent turn failed', { detail: safeErrorDetail(message) });
    this.emit('agent_call.failed', sqliteService.getAgentCall(id));
  }

  async create(input: CreateAgentCallInput): Promise<AgentCall> {
    const now = new Date().toISOString();
    const workspace = this.resolveExecutionWorkspace(input.project, input.operationMode, input.revisionTarget);
    if (input.operationMode !== 'ask') {
      this.assertNoActiveOrchestration(input.workspaceId, input.project.id, workspace.repo ?? repoOfTarget(input.revisionTarget) ?? undefined);
    }
    const workingBranch = workspace ? await this.currentBranch(workspace.dir) : undefined;
    const workingCommit = workspace ? await this.currentCommit(workspace.dir) : undefined;
    const call: AgentCall = {
      id: input.id || `agent-call-${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.project.id,
      threadId: input.threadId,
      messageId: input.messageId,
      squadId: DIRECT_AGENT_CALL_SQUAD_ID,
      agentId: input.agent.id,
      requestedBy: input.requestedBy,
      operationMode: input.operationMode,
      origin: 'agent_call',
      status: input.operationMode === 'implement' ? 'awaiting_confirmation' : 'queued',
      revisionTarget: input.revisionTarget,
      instruction: input.instruction,
      // Do not persist a local absolute path. It is resolved again on the
      // server for execution and applying a patch.
      workingCopyId: workspace
        ? `${input.project.id}:${workspace.managed ? 'managed' : 'attached'}`
        : undefined,
      workingBranch,
      workingCommit,
      createdAt: now,
      artifacts: [],
      activities: []
    };

    sqliteService.saveAgentCallWithProjectLock(
      call,
      workspace.repo ?? repoOfTarget(input.revisionTarget) ?? undefined
    );
    this.recordActivity(call.id, 'status', call.status === 'awaiting_confirmation' ? 'Waiting for implementation approval' : 'Agent call queued');
    this.emit('agent_call.created', sqliteService.getAgentCall(call.id));

    if (call.status === 'awaiting_confirmation') {
      return sqliteService.getAgentCall(call.id)!;
    }

    this.scheduleExecution(call.id, input.project, input.agent);
    return sqliteService.getAgentCall(call.id)!;
  }

  async confirm(id: string): Promise<AgentCall> {
    const call = sqliteService.getAgentCall(id);
    if (!call) throw new Error('Agent call not found.');
    if (call.status !== 'awaiting_confirmation') {
      throw new Error('This implementation call is no longer waiting for confirmation.');
    }

    const project = sqliteService.getProjects().find(item => item.id === call.projectId);
    const agent = sqliteService.getAgents().find(item => item.id === call.agentId);
    if (!project || !agent) throw new Error('The project or agent for this call is no longer available.');
    const workspace = this.resolveExecutionWorkspace(project, call.operationMode, call.revisionTarget);
    const queued = sqliteService.queueAgentCallWithProjectLock(
      id,
      workspace.repo ?? repoOfTarget(call.revisionTarget) ?? undefined,
      { status: 'queued', error: undefined }
    );
    if (!queued) throw new Error('Agent call not found.');
    this.recordActivity(id, 'status', 'Implementation approved and queued');
    this.emit('agent_call.queued', sqliteService.getAgentCall(id));
    this.scheduleExecution(id, project, agent);
    return sqliteService.getAgentCall(id)!;
  }

  async retry(id: string): Promise<AgentCall> {
    const call = sqliteService.getAgentCall(id);
    if (!call) throw new Error('Agent call not found.');
    if (!['failed', 'cancelled'].includes(call.status)) {
      throw new Error('Only failed or cancelled calls can be retried.');
    }

    const project = sqliteService.getProjects().find(item => item.id === call.projectId);
    const agent = sqliteService.getAgents().find(item => item.id === call.agentId);
    if (!project || !agent) throw new Error('The project or agent for this call is no longer available.');
    const workspace = this.resolveExecutionWorkspace(project, call.operationMode, call.revisionTarget);
    const retried = sqliteService.retryAgentCallWithProjectLock(
      id,
      workspace.repo ?? repoOfTarget(call.revisionTarget) ?? undefined,
      {
        status: call.operationMode === 'implement' ? 'awaiting_confirmation' : 'queued',
        error: undefined,
        resultMessageId: undefined,
        startedAt: undefined,
        completedAt: undefined,
        workingCommit: undefined,
        activities: []
      }
    );
    if (!retried) throw new Error('Agent call not found.');
    this.recordActivity(id, 'status', call.operationMode === 'implement' ? 'Waiting for implementation approval' : 'Retry queued');
    this.emit('agent_call.queued', sqliteService.getAgentCall(id));
    if (call.operationMode === 'implement') return sqliteService.getAgentCall(id)!;
    this.scheduleExecution(id, project, agent);
    return sqliteService.getAgentCall(id)!;
  }

  async followUp(callId: string, instruction: string, messageId?: string): Promise<AgentCall> {
    const previous = sqliteService.getAgentCall(callId);
    if (!previous) throw new Error('Agent call not found.');
    const project = sqliteService.getProjects().find(item => item.id === previous.projectId);
    const agent = sqliteService.getAgents().find(item => item.id === previous.agentId);
    if (!project || !agent) throw new Error('The project or agent for this call is no longer available.');

    return this.create({
      workspaceId: previous.workspaceId,
      project,
      threadId: previous.threadId,
      messageId,
      agent,
      requestedBy: previous.requestedBy,
      operationMode: previous.operationMode,
      revisionTarget: previous.revisionTarget,
      instruction
    });
  }

  cancel(id: string): AgentCall {
    const call = sqliteService.getAgentCall(id);
    if (!call) throw new Error('Agent call not found.');
    if (call.status === 'running') {
      // runCliTurn is currently a blocking promise without a process handle;
      // claiming that this stopped the provider would be false.
      throw new Error('This call is already running and cannot be stopped yet.');
    }
    if (!['queued', 'awaiting_confirmation'].includes(call.status)) {
      throw new Error('This call cannot be cancelled in its current state.');
    }
    const updated = sqliteService.updateAgentCall(id, {
      status: 'cancelled',
      completedAt: new Date().toISOString()
    })!;
    this.recordActivity(id, 'status', 'Agent call cancelled before execution');
    this.emit('agent_call.cancelled', updated);
    return updated;
  }

  private scheduleExecution(id: string, project: Project, agent: Agent): void {
    // Let the HTTP request return the queued record first. This gives the
    // client a stable call id and makes the queued/running highlight visible
    // even when the provider responds quickly.
    setImmediate(() => {
      void this.execute(id, project, agent).catch(error => {
        logInfo(`Agent call ${id} could not be scheduled: ${String(error)}`);
      });
    });
  }

  async applyPatch(id: string): Promise<{ call: AgentCall; message: ChatMessage }> {
    const call = sqliteService.getAgentCall(id);
    if (!call) throw new Error('Agent call not found.');
    if (call.status !== 'completed' || !['revise', 'implement'].includes(call.operationMode)) {
      throw new Error('Only a completed revise or implement call can apply a patch.');
    }
    const patch = call.artifacts.find(artifact => artifact.artifactType === 'patch')?.content;
    if (!patch) throw new Error('This call did not produce an applyable patch.');
    if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
      throw new Error('The proposed patch is too large to apply safely.');
    }

    const project = sqliteService.getProjects().find(item => item.id === call.projectId);
    if (!project) throw new Error('Project not found.');
    // The same checkout the call ran in, so the patch lands where it was made.
    const workspace = resolveProjectWorkspace(project, repoOfTarget(call.revisionTarget));
    if (!workspace || !fs.existsSync(workspace.dir)) {
      throw new Error('This project has no local working copy on this machine.');
    }
    if (!workspace.managed) allowAttachedWorkspace(workspace, project.name);
    if (!sqliteService.isPathAllowed(workspace.dir)) {
      throw new Error('The project working copy is not an approved Alpha workspace.');
    }
    const repository = workspace.repo ?? repoOfTarget(call.revisionTarget) ?? '';
    sqliteService.acquireAgentCallPatchLock(id, repository);
    try {
      const currentBranch = await this.currentBranch(workspace.dir);
      if (call.workingBranch && call.workingBranch !== currentBranch) {
        throw new Error(`The project working copy is now on ${currentBranch ? `branch "${currentBranch}"` : 'no Git branch'}; this patch was prepared for "${call.workingBranch}".`);
      }
      const currentCommit = await this.currentCommit(workspace.dir);
      if (call.workingCommit && currentCommit !== call.workingCommit) {
        throw new Error('The project repository changed after this proposal was prepared. Rerun the independent call against the current commit before applying its patch.');
      }

      const patchFile = path.join(RUNS_DIR, `${call.id}-apply.patch`);
      fs.mkdirSync(RUNS_DIR, { recursive: true });
      fs.writeFileSync(patchFile, patch, { encoding: 'utf8', mode: 0o600 });
      try {
        // git apply rejects absolute and parent-traversing paths unless the
        // dangerous --unsafe-paths option is supplied. Alpha never supplies it.
        await execFileAsync('git', ['apply', '--check', '--whitespace=nowarn', patchFile], {
          cwd: workspace.dir,
          maxBuffer: 4 * 1024 * 1024
        });
        await execFileAsync('git', ['apply', '--whitespace=nowarn', patchFile], {
          cwd: workspace.dir,
          maxBuffer: 4 * 1024 * 1024
        });
      } catch (error: any) {
        const detail = String(error?.stderr || error?.message || 'git rejected the patch').trim();
        throw new Error(`Patch was not applied: ${detail}`);
      } finally {
        try { fs.rmSync(patchFile, { force: true }); } catch { /* temp file only */ }
      }

      const message: ChatMessage = {
        id: `msg-${randomUUID()}`,
        threadId: call.threadId,
        senderType: 'system',
        senderName: 'Alpha',
        content: `Patch applied to the ${project.name} working copy. Review the working tree before committing.`,
        messageType: 'system',
        agentCallId: call.id,
        operationMode: call.operationMode,
        agentCallStatus: 'completed',
        revisionTarget: call.revisionTarget,
        timestamp: new Date().toISOString()
      };
      saveChatMessageAndShare(message);
      this.recordActivity(id, 'file_change', 'Proposed patch applied to the project working copy', {
        paths: patchPaths(patch)
      });
      this.emit('agent_call.patch_applied', { call, message });
      return { call: sqliteService.getAgentCall(id)!, message };
    } finally {
      sqliteService.releaseAgentCallProjectLock(id);
    }
  }

  private async execute(id: string, project: Project, agent: Agent): Promise<AgentCall> {
    const current = sqliteService.getAgentCall(id);
    if (!current) throw new Error('Agent call not found.');
    if (current.status !== 'queued') return current;

    const startedAt = new Date().toISOString();
    sqliteService.updateAgentCall(id, { status: 'running', startedAt, error: undefined });
    this.recordActivity(id, 'status', 'Agent started work in the project chat');
    this.emit('agent_call.started', sqliteService.getAgentCall(id));

    let workspace: AgentCallWorkspaceInfo | undefined;
    try {
      workspace = this.resolveExecutionWorkspace(project, current.operationMode, current.revisionTarget);
      if (current.operationMode !== 'ask') {
        this.assertNoActiveOrchestration(current.workspaceId, project.id, workspace.repo ?? repoOfTarget(current.revisionTarget) ?? undefined);
      }
      const workingBranch = await this.currentBranch(workspace.dir);
      const workingCommit = await this.currentCommit(workspace.dir);
      if (current.workingBranch !== workingBranch) {
        sqliteService.updateAgentCall(id, { workingBranch, workingCommit });
        this.recordActivity(id, 'status', workingBranch ? `Target branch: ${workingBranch}` : 'No Git branch detected for the working copy');
      } else {
        sqliteService.updateAgentCall(id, { workingCommit });
      }
      const persona = resolveAgentLogged(agent, {
        projectKey: project.key,
        includeMemory: false,
        includeToolPolicy: false,
        // The project's repository memory comes first, as for every agent on a project.
        repositoryMemory: await projectMemoryBlock(project)
      });
      const effectiveAgent = { ...agent, ...persona };
      const runtimes = sqliteService.getRuntimes();
      const readiness = agentReadiness(effectiveAgent, runtimes);
      if (readiness.status !== 'ready') {
        throw new Error(readiness.detail);
      }

      const prompt = this.buildPrompt(current, project, effectiveAgent);
      const turn = await runCliTurn({
        runId: `agent-call-${id}`,
        usageContext: { threadId: current.threadId, agentId: current.agentId, callId: id, messageId: current.messageId },
        mode: 'chat',
        cwd: workspace.dir,
        provider: persona.modelProvider,
        modelName: persona.modelName,
        codexBaseUrl: runtimes.find(runtime =>
          runtime.provider === persona.modelProvider && runtime.models.includes(persona.modelName)
        )?.endpoint,
        reasoningEffort: persona.reasoningEffort,
        personaName: persona.name,
        systemPrompt: [persona.systemPrompt, READ_ONLY_CALL_POLICY].filter(Boolean).join('\n\n---\n\n'),
        prompt,
        priorSession: null,
        // An explicit empty grant is the important boundary. Do not inherit
        // persona skills or MCP connectors for this review/proposal path.
        skills: [],
        mcpServers: [],
        mcpEnv: {},
        env: {},
        autonomyLevel: 'Supervised',
        onEvent: event => this.recordCliActivity(id, event, workspace!.dir)
      });

      if (turn.failureKind || !turn.content.trim()) {
        throw new Error(turn.failureDetail || 'The selected agent returned no answer.');
      }

      const content = turn.content.trim();
      const patch = this.extractPatch(content);
      if (patch && ['revise', 'implement'].includes(current.operationMode)) {
        sqliteService.saveAgentCallArtifact({
          id: `artifact-${randomUUID()}`,
          agentCallId: id,
          artifactType: 'patch',
          content: patch,
          createdAt: new Date().toISOString()
        });
        const paths = patchPaths(patch);
        this.recordActivity(id, 'file_change', `Prepared a reviewable patch for ${paths.length || 'one or more'} file${paths.length === 1 ? '' : 's'}`, { paths });
      }

      const resultMessage: ChatMessage = {
        id: `msg-${randomUUID()}`,
        threadId: current.threadId,
        senderType: 'agent',
        senderName: persona.name,
        agentId: agent.id,
        squadId: current.squadId,
        content,
        // Never persist or return private model reasoning as a user-visible
        // transcript field. Safe activity is represented by artifacts and the
        // call status instead.
        messageType: 'agent_call',
        agentCallId: id,
        operationMode: current.operationMode,
        agentCallStatus: 'completed',
        revisionTarget: current.revisionTarget,
        toolsExecuted: [],
        timestamp: new Date().toISOString()
      };
      saveChatMessageAndShare(resultMessage);
      const completed = sqliteService.updateAgentCall(id, {
        status: 'completed',
        resultMessageId: resultMessage.id,
        completedAt: new Date().toISOString(),
        error: undefined
      })!;
      this.recordActivity(id, 'summary', 'Agent finished; review the chat response and any proposed patch');
      this.emit('agent_call.completed', completed);
      return completed;
    } catch (error: any) {
      const detail = error instanceof Error ? error.message : String(error);
      logInfo(`Agent call ${id} failed: ${detail}`);
      this.recordActivity(id, 'error', 'Agent call failed', { detail: safeErrorDetail(detail) });
      const failureMessage: ChatMessage = {
        id: `msg-${randomUUID()}`,
        threadId: current.threadId,
        senderType: 'system',
        senderName: 'Alpha',
        squadId: current.squadId,
        content: `The ${agent.name} call could not complete.\n\n${detail}`,
        messageType: 'agent_call',
        agentCallId: id,
        operationMode: current.operationMode,
        agentCallStatus: 'failed',
        revisionTarget: current.revisionTarget,
        timestamp: new Date().toISOString()
      };
      saveChatMessageAndShare(failureMessage);
      const failed = sqliteService.updateAgentCall(id, {
        status: 'failed',
        resultMessageId: failureMessage.id,
        error: detail,
        completedAt: new Date().toISOString()
      })!;
      this.emit('agent_call.failed', failed);
      return failed;
    } finally {
      if (workspace?.temporary) {
        try { fs.rmSync(workspace.dir, { recursive: true, force: true }); } catch { /* temp only */ }
      }
    }
  }

  private recordCliActivity(id: string, event: import('./streamParser.js').ParsedEvent, cwd: string): void {
    if (event.type === 'stage_transition') {
      const stage = String(event.stage || 'analysis').replace(/[_-]+/g, ' ');
      this.recordActivity(id, 'stage', `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`);
      return;
    }
    if (event.type === 'tool_call') {
      const rawTool = String(event.toolName || 'tool').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 40) || 'Tool';
      const knownLabels: Record<string, string> = {
        Read: 'Reading project files',
        Glob: 'Finding project files',
        Grep: 'Searching project files',
        LS: 'Listing project files',
        Bash: 'Command requested',
        Edit: 'File edit requested',
        Write: 'File write requested'
      };
      const paths = safeToolPaths(event.toolInput, cwd);
      const isFileWrite = ['Edit', 'Write', 'NotebookEdit'].includes(rawTool) ||
        /(?:edit|write|patch).*(?:file|document|content)|(?:file|document|content).*(?:edit|write|patch)/i.test(rawTool);
      const command = rawTool === 'Bash' ? safeCommandSummary(event.toolInput, cwd) : undefined;
      this.recordActivity(
        id,
        isFileWrite ? 'file_change' : 'tool',
        isFileWrite ? 'Agent is editing project files' : knownLabels[rawTool] || `${rawTool} activity`,
        { toolName: rawTool, detail: command, paths: paths.length ? paths : undefined }
      );
      return;
    }
    if (event.type === 'tool_result') {
      this.recordActivity(id, 'tool_result', 'Tool finished');
      return;
    }
    if (event.type === 'error') {
      this.recordActivity(id, 'error', 'Agent reported an execution error', {
        detail: event.message ? safeErrorDetail(event.message) : undefined
      });
    }
  }

  private async currentBranch(cwd: string): Promise<string | undefined> {
    try {
      const result = await execFileAsync('git', ['branch', '--show-current'], { cwd, maxBuffer: 64 * 1024 });
      const branch = String(result.stdout || '').trim();
      return branch ? branch.slice(0, 200) : undefined;
    } catch {
      return undefined;
    }
  }

  private async currentCommit(cwd: string): Promise<string | undefined> {
    try {
      return await getHeadCommit(cwd);
    } catch {
      return undefined;
    }
  }

  private assertNoActiveOrchestration(workspaceId: string, projectId: string, repository?: string): void {
    const active = runWithWorkspace(workspaceId, () =>
      sqliteService.getActiveOrchestrationForProject(projectId, repository));
    if (!active) return;
    const branch = active.branchName ? ` on ${active.branchName}` : '';
    throw new Error(
      `This independent code call is paused while task build ${active.runId} is ${active.status}${branch} for ${active.repository}. Wait for that build to reach a terminal state, then rerun the call against its result.`
    );
  }

  private recordActivity(
    id: string,
    kind: AgentCallActivityKind,
    message: string,
    extra: Pick<AgentCallActivity, 'toolName' | 'detail' | 'paths'> = {}
  ): AgentCallActivity | undefined {
    const current = sqliteService.getAgentCall(id);
    if (!current) return undefined;
    const activity: AgentCallActivity = {
      id: `activity-${randomUUID()}`,
      sequence: (current.activities?.at(-1)?.sequence ?? 0) + 1,
      kind,
      message: message.slice(0, 160),
      toolName: extra.toolName?.slice(0, 80),
      detail: extra.detail ? extra.detail.slice(0, 300) : undefined,
      paths: extra.paths?.slice(0, 100).map(value => value.slice(0, 300)),
      createdAt: new Date().toISOString()
    };
    const activities = [...(current.activities ?? []), activity].slice(-MAX_AGENT_CALL_ACTIVITIES);
    const updated = sqliteService.updateAgentCall(id, { activities });
    if (updated) this.emit('agent_call.activity', { id, status: updated.status, activity });
    return activity;
  }

  private resolveExecutionWorkspace(
    project: Project,
    mode: AgentCallMode,
    target?: AgentCallTarget
  ): AgentCallWorkspaceInfo {
    const resolved = resolveProjectWorkspace(project, repoOfTarget(target));
    if (resolved && fs.existsSync(resolved.dir) && fs.statSync(resolved.dir).isDirectory()) {
      if (!resolved.managed) allowAttachedWorkspace(resolved, project.name);
      return { ...resolved, temporary: false };
    }

    const codeTarget = target && ['file', 'code', 'branch', 'commit', 'pull_request', 'diff'].includes(target.type);
    if (codeTarget || ['review', 'revise', 'implement'].includes(mode)) {
      if (mode !== 'ask' && mode !== 'review') {
        throw new Error('This project has no local working copy on this machine, so a proposed code change cannot be generated.');
      }
      if (codeTarget) {
        throw new Error('This project has no local working copy on this machine, so the selected code target cannot be inspected.');
      }
    }

    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const dir = fs.mkdtempSync(path.join(RUNS_DIR, 'agent-call-'));
    sqliteService.addAllowedPath(dir, `Temporary project-call workspace for ${project.key}`);
    return { dir, managed: false, temporary: true };
  }

  private buildPrompt(call: AgentCall, project: Project, agent: Agent): string {
    const target = call.revisionTarget
      ? `${call.revisionTarget.type}: ${call.revisionTarget.label || call.revisionTarget.id}`
      : 'No specific target';
    const modeGuidance: Record<AgentCallMode, string> = {
      ask: 'Answer the question using only the project context available in this call.',
      review: 'Inspect the selected target and report findings, evidence and validation steps. Do not change anything.',
      revise: 'Propose a minimal, reviewable change. Include a unified diff in a fenced diff block when a change is appropriate. Do not apply it.',
      implement: 'Prepare the smallest safe implementation proposal. Include a unified diff in a fenced diff block when a change is appropriate. Do not apply it.'
    };

    return [
      `You are ${agent.name}, the explicitly selected project agent for Alpha.`,
      `Role: ${agent.role}`,
      'This is an independent call to you alone. Complete only work within your persona responsibilities; do not act as the whole team.',
      'When the request exceeds your role, explain the boundary and identify the specialist needed. Do not silently take over their work.',
      `Project: ${project.name} (${project.key})`,
      `Project goal and ground rules: ${project.description || 'Not specified'}`,
      `Operation mode: ${call.operationMode.toUpperCase()}`,
      `Target: ${target}`,
      '',
      modeGuidance[call.operationMode],
      'Use only the current project working copy and the project metadata supplied here.',
      'Do not inspect parent directories, other repositories, user home folders, secrets, or unrelated workspaces.',
      'Do not run shell commands, network requests, package installs, MCP tools, or file writes.',
      'Do not claim that a change was applied. A patch is only a proposal until Alpha applies it after a separate user confirmation.',
      'Return a concise answer with a summary, findings, impacted files, validation status and warnings when relevant.',
      '',
      'User instruction:',
      call.instruction
    ].join('\n');
  }

  private extractPatch(content: string): string | undefined {
    const match = content.match(/```(?:diff|patch)\s*\n([\s\S]*?)```/i);
    if (!match?.[1]) return undefined;
    // Only surrounding blank lines go: a last hunk can end on a blank context line (a single
    // space), and trimming it away made git apply reject the patch as corrupt.
    const lines = match[1].split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].replace(/\r$/, '')) lines.pop();
    const patch = lines.join('\n');
    if (!patch || Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) return undefined;
    if (!/(^|\n)(diff --git |--- a\/|\+\+\+ b\/)/.test(patch)) return undefined;
    return `${patch}\n`;
  }
}

const READ_ONLY_CALL_POLICY = [
  'This is a supervised, read-only Alpha agent call.',
  'You have no write, shell, network, browser, GitHub or MCP capabilities.',
  'Private chain-of-thought is not a deliverable. Return only the concise user-facing result requested by the output contract.'
].join('\n');

export const agentCallService = new AgentCallService();
