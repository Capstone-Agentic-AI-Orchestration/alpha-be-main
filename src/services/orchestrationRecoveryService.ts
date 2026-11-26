import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  OrchestrationRecoveryActionName,
  OrchestrationRecoveryCategory,
  OrchestrationRecoveryEpisode,
  OrchestrationRecoveryProjection
} from '../models/index.js';
import { ALPHA_ORCHESTRATION_ENABLED, IS_CLOUD } from '../config/env.js';
import { sqliteService, type SQLiteService } from './sqliteService.js';
import type { OrchestrationSnapshot, OrchestrationAttemptRecord } from './orchestrationStateMachine.js';
import { runWithWorkspace } from './workspaceContext.js';
import { agentReadiness } from './agentReadiness.js';
import { buildFinalValidationAmendment, OrchestrationReviewPlanError } from './orchestrationReviewWorkflow.js';
import {
  AUTO_REPAIR_ATTEMPT_LIMIT,
  MAX_AUTOMATIC_REPORT_FORMAT_CORRECTIONS,
  MAX_REPORT_FORMAT_CORRECTIONS,
  MAX_RECOVERY_GUIDANCE_CHARS,
  MAX_REPAIR_ATTEMPTS_PER_EPISODE,
  classifyRecoveryCategory,
  hasRepeatedRecoveryFailure,
  hasRepairableFinalValidationEvidence,
  isContentFreeDirection,
  isSpecialistBlocker,
  recoveryFailureFingerprint,
  recoveryAvailableActions,
  recoveryErrorCode,
  reportFormatCorrectionCount,
  retirableTests,
  safeRecoveryGuidance,
  safeRecoverySummary,
  specialistBlockerDirectionMessage,
  workAttemptCount,
  REPORT_FORMAT_CHECKS
} from './orchestrationRecoveryPolicy.js';
import { fixGuidance, heldBackProposal, proposalText, resolutionOf, withResolution, type ResolutionRecord } from './blockerResolutionRecord.js';
import { PrerequisiteRefusal, buildPrerequisiteAmendment } from './prerequisiteTasks.js';
import { repositoryWorkspaceForRun } from './orchestrationWorkspace.js';
import { definedCheckScripts } from './repositoryExecution.js';

export interface OrchestrationRecoveryState {
  runId: string;
  runRevision: number;
  recovery?: OrchestrationRecoveryProjection;
  history: OrchestrationRecoveryProjection[];
}

export interface OrchestrationRecoveryActionInput {
  workspaceId: string;
  projectId: string;
  runId: string;
  recoveryId: string;
  actorId: string;
  canControl: boolean;
  expectedRunRevision: number;
  expectedRecoveryRevision: number;
  expectedTaskRevision?: number;
  idempotencyKey: string;
  action: OrchestrationRecoveryActionName;
  guidance?: string;
  threadId?: string;
}

export interface OrchestrationRecoveryActionResult {
  accepted: boolean;
  pending?: boolean;
  actionId: string;
  runStatus?: string;
  currentTaskId?: string;
  explanation?: string;
  message?: string;
  state?: OrchestrationRecoveryState;
}

const CATEGORY_EXPLANATIONS: Record<OrchestrationRecoveryCategory, string> = {
  project_code: 'The specialist saved its work, but the reported result or Alpha’s checks did not meet the task requirements. The build is keeping the saved changes so you can review or direct a bounded repair.',
  report: 'The specialist’s final report did not match the format Alpha needs to accept its work. This does not by itself mean the code is wrong. Open the result details to see the exact field; Alpha can send one more read-only correction if its first correction did not fix the report.',
  review_input: 'The reviewer could not get enough safe source material to complete an independent review. Alpha did not treat passing tests as proof that the review happened.',
  provider: 'The selected agent runtime or service could not complete the request. This points to access or availability, not a code change. Check the runtime connection, then choose Recheck and resume when it is ready.',
  configuration: 'A required project or agent setting is missing or unavailable. Update that setting first; asking a code specialist to edit project files would not fix this kind of problem.',
  workspace: 'Alpha could not confirm that the saved branch, worktree, or process still belongs to this build. It preserved the work and stopped before another specialist could write to it.',
  final_validation: 'The tasks were accepted, but the final combined checks or saved branch review did not pass. Alpha has kept the validation evidence and is waiting for a safe next step.',
  budget: 'The build reached a configured time, token, or cost limit. Alpha kept the saved work and stopped before starting another specialist.',
  alpha: 'The Alpha Orchestrator or desktop runtime is unavailable. Project agents cannot repair Alpha itself from the project repository; update or restore the desktop runtime before continuing.',
  unknown: 'The build stopped and saved the available evidence, but Alpha could not safely assign the cause to a specific repair path. Review the details before starting more work.'
};

function lastAttempt(snapshot: OrchestrationSnapshot, taskId?: string): OrchestrationAttemptRecord | undefined {
  return [...snapshot.attempts].reverse().find(attempt =>
    (!taskId || attempt.taskId === taskId) && ['failed', 'rejected', 'recovery_required'].includes(attempt.status));
}

function reportCorrectionInput(snapshot: OrchestrationSnapshot, taskId: string): {
  validationErrors: string[];
  previousResponse: string;
  startingCommit?: string;
} {
  const attempt = lastAttempt(snapshot, taskId);
  const result = attempt?.result ?? {};
  const detail = typeof result.agentReportError === 'string' ? result.agentReportError
    : typeof result.rejectionReason === 'string' ? result.rejectionReason
      : attempt?.failureReason ?? 'Alpha could not validate the specialist report.';
  const response = typeof result.agentReportResponse === 'string' ? result.agentReportResponse
    : result.agentReport && typeof result.agentReport === 'object' ? JSON.stringify(result.agentReport)
      : typeof result.summary === 'string' ? result.summary : '';
  const marker = '\n[Alpha saved only the first part of the original response.]';
  const previousResponse = result.agentReportResponseTruncated === true
    ? `${response.slice(0, Math.max(0, 12_000 - marker.length))}${marker}`
    : response.slice(0, 12_000);
  const startingCommit = typeof attempt?.contextManifest.reportOnlyBaselineCommit === 'string'
    ? attempt.contextManifest.reportOnlyBaselineCommit
    : attempt?.startingCommit;
  return { validationErrors: [safeRecoverySummary(detail)], previousResponse, startingCommit };
}

function getObservedChecks(attempt?: OrchestrationAttemptRecord): Array<{ name: string; status: string }> {
  const result = attempt?.result;
  const verification = result?.verification;
  const commands = verification && typeof verification === 'object'
    ? (verification as Record<string, unknown>).commands
    : undefined;
  if (!Array.isArray(commands)) return [];
  return commands.slice(0, 16).flatMap(command => {
    if (!command || typeof command !== 'object') return [];
    const record = command as Record<string, unknown>;
    const label = typeof record.display === 'string' ? record.display
      : typeof record.script === 'string' ? record.script : 'Verification check';
    const status = record.exitCode === 0 ? 'passed'
      : record.exitCode === null || record.exitCode === undefined ? 'not confirmed'
        : 'failed';
    return [{ name: safeRecoverySummary(label).slice(0, 120), status }];
  });
}


