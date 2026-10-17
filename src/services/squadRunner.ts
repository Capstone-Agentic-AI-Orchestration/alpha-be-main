import { sqliteService } from './sqliteService.js';
import { runnerService } from './runnerService.js';
import { totalTokens } from './runUsage.js';
import { logInfo, logError } from '../utils/logger.js';
import { PrototypeRun, Squad, SquadRun } from '../models/index.js';
import { addCommentAndShare } from './boardWriteThrough.js';
import { agentBranchName } from './githubRepoWorkspace.js';
import type { TicketExecutionHandle } from './ticketExecutionRelay.js';

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
  private awaiting = new Map<string, string>();
  private ticketExecutions = new Map<string, TicketExecutionHandle>();
  private wired = false;

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

    const members = orderedMembers(squad);
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

    const now = new Date().toISOString();
    const squadRun: SquadRun = {
      id: params.id ?? `squadrun-${Date.now()}`,
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
      createdAt: now,
      updatedAt: now
    };
    if (params.ticketExecution) this.ticketExecutions.set(squadRun.id, params.ticketExecution);
    sqliteService.saveSquadRun(squadRun);

    logInfo(
      `Squad "${squad.name}" starting on ${issue.identifier}: ${members.length} member(s), branch ${squadRun.branchName}`
    );

    await this.startMember(squadRun, 0);
    return sqliteService.getSquadRun(squadRun.id) ?? squadRun;
  }

  private async startMember(squadRun: SquadRun, index: number) {
    const ticketExecution = this.ticketExecutions.get(squadRun.id);
    const run = await runnerService.startRun({
      issueId: squadRun.issueId,
      agentId: squadRun.memberAgentIds[index],
      plan: squadRun.plan,
      squad: {
        squadRunId: squadRun.id,
        order: index,
        branchName: squadRun.branchName,
        handoff: this.buildHandoff(squadRun, index)
      },
      ...(ticketExecution ? { ticketExecution: { ...ticketExecution, memberOrder: index } } : {})
    });

    this.awaiting.set(run.id, squadRun.id);
    sqliteService.saveSquadRun({
      ...squadRun,
      currentMemberIndex: index,
      updatedAt: new Date().toISOString()
    });

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
    const squadRunId = this.awaiting.get(finished.id);
    this.awaiting.delete(finished.id);
    if (!squadRunId) return;

    const squadRun = sqliteService.getSquadRun(squadRunId);
    if (!squadRun || squadRun.status !== 'running') return;

    const now = new Date().toISOString();
    const who = nameFor(finished.agentId);
    const position = (finished.squadOrder ?? 0) + 1;
    const total = squadRun.memberAgentIds.length;

    if (!succeeded) {
      const reason = `${who} did not finish (${finished.status}). Stopped at member ${position} of ${total}.`;
      sqliteService.saveSquadRun({ ...squadRun, status: 'failed', stoppedReason: reason, updatedAt: now });
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
      sqliteService.saveSquadRun({ ...squadRun, status: 'awaiting_approval', updatedAt: now });

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
      return;
    }

    logInfo(`Squad run ${squadRun.id}: ${who} done, starting member ${next + 1}/${total}`);
    await this.startMember({ ...squadRun, updatedAt: now }, next);
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
      return `- ${agent?.name ?? r.agentId}${role}: ${describeWork(r)}`;
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
