import type { OrchestrationRecoveryEpisode, ProjectOrchestrationSetting } from '../models/index.js';
import type { SQLiteService } from './sqliteService.js';
import type { OrchestrationAttemptRecord, OrchestrationSnapshot, OrchestrationTaskRecord } from './orchestrationStateMachine.js';
import type { PlannerAgentIdentity } from './orchestrationPlanner.js';
import type { BlockerResolution, BlockerResolutionInput, BlockerFix } from './blockerResolutionTurn.js';
import { runWithWorkspace } from './workspaceContext.js';
import { sameRepository } from '../utils/repositoryName.js';
import { scopeAllowsPath } from '../utils/pathScope.js';
import { logError } from '../utils/logger.js';
import { repositoryWorkspaceForTask } from './orchestrationWorkspace.js';
import { taskChangeBaseline } from './orchestrationCheckpoints.js';
import { buildTaskRequiredChecks } from './repositoryChecks.js';
import {
  MAX_REPAIR_ATTEMPTS_PER_EPISODE,
  SPECIALIST_BLOCKER_PREFIX,
  isSpecialistBlocker,
  safeRecoveryGuidance,
  safeRecoverySummary,
  workAttemptCount
} from './orchestrationRecoveryPolicy.js';
import { classifyRisk, type RepositoryPath, type RiskClassification } from './riskTier.js';
import { isSafeRelativePath, verifyCitations, type CheckpointReader } from './resolutionEvidence.js';
import { isTestFile, testFileWeakening } from './testWeakening.js';
import {
  fixGuidance,
  resolutionOf,
  withResolution,
  type ResolutionEscalation,
  type ResolutionRecord
} from './blockerResolutionRecord.js';

/**
 * Alpha resolves a stuck task on its own when the answer is in the evidence and the area is safe,
 * and asks the person only for decisions that are theirs (BLOCKER_RESOLUTION_PLAN, phases 1-2).
 *
 * The loop, run after recovery has recorded why a task stopped: gather the failure and the work,
 * ask the Orchestrator for a cited fix or a framed question, verify every citation, classify the
 * risk in code, then either send the fix to the same specialist through the normal guided retry
 * (and the unchanged acceptance gate), or leave the build waiting for the person with the
 * Orchestrator's diagnosis, its question, and any verified fix ready to apply in one step.
 */

/** At most this many Orchestrator turns per build; after that every stuck task goes to the person. */
export const MAX_RESOLUTIONS_PER_BUILD = 3;
const MAX_HANDOFF_SUMMARY_CHARS = 1_500;
const MAX_WEAKENING_READ_BYTES = 1024 * 1024;

type ResolverStore = Pick<SQLiteService,
  'getOrchestrationSnapshot' | 'getOpenOrchestrationRecoveryEpisode' | 'listOrchestrationRecoveryEpisodes' |
  'saveOrchestrationRecoveryEpisode' | 'getProjectOrchestrationSetting'>;

export interface BlockerResolutionDependencies {
  store: ResolverStore;
  planner: { resolveBlocker(input: BlockerResolutionInput): Promise<BlockerResolution> };
  /** The planning identity for this build with fresh access, or undefined when none is ready (then nothing happens). */
  plannerFor(snapshot: OrchestrationSnapshot): Promise<PlannerAgentIdentity | undefined>;
  retryTask(input: {
    workspaceId: string; runId: string; taskId: string; expectedTaskRevision: number; expectedRunRevision?: number;
    actorId: string; developerGuidance?: string;
  }): Promise<OrchestrationSnapshot>;
  git: {
    head(dir: string): Promise<string>;
    changedPaths(dir: string, from: string, to: string): Promise<string[]>;
    /** Undefined when too large; throws when the file is absent at that commit. */
    fileAtCommit(dir: string, commit: string, filePath: string, maxBytes: number): Promise<string | undefined>;
  };
  /** The team product picture for the prompt, and its settled part (no open questions) for citations. */
  productPicture(snapshot: OrchestrationSnapshot): { prompt: string; settled: string };
  repositoryMemory?(snapshot: OrchestrationSnapshot): Promise<string | undefined>;
  /** Recovery bookkeeping after the retry starts (reconcile the episode, deliver chat milestones). */
  afterRetry(snapshot: OrchestrationSnapshot): Promise<void>;
  flushMilestones(): Promise<unknown>;
  now?: () => string;
}