/**
 * The Orchestrator's record as the team sees it. Cleaned again on the way out, so a record saved
 * before the shared redaction (or by an older version) cannot show a path or credential.
 */
function resolutionProjection(record: ResolutionRecord): OrchestrationRecoveryProjection['orchestratorResolution'] {
  const question = record.question ? {
    text: safeRecoverySummary(record.question.text),
    why: safeRecoverySummary(record.question.why),
    options: record.question.options.map(option => ({ label: safeRecoverySummary(option.label),
      ...(option.description ? { description: safeRecoverySummary(option.description) } : {}) }))
  } : undefined;
  return {
    outcome: record.outcome,
    ...(record.tier !== undefined ? { tier: record.tier } : {}),
    ...(record.escalation ? { escalation: record.escalation } : {}),
    ...(record.diagnosis ? { diagnosis: safeRecoverySummary(record.diagnosis) } : {}),
    ...(question ? { question } : {}),
    ...(proposalText(record) ? { proposedFix: safeRecoveryGuidance(proposalText(record)!) } : {}),
    ...(record.citations?.length ? { evidence: record.citations.map(citation => citation.source === 'repository'
      ? safeRecoverySummary(`${citation.repository}:${citation.path}`) : 'Product record') } : {})
  };
}

/**
 * What the person's action does to the Orchestrator's record: applying its held-back fix makes the
 * fix theirs; any other step while it is still resolving overtakes it.
 */
function resolutionAfterPersonAction(episode: OrchestrationRecoveryEpisode, heldBack: ResolutionRecord | undefined, actorId: string): ResolutionRecord | undefined {
  if (heldBack) return { ...heldBack, outcome: 'retrying', appliedBy: actorId };
  const resolution = resolutionOf(episode);
  if (resolution?.outcome === 'resolving') return { ...resolution, outcome: 'superseded', finishedAt: new Date().toISOString() };
  return undefined;
}

/** Retired tests in a sentence: `tests/a.spec.ts (“one”, “two”)`, file by file. */
function retiredTestList(tests: ReadonlyArray<{ path: string; titles: string[] }>): string {
  return tests.map(item => `${item.path} (${item.titles.map(title => `“${title}”`).join(', ')})`).join('; ');
}

/** What the specialist is told when the person retired tests: which ones, and that the rest stay. */
function retiredTestsDirection(tests: ReadonlyArray<{ path: string; titles: string[] }>): string {
  return `The person retired these tests as obsolete, so they may be removed or replaced: ${retiredTestList(tests)}. Keep every other test as it was when the task started, and keep the work you already saved.`;
}

/** The chat milestone for a person's retry: an applied fix, retired tests, their direction, or a plain repair. */
function personActionMilestone(input: {
  action: OrchestrationRecoveryActionName; heldBack: boolean; guidance?: string; summary: string; taskTitle?: string;
  retired?: ReadonlyArray<{ path: string; titles: string[] }>;
}): { key: string; content: string } | undefined {
  const subject = input.taskTitle ? '“' + input.taskTitle + '”' : 'this build';
  if (input.retired?.length) {
    const count = input.retired.reduce((total, item) => total + item.titles.length, 0);
    return { key: 'tests_retired', content: safeRecoverySummary(`You retired ${count === 1 ? 'an obsolete test' : `${count} obsolete tests`} for ${subject}: ${retiredTestList(input.retired)}. The same specialist is retrying; every other test is still held to the test guard.`) };
  }
  if (input.heldBack) {
    return { key: 'proposed_fix_applied', content: `You applied the Orchestrator's proposed fix for ${subject}. The same specialist is retrying with it; the result goes through the same checks and review.` };
  }
  if (input.action === 'provide_guidance' || input.guidance) {
    return { key: 'guidance_received', content: `Direction received for ${subject}: ${safeRecoverySummary(input.guidance ?? '')} Alpha will keep the approved task and repository boundaries.` };
  }
  return milestoneFor('repairing', input.summary, input.taskTitle);
}

function publicProjection(
  snapshot: OrchestrationSnapshot,
  episode: OrchestrationRecoveryEpisode,
  canControl: boolean
): OrchestrationRecoveryProjection {
  const task = episode.taskId ? snapshot.tasks.find(item => item.id === episode.taskId) : undefined;
  const resolution = resolutionOf(episode);
  const actionState = recoveryAvailableActions({
    snapshot,
    category: episode.category,
    taskId: episode.taskId,
    canControl,
    episodeAgeMs: Math.max(0, Date.now() - Date.parse(episode.createdAt)),
    repeatedFailure: episode.evidence.repeatedFailure === true,
    finalValidationCorrectionReady: episode.evidence.finalValidationCorrectionReady === true,
    finalValidationCorrectionReason: typeof episode.evidence.finalValidationCorrectionError === 'string'
      ? episode.evidence.finalValidationCorrectionError : undefined,
    proposedFixReady: Boolean(heldBackProposal(episode))
  });
  return {
    id: episode.id,
    runId: episode.runId,
    phase: episode.phase,
    category: episode.category,
    code: episode.code,
    summary: safeRecoverySummary(episode.summary),
    taskId: episode.taskId,
    taskTitle: task?.title,
    taskRevision: task?.revision,
    attemptsUsed: episode.attemptsUsed,
    repairBudget: episode.repairBudget,
    ...(task && episode.category === 'report' ? {
      reportCorrectionsUsed: reportFormatCorrectionCount(snapshot, task.id),
      reportCorrectionLimit: MAX_REPORT_FORMAT_CORRECTIONS
    } : {}),
    episodeNumber: episode.episodeNumber,
    revision: episode.revision,
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
    availableActions: actionState.availableActions,
    actionReasons: actionState.actionReasons,
    ...(task && actionState.availableActions.includes('retire_tests') ? {
      retirableTests: retirableTests(snapshot, task.id).map(item => ({ path: safeRecoverySummary(item.path), titles: item.titles.map(safeRecoverySummary) }))
    } : {}),
    ...(resolution?.outcome === 'resolving' ? { resolving: true } : {}),
    ...(resolution ? { orchestratorResolution: resolutionProjection(resolution) } : {})
  };
}

