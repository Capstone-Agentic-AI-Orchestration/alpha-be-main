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
  AgentCallMode,
  AgentCallTarget,
  ChatMessage,
  Project
} from '../models/index.js';
import { sqliteService } from './sqliteService.js';
import { resolveProjectWorkspace, allowAttachedWorkspace } from './workspaceService.js';
import { resolveAgentLogged } from './personaService.js';
import { runCliTurn } from './cliRunner.js';
import { agentReadiness } from './agentReadiness.js';
import { logInfo } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 2_000_000;

export interface CreateAgentCallInput {
  id?: string;
  workspaceId: string;
  project: Project;
  threadId: string;
  messageId?: string;
  squadId: string;
  agent: Agent;
  requestedBy: string;
  operationMode: AgentCallMode;
  revisionTarget?: AgentCallTarget;
  instruction: string;
}

export interface AgentCallWorkspaceInfo {
  dir: string;
  managed: boolean;
  temporary: boolean;
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
  async create(input: CreateAgentCallInput): Promise<AgentCall> {
    const now = new Date().toISOString();
    const workspace = this.resolveExecutionWorkspace(input.project, input.operationMode, input.revisionTarget);
    const call: AgentCall = {
      id: input.id || `agent-call-${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.project.id,
      threadId: input.threadId,
      messageId: input.messageId,
      squadId: input.squadId,
      agentId: input.agent.id,
      requestedBy: input.requestedBy,
      operationMode: input.operationMode,
      status: input.operationMode === 'implement' ? 'awaiting_confirmation' : 'queued',
      revisionTarget: input.revisionTarget,
      instruction: input.instruction,
      // Do not persist a local absolute path. It is resolved again on the
      // server for execution and applying a patch.
      workingCopyId: workspace
        ? `${input.project.id}:${workspace.managed ? 'managed' : 'attached'}`
        : undefined,
      createdAt: now,
      artifacts: []
    };

    sqliteService.saveAgentCall(call);
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

    sqliteService.updateAgentCall(id, { status: 'queued', error: undefined });
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

    sqliteService.deleteAgentCallArtifacts(id);
    sqliteService.updateAgentCall(id, {
      status: call.operationMode === 'implement' ? 'awaiting_confirmation' : 'queued',
      error: undefined,
      resultMessageId: undefined,
      startedAt: undefined,
      completedAt: undefined
    });
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
      squadId: previous.squadId,
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
    const workspace = resolveProjectWorkspace(project);
    if (!workspace || !fs.existsSync(workspace.dir)) {
      throw new Error('This project has no local working copy on this machine.');
    }
    if (!workspace.managed) allowAttachedWorkspace(workspace, project.name);
    if (!sqliteService.isPathAllowed(workspace.dir)) {
      throw new Error('The project working copy is not an approved Alpha workspace.');
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
    sqliteService.saveChatMessage(message);
    this.emit('agent_call.patch_applied', { call, message });
    return { call: sqliteService.getAgentCall(id)!, message };
  }

  private async execute(id: string, project: Project, agent: Agent): Promise<AgentCall> {
    const current = sqliteService.getAgentCall(id);
    if (!current) throw new Error('Agent call not found.');
    if (current.status !== 'queued') return current;

    const startedAt = new Date().toISOString();
    sqliteService.updateAgentCall(id, { status: 'running', startedAt, error: undefined });
    this.emit('agent_call.started', sqliteService.getAgentCall(id));

    let workspace: AgentCallWorkspaceInfo | undefined;
    try {
      workspace = this.resolveExecutionWorkspace(project, current.operationMode, current.revisionTarget);
      const readiness = agentReadiness(agent, sqliteService.getRuntimes());
      if (readiness.status !== 'ready') {
        throw new Error(readiness.detail);
      }

      const persona = resolveAgentLogged(agent, {
        projectKey: project.key,
        includeMemory: false,
        includeToolPolicy: false
      });
      const prompt = this.buildPrompt(current, project, agent);
      const turn = await runCliTurn({
        runId: `agent-call-${id}`,
        mode: 'chat',
        cwd: workspace.dir,
        provider: persona.modelProvider,
        modelName: persona.modelName,
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
        autonomyLevel: 'Supervised'
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
      }

      const resultMessage: ChatMessage = {
        id: `msg-${randomUUID()}`,
        threadId: current.threadId,
        senderType: 'agent',
        senderName: agent.name,
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
      sqliteService.saveChatMessage(resultMessage);
      const completed = sqliteService.updateAgentCall(id, {
        status: 'completed',
        resultMessageId: resultMessage.id,
        completedAt: new Date().toISOString(),
        error: undefined
      })!;
      this.emit('agent_call.completed', completed);
      return completed;
    } catch (error: any) {
      const detail = error instanceof Error ? error.message : String(error);
      logInfo(`Agent call ${id} failed: ${detail}`);
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
      sqliteService.saveChatMessage(failureMessage);
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

  private resolveExecutionWorkspace(
    project: Project,
    mode: AgentCallMode,
    target?: AgentCallTarget
  ): AgentCallWorkspaceInfo {
    const resolved = resolveProjectWorkspace(project);
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
      `Project: ${project.name} (${project.key})`,
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
    const patch = match[1].trim();
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