interface StuckTask {
  episode: OrchestrationRecoveryEpisode;
  task: OrchestrationTaskRecord;
  attempt: OrchestrationAttemptRecord;
}

interface Gathered {
  repository: string;
  changedPaths: string[];
  weakenedTests: Array<RepositoryPath & { detail: string }>;
  acceptedPaths: RepositoryPath[];
  reader: CheckpointReader;
  input: Omit<BlockerResolutionInput, 'planner' | 'productPicture' | 'repositoryMemory'>;
}

type Decision =
  | { act: true; resolution: ResolutionRecord; guidance: string }
  | { act: false; resolution: ResolutionRecord };

function taskRepository(snapshot: OrchestrationSnapshot, task: OrchestrationTaskRecord): string {
  return task.repository ?? snapshot.run.repository;
}

function latestFailedAttempt(snapshot: OrchestrationSnapshot, taskId: string): OrchestrationAttemptRecord | undefined {
  return [...snapshot.attempts].reverse().find(attempt => attempt.taskId === taskId && ['failed', 'rejected'].includes(attempt.status));
}

/** The task Alpha may resolve: a blocked build waiting on a code problem or a specialist's blocker. */
export function stuckTask(snapshot: OrchestrationSnapshot, episode: OrchestrationRecoveryEpisode | undefined): StuckTask | undefined {
  const { run } = snapshot;
  if (run.status !== 'blocked' || run.currentTaskId || run.pauseRequestedAt) return undefined;
  if (!episode?.taskId || !['waiting_for_user', 'ready_to_continue'].includes(episode.phase)) return undefined;
  const task = snapshot.tasks.find(item => item.id === episode.taskId);
  if (!task || !['failed', 'blocked'].includes(task.status)) return undefined;
  const attempt = latestFailedAttempt(snapshot, task.id);
  if (!attempt) return undefined;
  if (episode.category !== 'project_code' && !isSpecialistBlocker(attempt.failureReason)) return undefined;
  if (workAttemptCount(snapshot, task.id) >= MAX_REPAIR_ATTEMPTS_PER_EPISODE) return undefined;
  return { episode, task, attempt };
}

/** A finding's own words: its title, else its instruction, else the check that raised it. */
function findingLabel(evidence: Record<string, unknown>): string {
  const { title, instruction, check } = evidence;
  if (typeof title === 'string' && title.trim()) return title;
  if (typeof instruction === 'string') return instruction;
  return String(check ?? 'finding');
}

function findingLines(snapshot: OrchestrationSnapshot, taskId: string): string[] {
  return snapshot.findings.filter(finding => finding.taskId === taskId && finding.status === 'open').slice(0, 12).map(finding => {
    const label = findingLabel(finding.evidence);
    return safeRecoverySummary(finding.path ? `${finding.path}: ${label}` : label);
  });
}

function checkStatus(command: { exitCode?: number | null; signal?: string | null }): string {
  if (command.exitCode === 0 && !command.signal) return 'passed';
  if (command.exitCode == null) return 'not confirmed';
  return 'failed';
}

function observedChecks(attempt: OrchestrationAttemptRecord): Array<{ name: string; status: string }> {
  const verification = attempt.result?.verification as { observed?: { commands?: Array<{ script?: string; exitCode?: number | null; signal?: string | null }> } } | undefined;
  return (verification?.observed?.commands ?? []).slice(0, 16).map(command => ({
    name: String(command.script ?? 'check'),
    status: checkStatus(command)
  }));
}

function acceptedEvidencePaths(attempt: OrchestrationAttemptRecord | undefined): string[] {
  const evidence = attempt?.result?.acceptanceEvidence as { changedPaths?: unknown } | undefined;
  return Array.isArray(evidence?.changedPaths) ? evidence.changedPaths.filter((item): item is string => typeof item === 'string') : [];
}