function milestoneFor(
  phase: OrchestrationRecoveryEpisode['phase'],
  summary: string,
  taskTitle?: string,
  reportCorrectionsUsed?: number,
  reportCorrectionAvailable = false,
  finalValidationCorrectionError?: string,
  recoveryCategory?: OrchestrationRecoveryCategory,
  workAttemptsUsed?: number,
  repeatedFailure = false
): { key: string; content: string } | undefined {
  const subject = taskTitle ? `“${taskTitle}”` : 'the final build checks';
  if (phase === 'repairing') {
    const reportCorrection = reportCorrectionsUsed !== undefined
      ? reportCorrectionsUsed <= MAX_AUTOMATIC_REPORT_FORMAT_CORRECTIONS
        ? ` Alpha sent the same specialist read-only report correction ${reportCorrectionsUsed} of ${MAX_AUTOMATIC_REPORT_FORMAT_CORRECTIONS}.`
        : ` Alpha sent the same specialist your authorized read-only report correction ${reportCorrectionsUsed} of ${MAX_REPORT_FORMAT_CORRECTIONS}.`
      : '';
    return {
      key: reportCorrectionsUsed !== undefined ? `report_correction_${reportCorrectionsUsed}` : 'repair_started',
      content: `Alpha started a bounded recovery step for ${subject}.${reportCorrection} The issue detected was: ${summary} It will check the new result before handing work to another specialist.`
    };
  }
  if (phase === 'ready_to_continue') return { key: 'failure_captured', content: `The build stopped at ${subject}. Alpha saved the work and failure details. ${summary}` };
  if (phase === 'waiting_for_user') {
    const nextStep = recoveryCategory === 'project_code' && repeatedFailure
      ? 'The same failure returned after a focused repair, so Alpha stopped early. Review the saved changes and direct the next step in this chat.'
      : recoveryCategory === 'project_code' && (workAttemptsUsed ?? 0) >= AUTO_REPAIR_ATTEMPT_LIMIT
        ? 'Alpha used the original attempt and both automatic repairs. It preserved the latest work and will wait for your direction before another attempt.'
      : reportCorrectionsUsed === undefined
      ? 'Alpha preserved the current work and will not start another repair without your direction.'
      : reportCorrectionAvailable
        ? 'Alpha preserved the code work. Review this exact report error and choose whether to send one more bounded, read-only correction from this chat.'
        : 'Alpha preserved the code work. The bounded report-correction limit is exhausted; review the saved response and decide whether to keep the build paused or start a fresh request.';
    const planningNote = finalValidationCorrectionError
      ? ` Alpha could not safely assign an automatic correction: ${safeRecoverySummary(finalValidationCorrectionError)}.`
      : '';
    return {
      key: 'developer_action_needed',
      content: `The build is waiting for your decision at ${subject}. The issue is: ${summary} ${nextStep}${planningNote}`
    };
  }
  if (phase === 'resolved') return { key: 'recovery_resolved', content: `The recovery at ${subject} passed its acceptance checks. The build has continued from the saved checkpoint.` };
  if (phase === 'cancelled') return { key: 'build_cancelled', content: 'The build was stopped at your request. Alpha kept the saved work and recovery history.' };
  return undefined;
}

export class OrchestrationRecoveryService {
  constructor(private readonly store: SQLiteService = sqliteService) {}

