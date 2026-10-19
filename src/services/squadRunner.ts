import { randomUUID } from 'node:crypto';
import { sqliteService } from './sqliteService.js';
import { runnerService } from './runnerService.js';
import { resolveAgent } from './personaService.js';
import { totalTokens } from './runUsage.js';
import { logInfo, logError } from '../utils/logger.js';
import { Agent, BuildStepPhase, PrototypeRun, Squad, SquadMemberAssignment, SquadRun } from '../models/index.js';
import { addCommentAndShare, updateIssueAndPush } from './boardWriteThrough.js';
import { agentBranchName } from './githubRepoWorkspace.js';
import type { TicketExecutionHandle } from './ticketExecutionRelay.js';
import { currentWorkspaceId, runWithWorkspace } from './workspaceContext.js';
import { workspaceRegistry } from './workspaceRegistry.js';
import { supabaseService } from './supabaseService.js';
import { addDetachedWorktree, removeDetachedWorktree } from '../utils/gitUtils.js';
import { projectRunWorkspacePath } from './workspaceService.js';

/**
 * Running a squad over an issue, one member at a time.
 *
 * Before this, `triggerSquadRun` in the frontend incremented a counter, posted
 * a notification, and set a 4.5 second timer that marked the run complete. No
 * endpoint was called, no process was spawned, and no agent was told anything.
 * The daemon had no concept of more than one agent per run.
 *
 * Members share one git branch and run in sequence. Each one after the first is
 * given a written handoff and inherits the previous members' committed work,
 * which it can read with its own tools.
 */

/**
 * Only Sequential executes.
 *
 * `topology` has always been one of Sequential, Hierarchical or Consensus, and
 * nothing ever branched on it — it was display text and a list filter. Rather
 * than run all three sequentially and let two of them describe behaviour that
 * does not exist, the two unimplemented ones are refused. A label claiming an
 * orchestration that is not happening is the same defect as a run reporting
 * tests it never ran.
 */
export const SUPPORTED_TOPOLOGIES = ['Sequential'] as const;

/**
 * Is this topology one Alpha can actually run?
 *
 * Compared case-insensitively because the two halves of the app disagree about
 * capitalisation and always have: the daemon's model says
 * 'Sequential' | 'Hierarchical' | 'Consensus', while the frontend's SquadTopology
 * says 'sequential' | 'hierarchical' | 'swarm' | 'consensus' — and the create
 * form defaults to 'hierarchical'. An exact match would refuse every squad made
 * in the UI, including ones that are Sequential in everything but spelling.
 *
 * 'swarm' exists only on the frontend side and has no daemon behaviour at all,
 * so it falls through to unsupported like the others.
 */
export function isSupportedTopology(topology: string | undefined): boolean {
  const normalised = String(topology ?? '').trim().toLowerCase();
  return SUPPORTED_TOPOLOGIES.some(t => t.toLowerCase() === normalised);
}

export class SquadRunError extends Error {}

export class SquadRunner {
  /** Squad runs waiting on a member, keyed by the run id currently executing. */
  private awaiting = new Map<string, { squadRunId: string; workspaceId: string }>();
  private ticketExecutions = new Map<string, TicketExecutionHandle>();
  /** Local-only paths: never published with the shared squad-run record. */
  private runWorkspaces = new Map<string, { repositoryDir: string; workingDir: string }>();
  /** Serialize finish and cancellation transitions so a stop cannot race a handoff. */
  private transitionQueues = new Map<string, Promise<unknown>>();
  private wired = false;