function latestAccepted(snapshot: OrchestrationSnapshot, taskId: string): OrchestrationAttemptRecord | undefined {
  return [...snapshot.attempts].reverse().find(attempt => attempt.taskId === taskId && attempt.status === 'accepted');
}

function escalation(base: ResolutionRecord, reason: ResolutionEscalation, extra: Partial<ResolutionRecord> = {}): Decision {
  return { act: false, resolution: { ...base, ...extra, outcome: 'escalated', escalation: reason } };
}

/** Milestone text for each way a resolution ends, posted to the build's chat (team only). */
function milestoneText(taskTitle: string, record: ResolutionRecord): { key: string; content: string } | undefined {
  const subject = `“${taskTitle}”`;
  const diagnosis = record.diagnosis ? ` ${record.diagnosis}` : '';
  if (record.outcome === 'retrying') {
    return { key: 'orchestrator_resolution', content: `Alpha resolved why ${subject} stopped and sent the fix to the same specialist.${diagnosis} The result goes through the same checks and review, and this fix is listed for you at approval.` };
  }
  if (record.outcome === 'retry_failed') {
    return { key: 'orchestrator_resolution_failed', content: `Alpha's fix for ${subject} did not pass its checks, so the build waits for you.${diagnosis}` };
  }
  if (record.outcome === 'interrupted') {
    return { key: 'orchestrator_interrupted', content: `Alpha was interrupted while resolving ${subject}. It will not retry on its own; the build waits for your direction.` };
  }
  if (record.outcome !== 'escalated') return undefined;
  const options = record.question?.options.map(option => option.label).join(' / ');
  const optionList = options ? ' Options: ' + options + '.' : '';
  const openQuestion = record.question ? ' The open question: ' + record.question.text : '';
  const reasons: Record<ResolutionEscalation, string> = {
    product: `${subject} needs a product decision from you.${diagnosis} ${record.question?.text ?? ''}${optionList}`,
    sensitive: `Alpha found a fix for ${subject}, but it touches a sensitive area, so it is yours to approve.${diagnosis} You can apply the proposed fix in one step or give other direction.`,
    strict: `Alpha found a fix for ${subject} that changes earlier accepted work. This project resolves only mechanical problems on its own, so it is yours to approve.${diagnosis}`,
    unverified: `Alpha could not verify the evidence for a fix to ${subject}, so it did not act on it.${diagnosis}`,
    outside_scope: `The fix Alpha found for ${subject} would change files outside the task's scope or repository, so it did not act on it.${diagnosis}`,
    repeat: `${subject} stopped on the same problem Alpha already handled in this build, so it is yours now.${openQuestion}`,
    budget: `Alpha has resolved ${MAX_RESOLUTIONS_PER_BUILD} problems in this build already, so ${subject} waits for you.`,
    unavailable: `Alpha could not look into why ${subject} stopped, so it waits for you.${diagnosis}`,
    retry_refused: `Alpha could not start the fix for ${subject}, so it waits for you.${diagnosis}`
  };
  return { key: `orchestrator_escalation_${record.escalation ?? 'other'}`, content: reasons[record.escalation ?? 'unavailable'] };
}