  async getState(input: { workspaceId: string; runId: string; canControl: boolean }): Promise<OrchestrationRecoveryState> {
    return runWithWorkspace(input.workspaceId, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot) throw new Error('Task build not found.');
      const canControl = input.canControl && !IS_CLOUD && ALPHA_ORCHESTRATION_ENABLED;
      const latest = this.syncSnapshot(snapshot, 'orchestrator');
      await this.flushPendingMilestones();
      const fresh = this.store.getOrchestrationSnapshot(input.runId) ?? snapshot;
      const episodes = this.store.listOrchestrationRecoveryEpisodes(input.runId);
      return {
        runId: input.runId,
        runRevision: fresh.run.revision,
        recovery: latest ? publicProjection(fresh, latest, canControl) : undefined,
        history: episodes.slice().reverse().map(episode => publicProjection(fresh, episode, canControl))
      };
    });
  }

  reconcileSnapshot(snapshot: OrchestrationSnapshot, actorId = 'orchestrator'): OrchestrationRecoveryEpisode | undefined {
    return runWithWorkspace(snapshot.run.workspaceId, () => this.syncSnapshot(snapshot, actorId));
  }

  private syncSnapshot(snapshot: OrchestrationSnapshot, actorId: string): OrchestrationRecoveryEpisode | undefined {
    const workspaceId = snapshot.run.workspaceId;
    const binding = this.store.getOrchestrationChatBinding(snapshot.run.id);
    const currentEpisode = this.store.getOpenOrchestrationRecoveryEpisode(snapshot.run.id);
    const latestBlockedEvent = this.store.listOrchestrationEvents(snapshot.run.id, 0, 500).slice().reverse()
      .find(event => event.type === 'run_blocked' || event.type === 'run_recovery_required' || event.type === 'run_failed');
    const validationEvidence = latestBlockedEvent?.payload.evidence && typeof latestBlockedEvent.payload.evidence === 'object'
      ? latestBlockedEvent.payload.evidence as Record<string, unknown>
      : undefined;
    // A missing or changed working copy at final checks is repaired by checking again (rebuild,
    // or set the changes aside); only a changed file no task owns needs the person.
    const workspaceValidation = String(validationEvidence?.check ?? '') === 'final_scope';
    const finalValidationCorrectionRunning = snapshot.run.status === 'executing' && Boolean(snapshot.run.currentTaskId) &&
      snapshot.findings.some(finding => finding.status === 'open' && finding.evidence.origin === 'final_validation');
    const finalValidation = (snapshot.run.status === 'blocked' || finalValidationCorrectionRunning) &&
      validationEvidence?.validationVersion === 1 && !workspaceValidation;
    let finalValidationCorrectionReady = false;
    let finalValidationCorrectionError: string | undefined;
    if (finalValidation && snapshot.run.status === 'blocked' && hasRepairableFinalValidationEvidence(validationEvidence)) {
      try {
        buildFinalValidationAmendment(
          snapshot,
          validationEvidence!,
          this.store.getAgents().filter(agent => !agent.isArchived).map(agent => ({ id: agent.id, role: agent.role }))
        );
        finalValidationCorrectionReady = true;
      } catch (error) {
        finalValidationCorrectionError = error instanceof OrchestrationReviewPlanError
          ? error.message
          : error instanceof Error ? error.message : 'Alpha could not safely assign a correction to the affected code owners.';
      }
    } else if (finalValidation && !hasRepairableFinalValidationEvidence(validationEvidence)) {
      finalValidationCorrectionError = 'The saved checks do not identify a failed command that can be safely assigned to an implementation owner.';
    }

    const failingTasks = snapshot.tasks.filter(task => ['failed', 'blocked'].includes(task.status));
    const failedTask = [...failingTasks].reverse().find(task => lastAttempt(snapshot, task.id)) ?? failingTasks.at(-1);
    const activeTaskWithFailureHistory = snapshot.run.status === 'executing' && snapshot.run.currentTaskId &&
      lastAttempt(snapshot, snapshot.run.currentTaskId)
      ? snapshot.run.currentTaskId
      : undefined;
    const targetTaskId = failedTask?.id ?? currentEpisode?.taskId ?? activeTaskWithFailureHistory ??
      (finalValidationCorrectionRunning ? snapshot.run.currentTaskId ?? undefined : undefined);
    const previousFailedAttempt = lastAttempt(snapshot, targetTaskId);
    const activeAttempt = targetTaskId
      ? [...snapshot.attempts].reverse().find(attempt => attempt.taskId === targetTaskId && ['starting', 'running', 'submitted'].includes(attempt.status))
      : undefined;
    const isRepairing = (snapshot.run.status === 'executing' && snapshot.run.currentTaskId === targetTaskId &&
      Boolean(activeAttempt) && Boolean(previousFailedAttempt)) || finalValidationCorrectionRunning;
    const taskAccepted = targetTaskId ? snapshot.tasks.find(task => task.id === targetTaskId)?.status === 'accepted' : false;
    const terminalSuccess = ['awaiting_approval', 'publishing', 'completed'].includes(snapshot.run.status);
    const terminalCancel = snapshot.run.status === 'cancelled';
    if (terminalCancel && currentEpisode) {
      const timestamp = new Date().toISOString();
      const reportCorrectionsUsed = currentEpisode.category === 'report' && currentEpisode.taskId
        ? reportFormatCorrectionCount(snapshot, currentEpisode.taskId)
        : undefined;
      const saved = this.store.saveOrchestrationRecoveryEpisode({
        episode: { ...currentEpisode, phase: 'cancelled', updatedAt: timestamp, resolvedAt: timestamp },
        expectedRevision: currentEpisode.revision,
        milestone: milestoneFor('cancelled', currentEpisode.summary,
          currentEpisode.taskId ? snapshot.tasks.find(task => task.id === currentEpisode.taskId)?.title : undefined,
          reportCorrectionsUsed),
        actorId
      });
      return saved.episode;
    }
    // A stopped build keeps its failed task as history and gets no new recovery. Opening one here
    // would be closed again by the cancel above on the next check, posting both chat messages each
    // time; every build review refresh runs this check, so the pair repeated about once a second.
    if (terminalCancel) return undefined;
    const currentFailure = Boolean(failedTask || finalValidation ||
      ['blocked', 'recovery_required', 'failed'].includes(snapshot.run.status));

    if (!currentFailure && currentEpisode) {
      const shouldResolve = taskAccepted || terminalSuccess || (snapshot.run.status === 'executing' &&
        snapshot.run.currentTaskId !== currentEpisode.taskId);
      const nextPhase = terminalCancel ? 'cancelled' : shouldResolve ? 'resolved'
        : isRepairing ? 'repairing' : snapshot.run.status === 'paused' ? 'waiting_for_user' : currentEpisode.phase;
      const taskTitle = currentEpisode.taskId ? snapshot.tasks.find(task => task.id === currentEpisode.taskId)?.title : undefined;
      const reportCorrectionsUsed = currentEpisode.category === 'report' && currentEpisode.taskId
        ? reportFormatCorrectionCount(snapshot, currentEpisode.taskId)
        : undefined;
      const repeatedReportCorrection = isRepairing && nextPhase === 'repairing' && reportCorrectionsUsed !== undefined
        ? milestoneFor(nextPhase, currentEpisode.summary, taskTitle, reportCorrectionsUsed)
        : undefined;
      if (nextPhase !== currentEpisode.phase || repeatedReportCorrection) {
        // An Orchestrator fix that passed acceptance is recorded as such, for the approval list.
        const resolution = resolutionOf(currentEpisode);
        const resolved = nextPhase === 'resolved' && resolution?.outcome === 'retrying'
          ? withResolution(currentEpisode, { ...resolution, outcome: 'retry_accepted', finishedAt: new Date().toISOString() })
          : currentEpisode;
        const saved = this.store.saveOrchestrationRecoveryEpisode({
          episode: {
            ...resolved,
            phase: nextPhase,
            attemptsUsed: currentEpisode.taskId ? workAttemptCount(snapshot, currentEpisode.taskId) : currentEpisode.attemptsUsed,
            updatedAt: new Date().toISOString(),
            resolvedAt: ['resolved', 'cancelled'].includes(nextPhase) ? new Date().toISOString() : undefined
          },
          milestone: repeatedReportCorrection ?? (nextPhase !== currentEpisode.phase
            ? milestoneFor(nextPhase, currentEpisode.summary, taskTitle, reportCorrectionsUsed,
              currentEpisode.category === 'report' && currentEpisode.taskId !== undefined &&
                reportFormatCorrectionCount(snapshot, currentEpisode.taskId) < MAX_REPORT_FORMAT_CORRECTIONS,
              undefined,
              currentEpisode.category,
              currentEpisode.taskId ? workAttemptCount(snapshot, currentEpisode.taskId) : currentEpisode.attemptsUsed,
              currentEpisode.evidence.repeatedFailure === true)
            : undefined),
          actorId
        });
        return saved.episode;
      }
      return currentEpisode;
    }

    if (!currentFailure && !isRepairing) return currentEpisode;

    const evidenceAttempt = previousFailedAttempt;
    const episodeTask = failedTask ?? (targetTaskId ? snapshot.tasks.find(task => task.id === targetTaskId) : undefined);
    const result = evidenceAttempt?.result ?? {};
    const rejectionReason = typeof result.rejectionReason === 'string' ? result.rejectionReason : undefined;
    const reportError = typeof result.agentReportError === 'string' ? result.agentReportError : undefined;
    const reportFindingChecks = REPORT_FORMAT_CHECKS;
    const hasReportFinding = Boolean(episodeTask && snapshot.findings.some(finding =>
      finding.taskId === episodeTask.id && finding.status === 'open' &&
      (!evidenceAttempt || finding.createdAt >= evidenceAttempt.createdAt) &&
      typeof finding.evidence.check === 'string' && reportFindingChecks.has(finding.evidence.check)
    ));
    const validationReason = typeof latestBlockedEvent?.payload.reason === 'string' ? latestBlockedEvent.payload.reason
      : typeof (validationEvidence?.checks as Record<string, unknown> | undefined)?.summary === 'string'
        ? (validationEvidence!.checks as Record<string, unknown>).summary as string
        : undefined;
    const reason = safeRecoverySummary(finalValidation ? validationReason ?? snapshot.run.stoppedReason ??
      'Final validation stopped the build.' : evidenceAttempt?.failureReason ?? rejectionReason ?? reportError ??
      snapshot.run.stoppedReason ?? 'The build stopped before the next specialist could safely start.');
    const category = classifyRecoveryCategory({
      reason,
      taskKind: episodeTask?.kind,
      hasTask: Boolean(episodeTask),
      hasReportError: Boolean(reportError || hasReportFinding),
      finalValidation
    });
    const source = finalValidation ? 'final_validation'
      : evidenceAttempt?.contextManifest.orchestrationPreparationFailed === true ? 'preparation'
      : evidenceAttempt?.status === 'rejected' ? 'acceptance'
        : evidenceAttempt?.status === 'recovery_required' ? 'restart'
          : evidenceAttempt ? 'runner' : 'preparation';
    const code = recoveryErrorCode(category, source);
    const attemptsUsed = episodeTask ? workAttemptCount(snapshot, episodeTask.id) : currentEpisode?.attemptsUsed ?? 0;
    const repeatedFailure = episodeTask ? hasRepeatedRecoveryFailure(snapshot, episodeTask.id, category, reason) : false;
    const phase: OrchestrationRecoveryEpisode['phase'] = isRepairing ? 'repairing'
      : currentEpisode?.phase === 'waiting_for_user' ? 'waiting_for_user'
      : ['provider', 'configuration', 'workspace', 'review_input', 'report', 'alpha', 'final_validation'].includes(category) ||
        attemptsUsed >= AUTO_REPAIR_ATTEMPT_LIMIT || repeatedFailure || snapshot.run.status === 'recovery_required'
        ? 'waiting_for_user' : 'ready_to_continue';
    const summary = reason || 'The build stopped. Review the saved details before continuing.';
    const reportTaskId = category === 'report' ? episodeTask?.id ?? targetTaskId : undefined;
    const reportCorrectionsUsed = reportTaskId
      ? reportFormatCorrectionCount(snapshot, reportTaskId)
      : undefined;
    const fingerprint = recoveryFailureFingerprint(category, summary);
    const timestamp = new Date().toISOString();
    const episode: OrchestrationRecoveryEpisode = currentEpisode ? {
      ...currentEpisode,
      taskId: episodeTask?.id ?? currentEpisode.taskId,
      attemptId: evidenceAttempt?.id ?? currentEpisode.attemptId,
      source,
      category,
      code,
      summary,
      fingerprint,
      phase,
      attemptsUsed,
      evidence: {
        workAttempts: attemptsUsed,
        repairBudget: MAX_REPAIR_ATTEMPTS_PER_EPISODE,
        observedChecks: getObservedChecks(evidenceAttempt),
        repository: snapshot.run.repository,
        repeatedFailure,
        ...(finalValidation ? { finalValidationCorrectionReady, ...(finalValidationCorrectionError ? { finalValidationCorrectionError } : {}) } : {}),
        // What the Orchestrator did about this recovery outlives each refreshed failure detail.
        ...(currentEpisode.evidence.resolution ? { resolution: currentEpisode.evidence.resolution } : {})
      },
      threadId: binding?.threadId ?? currentEpisode.threadId,
      buildMessageId: binding?.buildMessageId ?? currentEpisode.buildMessageId,
      updatedAt: timestamp,
      resolvedAt: undefined
    } : {
      id: `recovery-${randomUUID()}`,
      workspaceId,
      projectId: snapshot.run.projectId,
      runId: snapshot.run.id,
      issueId: snapshot.run.issueId,
      taskId: episodeTask?.id,
      attemptId: evidenceAttempt?.id,
      source,
      category,
      code,
      summary,
      fingerprint,
      phase,
      episodeNumber: this.store.listOrchestrationRecoveryEpisodes(snapshot.run.id).length + 1,
      repairBudget: MAX_REPAIR_ATTEMPTS_PER_EPISODE,
      attemptsUsed,
      evidence: {
        workAttempts: attemptsUsed,
        repairBudget: MAX_REPAIR_ATTEMPTS_PER_EPISODE,
        observedChecks: getObservedChecks(evidenceAttempt),
        repository: snapshot.run.repository,
        repeatedFailure,
        ...(finalValidation ? { finalValidationCorrectionReady, ...(finalValidationCorrectionError ? { finalValidationCorrectionError } : {}) } : {})
      },
      threadId: binding?.threadId,
      buildMessageId: binding?.buildMessageId,
      initiatedBy: snapshot.run.createdBy,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const taskTitle = episodeTask?.title ?? (finalValidation ? 'Final validation' : undefined);
    const reportCorrectionAvailable = reportCorrectionsUsed !== undefined && reportCorrectionsUsed < MAX_REPORT_FORMAT_CORRECTIONS;
    const milestone = phase === 'repairing' && reportCorrectionsUsed !== undefined
      ? milestoneFor(phase, summary, taskTitle, reportCorrectionsUsed)
      : currentEpisode?.phase === phase && currentEpisode.fingerprint === fingerprint &&
          currentEpisode.attemptId === evidenceAttempt?.id && currentEpisode.attemptsUsed === attemptsUsed
        ? undefined
        : milestoneFor(phase, summary, taskTitle, reportCorrectionsUsed, reportCorrectionAvailable,
          finalValidationCorrectionError, category, attemptsUsed, repeatedFailure);
    const distinctMilestone = milestone && currentEpisode
      ? { ...milestone, key: `${milestone.key}_run_${snapshot.run.revision}` }
      : milestone;
    const saved = this.store.saveOrchestrationRecoveryEpisode({
      episode,
      expectedRevision: currentEpisode?.revision,
      milestone: distinctMilestone,
      actorId
    });
    return saved.episode;
  }

  explain(episode: OrchestrationRecoveryEpisode): string {
    // When the Orchestrator looked into it, its diagnosis and question explain it, not the raw error.
    const resolution = resolutionOf(episode);
    if (resolution?.diagnosis && ['escalated', 'retry_failed'].includes(resolution.outcome)) {
      const question = resolution.question ? ` ${resolution.question.text}` : '';
      let fix = '';
      if (resolution.proposedFix) fix = ' Alpha has a verified fix ready for you to apply.';
      else if (resolution.proposedPrerequisite) fix = ' Alpha has the missing work ready for you to add.';
      return `The Orchestrator looked into this: ${resolution.diagnosis}${question}${fix}`.trim();
    }
    return `${CATEGORY_EXPLANATIONS[episode.category]} ${safeRecoverySummary(episode.summary)}`.trim();
  }

  async executeAction(input: OrchestrationRecoveryActionInput): Promise<OrchestrationRecoveryActionResult> {
    const readOnlyAction = input.action === 'explain_failure' || input.action === 'review_saved_changes';
    if (IS_CLOUD || (!ALPHA_ORCHESTRATION_ENABLED && !readOnlyAction) || (!input.canControl && !readOnlyAction)) {
      throw new Error('This desktop or project role cannot change the build right now.');
    }
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(input.idempotencyKey)) throw new Error('A valid action key is required.');
    const guidance = input.guidance?.trim() ? safeRecoveryGuidance(input.guidance.trim()) : undefined;
    if (input.guidance && input.guidance.trim().length > MAX_RECOVERY_GUIDANCE_CHARS) {
      throw new Error(`Keep your direction under ${MAX_RECOVERY_GUIDANCE_CHARS.toLocaleString()} characters.`);
    }
    if (input.action === 'provide_guidance' && !guidance) throw new Error('Add the direction you want Alpha to follow before retrying.');

    return runWithWorkspace(input.workspaceId, async () => {
      const snapshot = this.store.getOrchestrationSnapshot(input.runId);
      if (!snapshot || snapshot.run.projectId !== input.projectId) throw new Error('Task build not found in this project.');
      const binding = this.store.getOrchestrationChatBinding(input.runId);
      if (input.threadId && (!binding || binding.threadId !== input.threadId || binding.ownerId !== input.actorId)) {
        throw new Error('This recovery action is not attached to your project conversation.');
      }
      const episode = this.store.getOrchestrationRecoveryEpisode(input.runId, input.recoveryId);
      if (!episode) throw new Error('Recovery episode not found. Refresh the build.');
      const created = this.store.createOrchestrationRecoveryAction({
        id: `recovery-action-${randomUUID()}`,
        runId: input.runId,
        recoveryId: episode.id,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        expectedRunRevision: input.expectedRunRevision,
        expectedRecoveryRevision: input.expectedRecoveryRevision,
        expectedTaskRevision: input.expectedTaskRevision,
        action: input.action,
        guidance,
        now: new Date().toISOString()
      });
      if (!created.created) {
        if (created.action.status === 'completed') {
          const result = created.action.result ?? {};
          return {
            accepted: true,
            actionId: created.action.id,
            explanation: typeof result.explanation === 'string' ? result.explanation : undefined,
            message: typeof result.message === 'string' ? result.message : undefined,
            runStatus: typeof result.runStatus === 'string' ? result.runStatus : undefined,
            currentTaskId: typeof result.currentTaskId === 'string' ? result.currentTaskId : undefined
          };
        }
        if (created.action.status === 'pending') return {
          accepted: true, pending: true, actionId: created.action.id,
          message: 'This action is already being processed. Refresh the build to see its result.'
        };
        throw new Error('This recovery action was already processed. Refresh the build for its saved result.');
      }

      try {
        if (snapshot.run.revision !== input.expectedRunRevision || episode.revision !== input.expectedRecoveryRevision) {
          throw new Error('The build changed since you opened this recovery. Refresh before acting.');
        }
        const projection = publicProjection(snapshot, episode, input.canControl);
        if (!projection.availableActions.includes(input.action)) {
          const why = projection.actionReasons[input.action];
          throw new Error(why ?? 'That action is not available for this build state.');
        }
        const actionTask = episode.taskId ? snapshot.tasks.find(task => task.id === episode.taskId) : undefined;
        if (actionTask && input.expectedTaskRevision !== actionTask.revision) throw new Error('This task changed. Refresh before acting.');
        const latestFailure = actionTask ? [...snapshot.attempts].reverse().find(attempt => attempt.taskId === actionTask.id &&
          ['failed', 'rejected', 'recovery_required'].includes(attempt.status))?.failureReason : undefined;
        if (input.action === 'provide_guidance' && isSpecialistBlocker(latestFailure) && isContentFreeDirection(guidance)) {
          throw new Error(specialistBlockerDirectionMessage(latestFailure!));
        }
        if (input.action === 'explain_failure') {
          const explanation = this.explain(episode);
          this.store.saveOrchestrationRecoveryEpisode({
            episode,
            expectedRevision: episode.revision,
            milestone: { key: `explanation_${created.action.id}`, content: `Cause: ${explanation}` },
            actorId: input.actorId
          });
          await this.flushPendingMilestones();
          this.store.finishOrchestrationRecoveryAction({
            recoveryId: episode.id, idempotencyKey: input.idempotencyKey, actorId: input.actorId,
            status: 'completed', result: { explanation }
          });
          return { accepted: true, actionId: created.action.id, explanation };
        }
        if (input.action === 'review_saved_changes') {
          const message = 'Review the saved branch, task evidence, and changed files in this chat.';
          this.store.finishOrchestrationRecoveryAction({
            recoveryId: episode.id, idempotencyKey: input.idempotencyKey, actorId: input.actorId,
            status: 'completed', result: { message }
          });
          return { accepted: true, actionId: created.action.id, message };
        }
        if (input.action === 'keep_paused') {
          const held = this.store.saveOrchestrationRecoveryEpisode({
            episode: { ...episode, phase: 'waiting_for_user', updatedAt: new Date().toISOString() },
            expectedRevision: episode.revision,
            actorId: input.actorId
          });
          const message = 'The build remains paused with its saved work. Alpha will wait for your next direction.';
          this.store.finishOrchestrationRecoveryAction({
            recoveryId: episode.id, idempotencyKey: input.idempotencyKey, actorId: input.actorId,
            status: 'completed', result: { message, recoveryRevision: held.episode.revision }
          });
          return { accepted: true, actionId: created.action.id, message };
        }

        const heldBack = input.action === 'apply_proposed_fix' ? heldBackProposal(episode) : undefined;
        if (input.action === 'apply_proposed_fix' && !heldBack) throw new Error('There is no proposed fix to apply. Refresh the build.');
        if (heldBack?.proposedPrerequisite) {
          return await this.addHeldBackPrerequisite({ input, snapshot, episode, heldBack, actionId: created.action.id });
        }
        // Retiring tests is the person's call on exactly the tests this stop named, read again now.
        const retiring = input.action === 'retire_tests' && actionTask ? retirableTests(snapshot, actionTask.id) : [];
        if (input.action === 'retire_tests' && !retiring.length) throw new Error('This stop names no tests to retire. Refresh the build.');
        const retryDirection = heldBack ? safeRecoveryGuidance(fixGuidance(heldBack.diagnosis, heldBack.proposedFix!, heldBack.citations))
          : retiring.length ? safeRecoveryGuidance(retiredTestsDirection(retiring)) : guidance;
        const resolutionAfterAction = resolutionAfterPersonAction(episode, heldBack, input.actorId);
        const actedEpisode = resolutionAfterAction ? withResolution(episode, resolutionAfterAction) : episode;
        const startedEpisode = this.store.saveOrchestrationRecoveryEpisode({
          episode: {
            ...actedEpisode,
            phase: 'repairing',
            attemptsUsed: episode.taskId ? workAttemptCount(snapshot, episode.taskId) : episode.attemptsUsed,
            guidance: retryDirection,
            updatedAt: new Date().toISOString(),
            resolvedAt: undefined
          },
          expectedRevision: episode.revision,
          milestone: personActionMilestone({ action: input.action, heldBack: Boolean(heldBack), guidance, summary: episode.summary, taskTitle: actionTask?.title, retired: retiring }),
          actorId: input.actorId
        }).episode;
        const { orchestrationService, taskAcceptanceService } = await import('./orchestrationRuntime.js');
        let updated: OrchestrationSnapshot;
        if (input.action === 'cancel_build') {
          updated = await orchestrationService.cancelRun({
            workspaceId: input.workspaceId, runId: input.runId, actorId: input.actorId,
            expectedRevision: input.expectedRunRevision
          });
        } else if (input.action === 'resume_checkpoint') {
          updated = await orchestrationService.resume({
            workspaceId: input.workspaceId, runId: input.runId, actorId: input.actorId,
            expectedRunRevision: input.expectedRunRevision
          });
        } else if (input.action === 'recheck_prerequisite' && episode.category === 'final_validation') {
          updated = await orchestrationService.retryFinalValidation({
            workspaceId: input.workspaceId, runId: input.runId, actorId: input.actorId,
            expectedRunRevision: input.expectedRunRevision
          });
          if (updated.run.status === 'validating') {
            const outcome = await taskAcceptanceService.validateFinalState({
              workspaceId: input.workspaceId, runId: input.runId, actorId: input.actorId
            });
            updated = outcome.snapshot;
          }
        } else if (input.action === 'plan_final_validation_corrections' && episode.category === 'final_validation') {
          const validationEvent = this.store.listOrchestrationEvents(input.runId, 0, 500).slice().reverse().find(event =>
            ['run_blocked', 'run_recovery_required'].includes(event.type) && event.payload.evidence &&
            typeof event.payload.evidence === 'object' &&
            (event.payload.evidence as Record<string, unknown>).validationVersion === 1);
          const evidence = validationEvent?.payload.evidence && typeof validationEvent.payload.evidence === 'object'
            ? validationEvent.payload.evidence as Record<string, unknown>
            : undefined;
          if (!evidence || !hasRepairableFinalValidationEvidence(evidence)) {
            throw new Error('The saved final-check evidence no longer supports an automatic owner correction. Review it before continuing.');
          }
          let amendment;
          try {
            amendment = buildFinalValidationAmendment(
              snapshot,
              evidence,
              this.store.getAgents().filter(agent => !agent.isArchived).map(agent => ({ id: agent.id, role: agent.role }))
            );
          } catch (error) {
            if (error instanceof OrchestrationReviewPlanError) throw new Error(error.message);
            throw error;
          }
          updated = await orchestrationService.amendFinalValidation({
            workspaceId: input.workspaceId, runId: input.runId, actorId: input.actorId,
            expectedRunRevision: input.expectedRunRevision, amendment, evidence
          });
        } else if (input.action === 'recheck_prerequisite' && episode.category === 'budget') {
          updated = await orchestrationService.resume({
            workspaceId: input.workspaceId, runId: input.runId, actorId: input.actorId,
            expectedRunRevision: input.expectedRunRevision
          });
        } else if (input.action === 'recheck_prerequisite' && ['provider', 'configuration'].includes(episode.category)) {
          if (!actionTask) throw new Error('This recovery has no assigned runtime to recheck.');
          const agent = this.store.getAgents().find(item => item.id === actionTask.ownerAgentId);
          if (!agent) throw new Error('The assigned specialist is no longer available. Update the plan before continuing.');
          const readiness = agentReadiness(agent, this.store.getRuntimes());
          if (readiness.status !== 'ready') throw new Error(readiness.detail);
          updated = await orchestrationService.retryTask({
            workspaceId: input.workspaceId,
            runId: input.runId,
            taskId: actionTask.id,
            expectedTaskRevision: actionTask.revision,
            expectedRunRevision: input.expectedRunRevision,
            actorId: input.actorId
          });
        } else if (input.action === 'retry_report_format') {
          if (episode.category !== 'report' || !actionTask) throw new Error('This build has no report-format correction available. Refresh the saved result and try again.');
          if (reportFormatCorrectionCount(snapshot, actionTask.id) >= MAX_REPORT_FORMAT_CORRECTIONS) {
            throw new Error('The two report-only corrections have already been used. Review the saved response and exact field error before starting a new build.');
          }
          const correction = reportCorrectionInput(snapshot, actionTask.id);
          if (!correction.previousResponse) throw new Error('Alpha could not recover the specialist response for a safe report-only correction. Review the saved attempt before continuing.');
          updated = await orchestrationService.retryTask({
            workspaceId: input.workspaceId,
            runId: input.runId,
            taskId: actionTask.id,
            expectedTaskRevision: actionTask.revision,
            expectedRunRevision: input.expectedRunRevision,
            actorId: input.actorId,
            reportCorrection: correction
          });
        } else if (input.action === 'recheck_prerequisite' && episode.category === 'review_input') {
          if (!actionTask) throw new Error('This review recovery has no assigned reviewer task.');
          updated = await orchestrationService.retryTask({
            workspaceId: input.workspaceId,
            runId: input.runId,
            taskId: actionTask.id,
            expectedTaskRevision: actionTask.revision,
            expectedRunRevision: input.expectedRunRevision,
            actorId: input.actorId
          });
        } else {
          if (!actionTask) throw new Error('This recovery has no failed task to restart.');
          const retryGuidance = retryDirection ?? (
            input.action === 'repair_and_continue' && workAttemptCount(snapshot, actionTask.id) >= AUTO_REPAIR_ATTEMPT_LIMIT
              ? 'Repair the saved failure evidence and continue within the already approved task scope.'
              : undefined
          );
          let expectedRunRevision = input.expectedRunRevision;
          if (retiring.length) {
            const retiredAt = new Date().toISOString();
            const latest = [...snapshot.attempts].reverse().find(attempt => attempt.taskId === actionTask.id &&
              ['failed', 'rejected', 'recovery_required'].includes(attempt.status));
            const repository = actionTask.repository ?? snapshot.run.repository;
            expectedRunRevision = this.store.retireTests({
              runId: input.runId, expectedRevision: input.expectedRunRevision, actorId: input.actorId,
              tests: retiring.map(item => ({ taskId: actionTask.id, attemptId: latest?.id, repository, path: item.path,
                titles: item.titles, actorId: input.actorId, retiredAt }))
            }).run.revision;
          }
          updated = await orchestrationService.retryTask({
            workspaceId: input.workspaceId,
            runId: input.runId,
            taskId: actionTask.id,
            expectedTaskRevision: actionTask.revision,
            expectedRunRevision,
            actorId: input.actorId,
            developerGuidance: retryGuidance
          });
        }
        const refreshed = this.store.getOrchestrationSnapshot(input.runId) ?? updated;
        const newEpisode = this.syncSnapshot(refreshed, input.actorId) ?? startedEpisode;
        await this.flushPendingMilestones();
        const message = input.action === 'retry_report_format' && refreshed.run.currentTaskId
          ? 'Alpha sent the same specialist a read-only report correction. It will accept the handoff only after the report passes its checks.'
          : refreshed.run.currentTaskId
          ? 'Alpha restarted the saved task. It will check the new result before handing work to the next specialist.'
          : refreshed.run.status === 'awaiting_approval'
            ? 'The final checks passed. The build is ready for your review.'
            : refreshed.run.status === 'completed'
              ? 'The build completed and its result is saved.'
              : refreshed.run.stoppedReason ?? 'Alpha saved the action result. Review the latest build status.';
        const result = { message, runStatus: refreshed.run.status, currentTaskId: refreshed.run.currentTaskId, recoveryRevision: newEpisode.revision };
        this.store.finishOrchestrationRecoveryAction({
          recoveryId: episode.id, idempotencyKey: input.idempotencyKey, actorId: input.actorId,
          status: 'completed', result
        });
        const state = await this.getState({ workspaceId: input.workspaceId, runId: input.runId, canControl: true });
        return {
          accepted: true, actionId: created.action.id, runStatus: refreshed.run.status,
          currentTaskId: refreshed.run.currentTaskId, message, state
        };
      } catch (error) {
        this.store.finishOrchestrationRecoveryAction({
          recoveryId: episode.id,
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId,
          status: 'failed',
          errorCode: 'recovery_action_failed'
        });
        const current = this.store.getOrchestrationSnapshot(input.runId);
        if (current) {
          this.syncSnapshot(current, input.actorId);
          try {
            await this.flushPendingMilestones();
          } catch {
            // The durable chat outbox retries this milestone on the next read or startup pass.
          }
        }
        throw error;
      }
    });
  }

  /**
   * The person adds the missing work the Orchestrator held back. The amendment is rebuilt from the
   * plan as it is now, so every check runs again at this moment, and it is saved with the closed
   * recovery in one transaction. Failures reach the caller, which records the action as failed.
   */
  private async addHeldBackPrerequisite(args: {
    input: OrchestrationRecoveryActionInput; snapshot: OrchestrationSnapshot; episode: OrchestrationRecoveryEpisode;
    heldBack: ResolutionRecord; actionId: string;
  }): Promise<OrchestrationRecoveryActionResult> {
    const { input, snapshot, episode, heldBack } = args;
    const task = snapshot.tasks.find(item => item.id === episode.taskId);
    if (!task || !heldBack.proposedPrerequisite) throw new Error('This recovery has no stopped task to add work for. Refresh the build.');
    let amendment;
    try {
      amendment = buildPrerequisiteAmendment({
        snapshot, blockedTaskId: task.id, proposal: heldBack.proposedPrerequisite,
        agents: this.store.getAgents().filter(agent => !agent.isArchived),
        scripts: repository => {
          const workspace = repositoryWorkspaceForRun(snapshot.run, repository);
          return workspace?.worktreePath ? definedCheckScripts(workspace.worktreePath) : [];
        }
      });
    } catch (error) {
      if (error instanceof PrerequisiteRefusal) throw new Error(`The missing work can no longer be added: ${error.message}`);
      throw error;
    }
    const now = new Date().toISOString();
    const record: ResolutionRecord = {
      ...heldBack, outcome: 'prerequisite_added', appliedBy: input.actorId, finishedAt: now,
      proposedPrerequisite: { ...heldBack.proposedPrerequisite, addedTaskIds: [...amendment.prerequisiteIds, ...amendment.reviewIds] }
    };
    const titles = heldBack.proposedPrerequisite.tasks.map(item => `“${item.title}”`).join(', ');
    const { orchestrationService } = await import('./orchestrationRuntime.js');
    const updated = await orchestrationService.addPrerequisiteTasks({
      workspaceId: input.workspaceId, runId: input.runId, taskId: task.id,
      expectedRunRevision: input.expectedRunRevision, expectedTaskRevision: task.revision,
      plan: amendment.plan, actorId: input.actorId, reason: `The person added the work “${task.title}” needs.`,
      recovery: {
        episode: withResolution({ ...episode, phase: 'resolved', updatedAt: now, resolvedAt: now }, record),
        expectedRevision: episode.revision,
        milestone: { key: 'proposed_prerequisite_added', content: `You added the work “${task.title}” needs: ${titles}. “${task.title}” waits for it; the added work goes through the same checks and an independent review.` }
      }
    });
    const refreshed = this.store.getOrchestrationSnapshot(input.runId) ?? updated;
    this.syncSnapshot(refreshed, input.actorId);
    await this.flushPendingMilestones();
    const message = `Alpha added the missing work. “${task.title}” waits for it, and the build continues.`;
    const result = { message, runStatus: refreshed.run.status, currentTaskId: refreshed.run.currentTaskId };
    this.store.finishOrchestrationRecoveryAction({
      recoveryId: episode.id, idempotencyKey: input.idempotencyKey, actorId: input.actorId, status: 'completed', result
    });
    const state = await this.getState({ workspaceId: input.workspaceId, runId: input.runId, canControl: true });
    return { accepted: true, actionId: args.actionId, runStatus: refreshed.run.status, currentTaskId: refreshed.run.currentTaskId, message, state };
  }

  async flushPendingMilestones(): Promise<number> {
    let delivered = 0;
    const milestones = this.store.listPendingOrchestrationRecoveryMilestones(100);
    if (!milestones.length) return 0;
    const { saveChatMessageAndShare } = await import('./chatWriteThrough.js');
    for (const milestone of milestones) {
      await runWithWorkspace(milestone.workspaceId, async () => {
        const binding = this.store.getOrchestrationChatBinding(milestone.runId);
        const thread = this.store.getChatThreads().find(item => item.id === milestone.threadId);
        const buildMessageExists = this.store.getChatMessages(milestone.threadId).some(message => message.id === binding?.buildMessageId);
        if (!binding || binding.threadId !== milestone.threadId || !thread || thread.ownerId !== binding.ownerId || !buildMessageExists) {
          this.store.markOrchestrationRecoveryMilestoneDelivered(milestone.id);
          return;
        }
        let message = this.store.getChatMessages(milestone.threadId).find(item => item.id === milestone.messageId);
        if (!message) {
          message = {
            id: milestone.messageId,
            threadId: milestone.threadId,
            senderType: 'agent',
            senderName: 'Alpha Orchestrator',
            content: milestone.content,
            messageType: 'build_milestone',
            orchestrationRunId: milestone.runId,
            timestamp: milestone.createdAt
          } satisfies ChatMessage;
          saveChatMessageAndShare(message);
          const { chatService } = await import('./chatService.js');
          chatService.emit('chat_message', message);
        }
        if (this.store.markOrchestrationRecoveryMilestoneDelivered(milestone.id)) delivered += 1;
      });
    }
    return delivered;
  }
}

export const orchestrationRecoveryService = new OrchestrationRecoveryService();