  private serializeTransition<T>(squadRunId: string, transition: () => Promise<T>): Promise<T> {
    const previous = this.transitionQueues.get(squadRunId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(transition);
    this.transitionQueues.set(squadRunId, current);
    current.then(
      () => { if (this.transitionQueues.get(squadRunId) === current) this.transitionQueues.delete(squadRunId); },
      () => { if (this.transitionQueues.get(squadRunId) === current) this.transitionQueues.delete(squadRunId); }
    );
    return current;
  }

  /** Keep the local runner authoritative while publishing the room's parent run to the shared board. */
  private async persistSquadRun(run: SquadRun, workspaceId: string): Promise<void> {
    sqliteService.saveSquadRun(run);
    if (supabaseService.isConfigured()) {
      await supabaseService.saveSquadRunToCloud(run, workspaceId);
    }
  }

  /**
   * Advance a squad when the member it was waiting on finishes.
   *
   * Driven by runnerService's own events rather than by polling, and attached
   * lazily so importing this module does not add listeners in tests that never
   * start a squad.
   */
  private wire() {
    if (this.wired) return;
    this.wired = true;

    const onFinish = (succeeded: boolean) => (run: PrototypeRun) => {
      if (!this.awaiting.has(run.id)) return;
      this.advance(run, succeeded).catch(err => logError('Squad advance failed:', err));
    };

    runnerService.on('run_completed', onFinish(true));
    runnerService.on('run_failed', onFinish(false));
    runnerService.on('run_cancelled', onFinish(false));
  }

  async startSquadRun(params: {
    squadId: string;
    issueId: string;
    id?: string;
    ticketExecution?: TicketExecutionHandle;
    plan?: string[];
    mission?: string;
    workspaceId?: string;
    /** Base checkout for a chat-triggered run-scoped Git worktree. */
    baseWorkspaceDir?: string;
    /** Ordered project steps first; unmentioned squad members follow in squad order. */
    memberAgentIds?: string[];
    /** Optional project-defined stages, frozen for this run. */
    memberAssignments?: SquadMemberAssignment[];
  }): Promise<SquadRun> {
    const workspaceId = params.workspaceId ?? currentWorkspaceId();
    return runWithWorkspace(workspaceId, () => this.startInWorkspace({ ...params, workspaceId }));
  }

  /** Stop the current member and close the parent run before a queued handoff can start. */
  async cancelSquadRun(squadRunId: string, workspaceId = currentWorkspaceId()): Promise<SquadRun> {
    return this.serializeTransition(squadRunId, () => runWithWorkspace(workspaceId, async () => {
      const squadRun = sqliteService.getSquadRun(squadRunId);
      if (!squadRun) throw new SquadRunError(`Squad run not found: ${squadRunId}`);
      if (squadRun.status !== 'running') {
        throw new SquadRunError(`Squad run is ${squadRun.status}, not cancellable.`);
      }

      const now = new Date().toISOString();
      const cancelled: SquadRun = {
        ...squadRun,
        status: 'cancelled',
        stoppedReason: 'Build stopped by the user.',
        updatedAt: now
      };

      // Persist the parent first. A member's cancellation event then sees a
      // terminal parent and cannot advance the squad to its next agent.
      await this.persistSquadRun(cancelled, workspaceId);

      const activeMember = sqliteService.getRunsForSquadRun(squadRunId)
        .find(run => run.status === 'queued' || run.status === 'running');
      if (activeMember) await runnerService.cancelRun(activeMember.id);

      updateIssueAndPush(squadRun.issueId, { status: 'in_progress' });
      addCommentAndShare({
        id: `comm-${squadRun.id}-cancelled`,
        issueId: squadRun.issueId,
        authorType: 'system',
        authorName: 'Alpha Squad Runner',
        content: `Build stopped by the user. Work already completed remains on \`${squadRun.branchName}\` for review.`,
        createdAt: now
      });

      const result = sqliteService.getSquadRun(squadRunId) ?? cancelled;
      runnerService.emit('squad_run_cancelled', result);
      return result;
    }));
  }

  private async startInWorkspace(params: {
    squadId: string;
    issueId: string;
    id?: string;
    ticketExecution?: TicketExecutionHandle;
    plan?: string[];
    mission?: string;
    workspaceId: string;
    baseWorkspaceDir?: string;
    memberAgentIds?: string[];
    memberAssignments?: SquadMemberAssignment[];
  }): Promise<SquadRun> {
    this.wire();

    const squad = sqliteService.getSquads().find(s => s.id === params.squadId);
    if (!squad) throw new SquadRunError(`Squad not found: ${params.squadId}`);

    if (!isSupportedTopology(squad.topology)) {
      throw new SquadRunError(
        `"${squad.name}" uses the ${squad.topology} topology, which Alpha cannot run yet — only Sequential is implemented. ` +
          `Change the squad to Sequential, or run its members individually.`
      );
    }

    const issue = sqliteService.getIssues().find(i => i.id === params.issueId);
    if (!issue) throw new SquadRunError(`Issue not found: ${params.issueId}`);

    const configuredOrder = orderedMembers(squad);
    const requestedOrder = [...new Set(params.memberAgentIds ?? [])]
      .filter(id => configuredOrder.includes(id));
    const members = [...requestedOrder, ...configuredOrder.filter(id => !requestedOrder.includes(id))];
    if (!members.length) {
      throw new SquadRunError(`"${squad.name}" has no member agents, so there is nobody to run.`);
    }

    // Fail before opening a run, rather than halfway through the squad.
    const known = new Set(sqliteService.getAgents().filter(a => !a.isArchived).map(a => a.id));
    const missing = members.filter(id => !known.has(id));
    if (missing.length) {
      throw new SquadRunError(
        `"${squad.name}" lists member(s) that no longer exist or are archived: ${missing.join(', ')}.`
      );
    }

    const providedAssignments = new Map<string, SquadMemberAssignment>();
    for (const assignment of params.memberAssignments ?? []) {
      if (!members.includes(assignment.agentId)) continue;
      const existing = providedAssignments.get(assignment.agentId);
      providedAssignments.set(assignment.agentId, existing
        ? {
            agentId: assignment.agentId,
            stageLabel: `${existing.stageLabel} · ${assignment.stageLabel}`,
            phase: existing.phase === assignment.phase ? assignment.phase : undefined,
            instructions: `${existing.instructions}\n- ${assignment.instructions}`
          }
        : assignment);
    }
    const agents = sqliteService.getAgents();
    const memberAssignments = members.map((agentId, index) => {
      const agent = agents.find(item => item.id === agentId)!;
      return providedAssignments.get(agentId)
        ?? defaultMemberAssignment({ ...agent, ...resolveAgent(agent, { includeMemory: false }) }, index, members.length);
    });

    const now = new Date().toISOString();
    const squadRun: SquadRun = {
      id: params.id ?? `squadrun-${randomUUID()}`,
      squadId: squad.id,
      issueId: issue.id,
      projectId: issue.projectId,
      // Decided once, here, because every member commits to it.
      branchName: agentBranchName(`squad-${squad.name}`, `${issue.identifier}-${Date.now().toString().slice(-4)}`),
      memberAgentIds: members,
      currentMemberIndex: 0,
      status: 'running',
      mission: params.mission || squad.mission,
      plan: params.plan || [],
      memberAssignments,
      createdAt: now,
      updatedAt: now
    };
    if (params.baseWorkspaceDir) {
      const workingDir = projectRunWorkspacePath(squadRun.projectId, squadRun.id);
      await addDetachedWorktree(params.baseWorkspaceDir, workingDir);
      this.runWorkspaces.set(squadRun.id, { repositoryDir: params.baseWorkspaceDir, workingDir });
    }

    // The squad is the issue's execution owner. Member runs below carry the
    // individual agent identity, but must not replace this assignment when the
    // issue is refreshed by the project execution monitor.
    if (!params.ticketExecution) {
      sqliteService.updateIssue(issue.id, {
        assignedSquadId: squad.id,
        assignedAgentId: undefined,
        status: 'agent_running'
      });
    }

    if (params.ticketExecution) this.ticketExecutions.set(squadRun.id, params.ticketExecution);
    await this.persistSquadRun(squadRun, params.workspaceId);
    workspaceRegistry.bind('squad_runs', squadRun.id, params.workspaceId);

    logInfo(
      `Squad "${squad.name}" starting on ${issue.identifier}: ${members.length} member(s), branch ${squadRun.branchName}`
    );

    try {
      await this.startMember(squadRun, 0, params.workspaceId);
    } catch (error) {
      const reason = `Could not start ${nameFor(members[0])}: ${error instanceof Error ? error.message : String(error)}`;
      const stopped: SquadRun = {
        ...squadRun,
        status: 'failed',
        stoppedReason: reason,
        updatedAt: new Date().toISOString()
      };
      await this.persistSquadRun(stopped, params.workspaceId);
      updateIssueAndPush(issue.id, { status: 'in_progress' });
      addCommentAndShare({
        id: `comm-${squadRun.id}-stopped`,
        issueId: squadRun.issueId,
        authorType: 'system',
        authorName: 'Alpha Squad Runner',
        content: `Squad run stopped before its first agent started. ${reason} The issue is ready to retry.`,
        createdAt: stopped.updatedAt
      });
      runnerService.emit('squad_run_failed', stopped);
      throw error;
    }
    return sqliteService.getSquadRun(squadRun.id) ?? squadRun;
  }

  private async startMember(squadRun: SquadRun, index: number, workspaceId: string) {
    const ticketExecution = this.ticketExecutions.get(squadRun.id);
    const agentId = squadRun.memberAgentIds[index];
    const assignment = squadRun.memberAssignments?.find(item => item.agentId === agentId)
      ?? (() => {
        const agent = sqliteService.getAgents().find(item => item.id === agentId)!;
        return defaultMemberAssignment({ ...agent, ...resolveAgent(agent, { includeMemory: false }) }, index, squadRun.memberAgentIds.length);
      })();
    const assignmentPlan = [
      `Assigned stage: ${assignment.stageLabel}${assignment.phase ? ` (${assignment.phase})` : ''}`,
      `Assigned task: ${assignment.instructions}`
    ];
    const run = await runWithWorkspace(workspaceId, () => runnerService.startRun({
      issueId: squadRun.issueId,
      agentId,
      plan: [...squadRun.plan, ...assignmentPlan],
      workspaceId,
      workingDir: this.runWorkspaces.get(squadRun.id)?.workingDir,
      squad: {
        squadRunId: squadRun.id,
        order: index,
        memberCount: squadRun.memberAgentIds.length,
        branchName: squadRun.branchName,
        assignment,
        handoff: this.buildHandoff(squadRun, index)
      },
      ...(ticketExecution ? { ticketExecution: { ...ticketExecution, memberOrder: index } } : {})
    }));

    workspaceRegistry.bind('prototype_runs', run.id, workspaceId);
    this.awaiting.set(run.id, { squadRunId: squadRun.id, workspaceId });
    await this.persistSquadRun({
      ...squadRun,
      currentMemberIndex: index,
      updatedAt: new Date().toISOString()
    }, workspaceId);

    /**
     * The handoff, as an event.
     *
     * This is the moment "who is working now" changes, and nothing said so.
     * `squad_run_completed` and `squad_run_failed` already existed and reached
     * nobody: they are emitted on runnerService's emitter, but index.ts forwards
     * only the five run-level names to the WebSocket, so neither was ever sent.
     * A squad run therefore reached the UI only incidentally, through its
     * members' stage updates, with no indication of which member they belonged
     * to or how many remained.
     *
     * Emitted on runnerService for the same reason the other two are: it is the
     * emitter index.ts already listens to.
     *
     * The handoff text rides along because it is the reason this member
     * started: what the ones before it left on the branch.
     */
    runnerService.emit('squad_member_started', {
      squadRunId: squadRun.id,
      runId: run.id,
      memberIndex: index,
      memberCount: squadRun.memberAgentIds.length,
      agentId: squadRun.memberAgentIds[index],
      agentName: nameFor(squadRun.memberAgentIds[index]),
      handoff: this.buildHandoff(squadRun, index)
    });
  }

  /**
   * Move to the next member, or finish.
   *
   * A failed member stops the squad. Carrying on regardless means the next
   * agent builds on work that is broken or absent, and the squad reports a
   * result assembled from a step that did not happen. Stopping leaves the
   * branch and every commit up to the failure intact for a person to inspect.
   */
  private async advance(finished: PrototypeRun, succeeded: boolean) {
    const waiting = this.awaiting.get(finished.id);
    if (!waiting) return;
    return this.serializeTransition(waiting.squadRunId, async () => {
      if (this.awaiting.get(finished.id) !== waiting) return;
      this.awaiting.delete(finished.id);
      return runWithWorkspace(waiting.workspaceId, () => this.advanceInWorkspace(finished, succeeded, waiting));
    });
  }

  private async advanceInWorkspace(
    finished: PrototypeRun,
    succeeded: boolean,
    waiting: { squadRunId: string; workspaceId: string }
  ) {
    const squadRunId = waiting.squadRunId;

    const squadRun = sqliteService.getSquadRun(squadRunId);
    if (!squadRun || squadRun.status !== 'running') return;

    const now = new Date().toISOString();
    const who = nameFor(finished.agentId);
    const position = (finished.squadOrder ?? 0) + 1;
    const total = squadRun.memberAgentIds.length;

    if (!succeeded) {
      const reason = `${who} did not finish (${finished.status}). Stopped at member ${position} of ${total}.`;
      await this.persistSquadRun({ ...squadRun, status: 'failed', stoppedReason: reason, updatedAt: now }, waiting.workspaceId);
      addCommentAndShare({
        id: `comm-${squadRun.id}-stopped`,
        issueId: squadRun.issueId,
        authorType: 'system',
        authorName: 'Alpha Squad Runner',
        content: `Squad run stopped. ${reason} Work committed before the failure is on \`${squadRun.branchName}\`.`,
        createdAt: now
      });
      logInfo(`Squad run ${squadRun.id} stopped: ${reason}`);
      runnerService.emit('squad_run_failed', sqliteService.getSquadRun(squadRun.id));
      this.ticketExecutions.delete(squadRun.id);
      return;
    }

    const next = position;

    if (next >= total) {
      await this.persistSquadRun({ ...squadRun, status: 'awaiting_approval', updatedAt: now }, waiting.workspaceId);

      const runs = sqliteService.getRunsForSquadRun(squadRun.id);
      const tokens = runs.reduce((sum, r) => sum + (totalTokens(r.usage) ?? 0), 0);

      addCommentAndShare({
        id: `comm-${squadRun.id}-done`,
        issueId: squadRun.issueId,
        authorType: 'system',
        authorName: 'Alpha Squad Runner',
        content:
          `Squad run finished. ${runs.length} member(s) worked on \`${squadRun.branchName}\`:\n` +
          runs.map(r => `- ${nameFor(r.agentId)} — ${describeWork(r)}`).join('\n') +
          // Real measured usage, or nothing. See runUsage.ts — an unmeasured
          // run is not a free one, and must not be reported as zero.
          (tokens ? `\n\nTotal reported usage: ${tokens.toLocaleString()} tokens.` : ''),
        createdAt: now
      });

      logInfo(`Squad run ${squadRun.id} complete: ${runs.length} member(s), ${tokens} tokens`);
      runnerService.emit('squad_run_completed', sqliteService.getSquadRun(squadRun.id));
      this.ticketExecutions.delete(squadRun.id);
      await this.cleanupCompletedWorkspace(squadRun.id);
      return;
    }

    logInfo(`Squad run ${squadRun.id}: ${who} done, starting member ${next + 1}/${total}`);
    await this.startMember({ ...squadRun, updatedAt: now }, next, waiting.workspaceId);
  }

  /** A successful build has pushed its branch, so its disposable worktree can go. */
  private async cleanupCompletedWorkspace(squadRunId: string): Promise<void> {
    const workspace = this.runWorkspaces.get(squadRunId);
    if (!workspace) return;
    try {
      await removeDetachedWorktree(workspace.repositoryDir, workspace.workingDir);
      this.runWorkspaces.delete(squadRunId);
    } catch (error) {
      logError(`Could not clean completed build workspace ${squadRunId}:`, error);
    }
  }

  /**
   * What member `index` is told about the members before it.
   *
   * Deliberately short. Their work is committed on the branch this agent is
   * standing on, so it can read the real thing with its own tools; replaying
   * their transcripts into the prompt would cost 5k-20k tokens per member to
   * restate what `git diff` already says.
   *
   * For scale: Alpha's entire persona and memory injection measures about 165
   * tokens against a 14k-18k CLI baseline, and this is the same order.
   */
  private buildHandoff(squadRun: SquadRun, index: number): string {
    if (index === 0) return '';

    const done = sqliteService
      .getRunsForSquadRun(squadRun.id)
      .filter(r => (r.squadOrder ?? 0) < index);
    if (!done.length) return '';

    const lines = done.map(r => {
      const agent = sqliteService.getAgents().find(a => a.id === r.agentId);
      const role = agent?.role ? ` (${agent.role})` : '';
      const assignment = squadRun.memberAssignments?.find(item => item.agentId === r.agentId);
      const stage = assignment ? ` — ${assignment.stageLabel}` : '';
      const report = writtenHandoff(r);
      return `- ${agent?.name ?? r.agentId}${role}${stage}: ${report || describeWork(r)}`;
    });

    return [
      'Work already done on this branch',
      '',
      `You are member ${index + 1} of ${squadRun.memberAgentIds.length} in this squad run.`,
      `Mission: ${squadRun.mission}`,
      '',
      `Earlier members have already committed to \`${squadRun.branchName}\`, which you are on now:`,
      '',
      ...lines,
      '',
      'Read their changes before you start — `git log` and `git diff` on this branch show exactly what they did.',
      'Build on that work rather than repeating it, and do not revert it without saying why.'
    ].join('\n');
  }
}

/** Role-aware default for squads started without project-specific build steps. */
export function defaultMemberAssignment(
  agent: Agent,
  index: number,
  total: number,
  personaPrompt = agent.systemPrompt
): SquadMemberAssignment {
  const profile = `${agent.role} ${agent.name} ${agent.description} ${personaPrompt}`.toLowerCase();
  const choices: Array<{ match: RegExp; stageLabel: string; phase: BuildStepPhase; instructions: string }> = [
    { match: /research|requirements|product manager/, stageLabel: 'Requirements and research', phase: 'requirements', instructions: 'Analyze the request and repository context, state testable requirements and assumptions, and hand them to the next agent. Do not implement code.' },
    { match: /architect|architecture|solution design/, stageLabel: 'Technical design', phase: 'architecture', instructions: 'Define the affected components, interfaces, and decisions from the request and earlier handoff. Record a concise design for the next agent. Do not begin implementation.' },
    { match: /manager|planner|coordinator/, stageLabel: 'Work planning and handoff', phase: 'architecture', instructions: 'Turn the request and earlier handoff into a small, ordered work breakdown with acceptance criteria. Do not replace specialist implementation.' },
    { match: /database|data engineer|schema/, stageLabel: 'Data layer', phase: 'database', instructions: 'Implement only the necessary schema, migration, and data-access changes. Preserve compatibility and report migration checks.' },
    { match: /backend|server|api engineer/, stageLabel: 'Backend implementation', phase: 'implementation', instructions: 'Implement only the server-side behavior, API contracts, and focused tests needed for the request. Leave UI work to its specialist.' },
    { match: /frontend|front-end|ui engineer|web developer/, stageLabel: 'Frontend implementation', phase: 'implementation', instructions: 'Implement only the user-facing interface, interactions, accessibility behavior, and focused UI tests needed for the request. Build on earlier work.' },
    { match: /mobile|ios|android/, stageLabel: 'Mobile implementation', phase: 'implementation', instructions: 'Implement only the requested mobile-specific screens and behavior when the project includes a mobile client. Do not recreate the web implementation.' },
    { match: /security|reviewer|code quality/, stageLabel: 'Security and quality review', phase: 'review', instructions: 'Review the accumulated changes for defects, security issues, and maintainability concerns. Report evidence and fixes needed; do not take over implementation.' },
    { match: /validation|tester|quality assurance|\bqa\b/, stageLabel: 'Validation', phase: 'validation', instructions: 'Run relevant tests and validate the accumulated behavior against the request. Report actual evidence and failures; do not repeat implementation.' },
    { match: /github|release|delivery|devops|deployment/, stageLabel: 'Delivery readiness', phase: 'delivery', instructions: 'Check branch, CI, and delivery readiness and report blockers. Do not merge, release, or deploy without an explicit user request.' }
  ];
  // Explicit role wins over incidental references to teammates in persona prose.
  const role = String(agent.role ?? '').toLowerCase();
  const specialized = choices.find(choice => choice.match.test(role))
    ?? (role === 'coder' ? undefined : choices.find(choice => choice.match.test(profile)));
  if (specialized) return { agentId: agent.id, ...specialized };

  return {
    agentId: agent.id,
    stageLabel: `${agent.role || 'Specialist'} contribution ${index + 1} of ${total}`,
    phase: 'implementation',
    instructions: `Use your assigned persona as the authority for your contribution. Complete one focused deliverable that fits your role, build on prior agents' work, and do not repeat the full project request or take work assigned to another stage.`
  };
}

function writtenHandoff(run: PrototypeRun): string | undefined {
  const activities = run.activities ?? [];
  const response = [...activities].reverse().find(activity =>
    activity.kind === 'assistant' && !activity.isStreaming && activity.message.trim()
  ) ?? [...activities].reverse().find(activity => activity.kind === 'assistant' && activity.message.trim());
  if (!response) return undefined;
  const text = response.message.trim().replace(/\s+/g, ' ');
  return text.length > 1400 ? `${text.slice(0, 1397).trimEnd()}...` : text;
}

/** Leader first when there is one, then the rest in their configured order. */
export function orderedMembers(squad: Squad): string[] {
  const members = [...new Set(squad.memberAgentIds ?? [])];
  const leader = squad.leaderAgentId;
  if (!leader || !members.includes(leader)) return members;
  return [leader, ...members.filter(id => id !== leader)];
}

function nameFor(agentId: string): string {
  return sqliteService.getAgents().find(a => a.id === agentId)?.name ?? agentId;
}

/** One clause describing what a member run actually changed. Never invented. */
function describeWork(run: PrototypeRun): string {
  if (run.status === 'failed') return 'did not finish';
  if (!run.changedFiles) return 'made no file changes';
  return `${run.changedFiles} file(s), +${run.insertions ?? 0}/-${run.deletions ?? 0}`;
}

export const squadRunner = new SquadRunner();