export class BlockerResolutionService {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: BlockerResolutionDependencies) {}

  private now(): string { return this.deps.now?.() ?? new Date().toISOString(); }

  /** Whether the Orchestrator is looking into this build right now (this process). */
  isResolving(runId: string): boolean { return this.inFlight.has(runId); }

  /**
   * Resolve the build's stuck task if Alpha may: the run is blocked, its open recovery is waiting on
   * a code problem or a specialist blocker, the project's autonomy is not `off`, and this problem has
   * not been handled before in the build. Returns what was recorded, or undefined when nothing was.
   */
  async resolveIfStuck(snapshot: OrchestrationSnapshot): Promise<ResolutionRecord | undefined> {
    const runId = snapshot.run.id;
    if (this.inFlight.has(runId)) return undefined;
    this.inFlight.add(runId);
    try {
      return await runWithWorkspace(snapshot.run.workspaceId, () => this.resolve(runId));
    } finally {
      this.inFlight.delete(runId);
    }
  }

  /** After a restart: a resolution that was running is closed as interrupted, never retried. */
  markInterrupted(snapshot: OrchestrationSnapshot): ResolutionRecord | undefined {
    if (this.inFlight.has(snapshot.run.id)) return undefined;
    return runWithWorkspace(snapshot.run.workspaceId, () => {
      const episode = this.deps.store.getOpenOrchestrationRecoveryEpisode(snapshot.run.id);
      const record = resolutionOf(episode);
      if (!episode || record?.outcome !== 'resolving') return undefined;
      const task = snapshot.tasks.find(item => item.id === episode.taskId);
      return this.finish(episode, { ...record, outcome: 'interrupted', finishedAt: this.now() }, task?.title ?? 'this task');
    });
  }

  private async resolve(runId: string): Promise<ResolutionRecord | undefined> {
    const { store } = this.deps;
    const snapshot = store.getOrchestrationSnapshot(runId);
    if (!snapshot) return undefined;
    const episode = store.getOpenOrchestrationRecoveryEpisode(runId);
    const existing = resolutionOf(episode);
    if (episode && existing) return this.followUp(snapshot, episode, existing);
    const stuck = stuckTask(snapshot, episode);
    if (!stuck) return undefined;
    const setting = store.getProjectOrchestrationSetting(snapshot.run.projectId);
    if (setting.autonomy === 'off') return undefined;

    const base: ResolutionRecord = { outcome: 'resolving', fingerprint: stuck.episode.fingerprint, turn: false, startedAt: this.now() };
    const earlier = store.listOrchestrationRecoveryEpisodes(runId)
      .filter(item => item.id !== stuck.episode.id)
      .map(item => resolutionOf(item))
      .filter((item): item is ResolutionRecord => Boolean(item));
    const repeat = earlier.find(item => item.fingerprint === stuck.episode.fingerprint);
    if (repeat) {
      // One resolution per problem; a product question is asked once per build and not re-framed.
      const decided = escalation(base, 'repeat', { tier: repeat.tier, question: repeat.question, diagnosis: repeat.diagnosis });
      return this.finish(stuck.episode, { ...decided.resolution, finishedAt: this.now() }, stuck.task.title);
    }
    if (earlier.filter(item => item.turn).length >= MAX_RESOLUTIONS_PER_BUILD) {
      return this.finish(stuck.episode, { ...escalation(base, 'budget').resolution, finishedAt: this.now() }, stuck.task.title);
    }
    const planner = await this.deps.plannerFor(snapshot).catch(() => undefined);
    if (!planner) return undefined;

    // Mark it, so the panel says "Alpha is resolving this" and a person acting first wins the race.
    const marked = store.saveOrchestrationRecoveryEpisode({
      episode: withResolution({ ...stuck.episode, updatedAt: this.now() }, { ...base, turn: true, plannerAgentId: planner.id }),
      expectedRevision: stuck.episode.revision,
      actorId: 'orchestrator'
    }).episode;

    let decision: Decision;
    try {
      const gathered = await this.gather(snapshot, stuck);
      const picture = this.deps.productPicture(snapshot);
      const answer = await this.deps.planner.resolveBlocker({
        ...gathered.input,
        planner,
        productPicture: picture.prompt,
        repositoryMemory: await this.deps.repositoryMemory?.(snapshot).catch(() => undefined)
      });
      decision = await this.decide(resolutionOf(marked)!, answer, gathered, setting, picture.settled, stuck);
    } catch (error) {
      const detail = safeRecoverySummary(error instanceof Error ? error.message : String(error));
      decision = escalation(resolutionOf(marked)!, 'unavailable', { diagnosis: detail });
    }
    return this.apply(snapshot, marked, stuck, decision);
  }

  /** The failure, the task, its work so far and what its dependencies delivered. */
  private async gather(snapshot: OrchestrationSnapshot, stuck: StuckTask): Promise<Gathered> {
    const { run } = snapshot;
    const { task, attempt, episode } = stuck;
    const repository = taskRepository(snapshot, task);
    const workspace = repositoryWorkspaceForTask(snapshot, task.id);
    if (!workspace) throw new Error(`The repository ${repository} is not part of this build.`);
    const baseline = taskChangeBaseline(snapshot, task.id, workspace.baseCommit);
    const changedPaths = baseline && attempt.resultCommit
      ? await this.deps.git.changedPaths(workspace.worktreePath, baseline, attempt.resultCommit)
      : [];
    const weakenedTests: Gathered['weakenedTests'] = [];
    if (baseline && attempt.resultCommit) {
      const read = (commit: string, filePath: string) => this.deps.git.fileAtCommit(workspace.worktreePath, commit, filePath, MAX_WEAKENING_READ_BYTES)
        .then(content => content ?? null, () => undefined);
      for (const filePath of changedPaths.filter(item => isTestFile(item))) {
        const before = await read(baseline, filePath);
        const after = await read(attempt.resultCommit, filePath);
        const detail = before === null || after === null ? 'changed a test file too large to compare'
          : testFileWeakening(filePath, before, after);
        if (detail) weakenedTests.push({ repository, path: filePath, detail });
      }
    }
    const acceptedPaths = snapshot.tasks.filter(item => item.status === 'accepted')
      .flatMap(item => acceptedEvidencePaths(latestAccepted(snapshot, item.id)).map(filePath => ({ repository: taskRepository(snapshot, item), path: filePath })));
    const dependencyHandoffs = task.dependsOn.flatMap(id => {
      const dependency = snapshot.tasks.find(item => item.id === id && item.status === 'accepted');
      const accepted = dependency && latestAccepted(snapshot, dependency.id);
      if (!dependency || !accepted) return [];
      const summary = typeof accepted.result?.summary === 'string' ? accepted.result.summary : '';
      return [{ taskId: dependency.id, title: dependency.title, repository: taskRepository(snapshot, dependency),
        summary: summary.slice(0, MAX_HANDOFF_SUMMARY_CHARS), changedPaths: acceptedEvidencePaths(accepted).slice(0, 40) }];
    });
    const workspaces = run.repositoryWorkspaces?.length ? run.repositoryWorkspaces
      : [{ repository: run.repository, worktreePath: run.worktreePath ?? '', baseCommit: run.baseCommit ?? '' }];
    const reader: CheckpointReader = {
      checkpoint: async name => {
        const match = workspaces.find(item => sameRepository(item.repository, name));
        return match?.worktreePath ? { repository: match.repository, dir: match.worktreePath, commit: await this.deps.git.head(match.worktreePath) } : undefined;
      },
      read: (dir, commit, filePath, maxBytes) => this.deps.git.fileAtCommit(dir, commit, filePath, maxBytes)
    };
    const reason = attempt.failureReason ?? episode.summary;
    return {
      repository,
      changedPaths,
      weakenedTests,
      acceptedPaths,
      reader,
      input: {
        runId: run.id,
        usageContext: { orchestrationRunId: run.id, threadId: run.originChatThreadId, messageId: run.originBuildMessageId?.replace(/-build$/, '') },
        cwd: workspace.worktreePath,
        repositoryRoots: workspaces.filter(item => item.worktreePath).map(item => ({ name: item.repository, repo: item.repository, dir: item.worktreePath })),
        goal: run.plan.goal,
        task: {
          id: task.id, title: task.title, description: task.description, kind: task.kind, repository,
          acceptanceCriteria: task.acceptanceCriteria, requiredChecks: buildTaskRequiredChecks(snapshot, task), scope: task.scope
        },
        failure: {
          summary: safeRecoverySummary(episode.summary),
          ...(isSpecialistBlocker(reason) ? { blocker: safeRecoverySummary(reason.slice(SPECIALIST_BLOCKER_PREFIX.length)) } : {}),
          checks: observedChecks(attempt),
          findings: findingLines(snapshot, task.id),
          attemptsUsed: workAttemptCount(snapshot, task.id)
        },
        changedPaths,
        dependencyHandoffs
      }
    };
  }

  /** Whether the Orchestrator's answer may act alone, decided in code. */
  private async decide(
    base: ResolutionRecord,
    answer: BlockerResolution,
    gathered: Gathered,
    setting: ProjectOrchestrationSetting,
    settledPicture: string,
    stuck: StuckTask
  ): Promise<Decision> {
    const diagnosis = safeRecoverySummary(answer.diagnosis);
    if (answer.outcome === 'needs_owner') {
      return escalation(base, 'product', {
        tier: 3, diagnosis,
        question: { text: safeRecoverySummary(answer.question), why: safeRecoverySummary(answer.whyNotFromEvidence),
          options: answer.options.map(option => ({ label: safeRecoverySummary(option.label),
            ...(option.description ? { description: safeRecoverySummary(option.description) } : {}) })) }
      });
    }
    const check = await verifyCitations(answer.citations, { reader: gathered.reader, productPicture: settledPicture });
    const evidence = {
      diagnosis,
      citations: check.verified,
      ...(check.refused.length ? { refusedCitations: check.refused.map(item => ({ quote: item.citation.quote.slice(0, 200), reason: item.reason })) } : {})
    };
    if (check.refused.length || !check.verified.length) return escalation(base, 'unverified', evidence);
    const outside = this.outsideTask(answer, gathered, stuck.task);
    if (outside) return escalation(base, 'outside_scope', { ...evidence, reasons: [outside] });
    const risk: RiskClassification = classifyRisk({
      paths: [...gathered.changedPaths.map(filePath => ({ repository: gathered.repository, path: filePath })), ...answer.expectedFiles],
      acceptedPaths: gathered.acceptedPaths,
      texts: [gathered.input.failure.summary, gathered.input.failure.blocker ?? '', ...gathered.input.failure.findings, answer.instructions],
      weakenedTests: gathered.weakenedTests,
      projectPatterns: setting.sensitivePaths
    });
    const proposedFix = { instructions: safeRecoveryGuidance(answer.instructions), expectedFiles: answer.expectedFiles };
    const classified = { ...evidence, tier: risk.tier, classifiedPaths: risk.classifiedPaths, reasons: risk.reasons.map(reason => reason.detail).slice(0, 20) };
    if (risk.tier >= 2) return escalation(base, 'sensitive', { ...classified, proposedFix });
    if (risk.tier === 1 && setting.autonomy === 'strict') return escalation(base, 'strict', { ...classified, proposedFix });
    return {
      act: true,
      resolution: { ...base, ...classified, proposedFix, outcome: 'retrying' },
      guidance: safeRecoveryGuidance(fixGuidance(diagnosis, proposedFix, check.verified))
    };
  }

  /** A fix changes only the blocked task's own repository, inside its scope. */
  private outsideTask(answer: BlockerFix, gathered: Gathered, task: OrchestrationTaskRecord): string | undefined {
    const outside = answer.expectedFiles.find(file => !sameRepository(file.repository, gathered.repository) ||
      !isSafeRelativePath(file.path) || !scopeAllowsPath(task.scope, file.path.replace(/\\/g, '/')));
    return outside ? `${outside.repository}:${outside.path} is outside ${task.id}'s repository or path scope` : undefined;
  }

  /** Acts on the decision only if nobody touched the recovery since it was marked. */
  private async apply(snapshot: OrchestrationSnapshot, marked: OrchestrationRecoveryEpisode, stuck: StuckTask, decision: Decision): Promise<ResolutionRecord | undefined> {
    const { store } = this.deps;
    const latest = store.getOpenOrchestrationRecoveryEpisode(snapshot.run.id);
    const fresh = store.getOrchestrationSnapshot(snapshot.run.id);
    const freshTask = fresh?.tasks.find(item => item.id === stuck.task.id);
    if (!latest || latest.id !== marked.id || latest.revision !== marked.revision || !fresh ||
        fresh.run.revision !== snapshot.run.revision || freshTask?.revision !== stuck.task.revision) {
      this.supersede(latest, marked);
      return undefined;
    }
    const finishedAt = this.now();
    if (!decision.act) return this.finish(latest, { ...decision.resolution, finishedAt }, stuck.task.title);
    const started = this.finish(latest, { ...decision.resolution, finishedAt }, stuck.task.title, {
      initiatedBy: 'orchestrator', guidance: decision.guidance, phase: 'repairing'
    });
    try {
      const updated = await this.deps.retryTask({
        workspaceId: snapshot.run.workspaceId, runId: snapshot.run.id, taskId: stuck.task.id,
        expectedTaskRevision: stuck.task.revision, expectedRunRevision: snapshot.run.revision,
        actorId: 'orchestrator', developerGuidance: decision.guidance
      });
      await this.deps.afterRetry(store.getOrchestrationSnapshot(snapshot.run.id) ?? updated);
      return started;
    } catch (error) {
      const current = store.getOpenOrchestrationRecoveryEpisode(snapshot.run.id);
      if (!current || resolutionOf(current)?.outcome !== 'retrying') return started;
      const detail = safeRecoverySummary(error instanceof Error ? error.message : String(error));
      return this.finish(current, { ...decision.resolution, outcome: 'escalated', escalation: 'retry_refused', diagnosis: detail, finishedAt },
        stuck.task.title, { phase: 'waiting_for_user' });
    }
  }

  /** The Orchestrator's retry ended: record how, once. */
  private followUp(snapshot: OrchestrationSnapshot, episode: OrchestrationRecoveryEpisode, record: ResolutionRecord): ResolutionRecord | undefined {
    const task = snapshot.tasks.find(item => item.id === episode.taskId);
    if (record.outcome === 'resolving') {
      // Not running in this process (resolveIfStuck holds the run while it is), so it was interrupted.
      return this.finish(episode, { ...record, outcome: 'interrupted', finishedAt: this.now() }, task?.title ?? 'this task');
    }
    if (record.outcome !== 'retrying' || snapshot.run.status !== 'blocked' || snapshot.run.currentTaskId) return undefined;
    if (!['waiting_for_user', 'ready_to_continue'].includes(episode.phase)) return undefined;
    return this.finish(episode, { ...record, outcome: 'retry_failed', finishedAt: this.now() }, task?.title ?? 'this task', { phase: 'waiting_for_user' });
  }

  private supersede(latest: OrchestrationRecoveryEpisode | undefined, marked: OrchestrationRecoveryEpisode): void {
    const record = resolutionOf(latest);
    if (!latest || latest.id !== marked.id || record?.outcome !== 'resolving') return;
    try {
      this.deps.store.saveOrchestrationRecoveryEpisode({
        episode: withResolution(latest, { ...record, outcome: 'superseded', finishedAt: this.now() }),
        expectedRevision: latest.revision, actorId: 'orchestrator'
      });
    } catch {
      // The person is acting on it; their write wins.
    }
  }

  private finish(
    episode: OrchestrationRecoveryEpisode,
    record: ResolutionRecord,
    taskTitle: string,
    patch: Partial<Pick<OrchestrationRecoveryEpisode, 'initiatedBy' | 'guidance' | 'phase'>> = {}
  ): ResolutionRecord {
    const phase = patch.phase ?? (record.outcome === 'escalated' || record.outcome === 'interrupted' ? 'waiting_for_user' : episode.phase);
    const saved = this.deps.store.saveOrchestrationRecoveryEpisode({
      episode: withResolution({ ...episode, ...patch, phase, updatedAt: this.now() }, record),
      expectedRevision: episode.revision,
      milestone: milestoneText(taskTitle, record),
      actorId: 'orchestrator'
    });
    void this.deps.flushMilestones().catch(error => logError('Could not deliver the Orchestrator\'s build update:', error));
    return resolutionOf(saved.episode) ?? record;
  }
}
