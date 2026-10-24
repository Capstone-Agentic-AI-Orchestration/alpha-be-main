import { Request, Response, Router } from 'express';
import { route } from './asyncRoute.js';
import { ALPHA_ORCHESTRATION_ENABLED, IS_CLOUD } from '../config/env.js';
import { agentStore, chatStore, issueStore, projectStore, runStore, squadStore } from '../store/stores.js';
import type { Agent, AgentCall, AgentCallActivity, ProjectBuildStep, PrototypeRun, RunActivity, Squad, SquadRun } from '../models/index.js';
import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { orchestrationRecoveryService } from '../services/orchestrationRecoveryService.js';
import { sqliteService } from '../services/sqliteService.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { orchestrationSessionId } from '../services/orchestrationSession.js';
import { dependencyAuditEvidenceSchema } from '../services/dependencyAuditContract.js';
import type { OrchestrationRunStatus } from '../services/orchestrationStateMachine.js';
import {
  requireProjectWorkspace,
  requireWorkspaceCapability
} from './workspaceContext.js';

export const liveBuildRoomRouter = Router();

type RoomCardStatus = 'completed' | 'running' | 'waiting' | 'review' | 'failed' | 'idle';
type RoomPhaseStatus = 'completed' | 'running' | 'waiting' | 'review' | 'failed';
const STALE_AGENT_SIGNAL_MS = 5 * 60 * 1000;

interface RoomPhase {
  id: string;
  label: string;
  description: string;
  status: RoomPhaseStatus;
  progress: number;
}

interface RoomActivity {
  id: string;
  sequence: number;
  kind: 'status' | 'stage' | 'assistant' | 'tool' | 'tool_result' | 'file_change' | 'handoff' | 'error' | 'summary' | 'attachment' | 'steering';
  message: string;
  detail?: string;
  isStreaming?: boolean;
  paths?: string[];
  createdAt: string;
}

interface RoomAgentCard {
  executionId: string;
  source: 'squad' | 'project_chat' | 'agent_run';
  sourceLabel: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  avatar?: string;
  color?: string;
  status: RoomCardStatus;
  progress: number;
  currentTask: string;
  currentStage?: string;
  runId?: string;
  agentCallId?: string;
  squadRunId?: string;
  orchestrationTaskId?: string;
  orchestrationAttemptNumber?: number;
  orchestrationTaskCount?: number;
  activity: RoomActivity[];
  filePaths: string[];
  branchName?: string;
  updatedAt?: string | null;
  isStale?: boolean;
  output?: { kind: string; label: string; value: string };
}

/** Percentages represent completed stages only; active work has no invented share. */
function progressForRun(run: PrototypeRun | undefined): number {
  if (!run) return 0;
  if (run.status === 'completed' || run.status === 'awaiting_approval') return 100;
  if (!Array.isArray(run.stages) || run.stages.length === 0) return 0;
  const complete = run.stages.filter((stage: any) => stage.status === 'success').length;
  return Math.min(100, Math.round((complete / run.stages.length) * 100));
}

function phaseStatusForRun(run: PrototypeRun | SquadRun | undefined): RoomPhaseStatus {
  if (!run) return 'waiting';
  if (run.status === 'completed') return 'completed';
  if (run.status === 'awaiting_approval') return 'review';
  if (run.status === 'failed' || run.status === 'cancelled') return 'failed';
  return run.status === 'running' || run.status === 'validating' ? 'running' : 'waiting';
}

function phaseStatusForCard(status: RoomCardStatus): RoomPhaseStatus {
  if (status === 'completed') return 'completed';
  if (status === 'running') return 'running';
  if (status === 'review') return 'review';
  if (status === 'failed') return 'failed';
  return 'waiting';
}

function cardStatus(run: any | undefined, squadRun: any | undefined, memberIndex: number): RoomCardStatus {
  if (!run) {
    return squadRun && memberIndex > (squadRun.currentMemberIndex ?? -1) ? 'waiting' : 'idle';
  }
  if (run.status === 'completed') return 'completed';
  if (run.status === 'awaiting_approval') return 'review';
  if (run.status === 'failed' || run.status === 'cancelled') return 'failed';
  if (squadRun && memberIndex !== squadRun.currentMemberIndex) return 'waiting';
  return run.status === 'queued' ? 'waiting' : 'running';
}

function currentTask(run: any | undefined, status: RoomCardStatus, assignedStageLabel?: string): string {
  if (status === 'completed') return 'Work completed';
  if (status === 'review') return 'Ready for review';
  if (status === 'failed') return 'Run stopped — review activity';
  const assignedStage = run?.plan?.find((item: unknown) => typeof item === 'string' && item.startsWith('Assigned stage:'))
    ?.replace(/^Assigned stage:\s*/, '') ?? assignedStageLabel;
  if (status === 'waiting') return assignedStage
    ? `Waiting · ${safeOperationalText(assignedStage, 150) ?? 'next stage'}`
    : 'Waiting for squad handoff';
  if (status === 'idle') return 'Ready to run';
  if (assignedStage) return safeOperationalText(assignedStage, 150) ?? 'Assigned stage in progress';
  return run?.stages?.[run.currentStageIndex]?.label || 'Execution in progress';
}

function callCardStatus(status: AgentCall['status']): RoomCardStatus {
  if (status === 'completed') return 'completed';
  if (status === 'awaiting_confirmation') return 'review';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'queued') return 'waiting';
  if (status === 'running') return 'running';
  return 'idle';
}

function callTask(
  call: Pick<AgentCall, 'status' | 'operationMode' | 'origin'> & { activities: AgentCallActivity[]; error?: string },
  status: RoomCardStatus,
  targetLabel?: string
): string {
  if (status === 'waiting') return 'Queued for execution';
  if (status === 'review') return 'Waiting for your confirmation';
  if (status === 'failed') return call.error ? `Stopped: ${safeOperationalText(call.error, 180)}` : 'Run stopped — review activity';
  if (status === 'completed') return 'Agent call completed';
  const latestStage = [...(call.activities ?? [])].reverse().find(activity => activity.kind === 'stage' || activity.kind === 'status');
  if (latestStage?.message) return latestStage.message;
  if (targetLabel) return `${call.operationMode === 'implement' ? 'Working on' : 'Reviewing'} ${targetLabel}`;
  return call.origin === 'chat_turn' ? 'Responding in project chat' : 'Agent call in progress';
}

function safeOperationalText(value?: string, limit = 600): string | undefined {
  if (!value) return undefined;
  return value.slice(0, limit)
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s"'`]+/gi, '$1[redacted]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key|client[_-]?secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,"'`]+)/gi, '$1[redacted]')
    .replace(/(--(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s"'`]+)/gi, '$1[redacted]');
}

function safeProjectPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (/^(?:[a-z]:\/|\/)/i.test(normalized)) {
    return normalized.split('/').filter(Boolean).slice(-4).join('/').slice(0, 180);
  }
  return normalized.slice(0, 180);
}

function roomRunActivity(activities: RunActivity[] = []): RoomActivity[] {
  return activities.slice(-40).map(activity => {
    const toolName = activity.toolName?.replace(/[^A-Za-z0-9_. -]/g, '').slice(0, 80);
    return {
      id: activity.id,
      sequence: activity.sequence,
      kind: activity.kind === 'tool' && /edit|write|patch|replace/i.test(toolName ?? '') ? 'file_change' : activity.kind,
      message: safeOperationalText(activity.message, 320) ?? '',
      toolName,
      detail: safeOperationalText(activity.detail),
      isStreaming: activity.isStreaming,
      paths: roomRunActivityPaths(activity),
      createdAt: activity.createdAt
    };
  });
}

function orchestrationRunActivity(run: PrototypeRun): RoomActivity[] {
  const recentOutput = run.stages
    .filter(stage => stage.id === 'tests' || stage.status === 'failed')
    .flatMap((stage, index) => {
      const output = (stage.logs ?? []).slice(-12).join('\n').slice(-5_000);
      if (!output) return [];
      return [{
        id: `${run.id}:stage-output:${stage.id}`,
        sequence: 50_000 + index,
        kind: stage.status === 'failed' ? 'error' as const : 'tool_result' as const,
        message: `${stage.status === 'failed' ? 'Failed check' : 'Recent check'} output · ${stage.label}`,
        toolName: 'Verification output',
        detail: safeOperationalText(output, 5_000),
        createdAt: stage.completedAt ?? run.updatedAt
      }];
    });
  return [...roomRunActivity(run.activities), ...recentOutput]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function roomRunActivityPaths(activity: RunActivity): string[] | undefined {
  if (activity.kind !== 'tool') return undefined;
  let paths: unknown[] = [];
  try {
    const parsed = JSON.parse(activity.detail ?? '{}');
    const input = parsed && typeof parsed.input === 'object' && !Array.isArray(parsed.input) ? parsed.input : {};
    paths = [
      parsed.file_path, parsed.path, parsed.filename, parsed.target_file,
      input.file_path, input.path, input.filename, input.target_file
    ];
  } catch {
    // Older runs may only contain the human-readable activity message.
  }
  const describedPath = activity.message.match(/^(?:Edited|Read)\s+(?!files with\b)(.+)$/i)?.[1];
  const values = [...paths, describedPath]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => safeProjectPath(value.trim()));
  return values.length ? Array.from(new Set(values)) : undefined;
}

function safeRoomRun(run: PrototypeRun): PrototypeRun {
  return {
    ...run,
    plan: run.plan.map(item => safeOperationalText(item, 360) ?? ''),
    testSummary: safeOperationalText(run.testSummary, 700),
    activities: (run.activities ?? []).slice(-40).map(activity => ({
      ...activity,
      message: safeOperationalText(activity.message, 320) ?? '',
      detail: safeOperationalText(activity.detail)
    })),
    stages: run.stages.map(stage => ({
      ...stage,
      description: safeOperationalText(stage.description, 360) ?? '',
      logs: (stage.logs ?? []).slice(-8).map(log => safeOperationalText(log, 500) ?? '')
    }))
  };
}

function safeRepositoryPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || normalized.split('/').some(part => part === '.' || part === '..')) return undefined;
  return normalized.slice(0, 180);
}

function safeOrchestrationProjection(
  snapshot: NonNullable<ReturnType<typeof sqliteService.getOrchestrationSnapshot>>,
  agentsById: ReadonlyMap<string, Agent>,
  visibleAgentIds: ReadonlySet<string>,
  recovery?: Awaited<ReturnType<typeof orchestrationRecoveryService.getState>>['recovery']
) {
  const finalValidationEvent = runWithWorkspace(snapshot.run.workspaceId, () => sqliteService.listOrchestrationEvents(snapshot.run.id, 0, 500))
    .reverse()
    .find(event => {
      const evidence = event.payload.evidence;
      return Boolean(evidence && typeof evidence === 'object' && (evidence as Record<string, unknown>).validationVersion === 1);
    });
  const finalEvidence = finalValidationEvent?.payload.evidence && typeof finalValidationEvent.payload.evidence === 'object'
    ? finalValidationEvent.payload.evidence as Record<string, unknown>
    : undefined;
  const finalChecks = finalEvidence?.checks && typeof finalEvidence.checks === 'object'
    ? finalEvidence.checks as Record<string, unknown>
    : undefined;
  const finalCommands = Array.isArray(finalChecks?.observed) ? finalChecks!.observed as Array<Record<string, unknown>> : [];
  const safeAgentId = (agentId: string) => visibleAgentIds.has(agentId) ? agentId : undefined;
  const safeAgentName = (agentId: string) => {
    const agent = visibleAgentIds.has(agentId) ? agentsById.get(agentId) : undefined;
    return safeOperationalText(agent?.name, 100) ?? 'Project specialist';
  };
  const planTasksById = new Map(snapshot.run.plan.tasks.map(task => [task.id, task]));
  return {
    run: {
      id: snapshot.run.id,
      originChatThreadId: snapshot.run.originChatThreadId,
      status: snapshot.run.status,
      revision: snapshot.run.revision,
      planVersion: snapshot.run.planVersion,
      goal: safeOperationalText(snapshot.run.plan.goal, 1_200) ?? '',
      exclusions: snapshot.run.plan.exclusions.map(item => safeOperationalText(item, 180) ?? ''),
      repository: safeOperationalText(snapshot.run.repository, 180) ?? '',
      branchName: safeOperationalText(snapshot.run.branchName, 180),
      repositories: (snapshot.run.repositoryWorkspaces ?? []).map(item => ({
        repository: safeOperationalText(item.repository, 180) ?? '',
        branchName: safeOperationalText(item.branchName, 180) ?? ''
      })),
      currentTaskId: snapshot.run.currentTaskId,
      stoppedReason: safeOperationalText(snapshot.run.stoppedReason, 500),
      pauseRequestedAt: snapshot.run.pauseRequestedAt,
      publication: snapshot.run.publication ? {
        repository: safeOperationalText(snapshot.run.publication.repository, 180) ?? snapshot.run.repository,
        branchName: safeOperationalText(snapshot.run.publication.branchName, 180) ?? '',
        baseBranch: safeOperationalText(snapshot.run.publication.baseBranch, 180) ?? '',
        resultCommit: safeOperationalText(snapshot.run.publication.resultCommit, 64) ?? '',
        pullRequestUrl: snapshot.run.publication.pullRequestUrl,
        publishedAt: snapshot.run.publication.publishedAt
      } : undefined,
      publications: snapshot.run.publications?.map(publication => ({
        repository: safeOperationalText(publication.repository, 180) ?? '',
        branchName: safeOperationalText(publication.branchName, 180) ?? '',
        baseBranch: safeOperationalText(publication.baseBranch, 180) ?? '',
        resultCommit: safeOperationalText(publication.resultCommit, 64) ?? '',
        pullRequestUrl: publication.pullRequestUrl,
        publishedAt: publication.publishedAt
      })),
      createdAt: snapshot.run.createdAt,
      updatedAt: snapshot.run.updatedAt
    },
    recovery,
    milestones: snapshot.run.plan.milestones?.map(milestone => {
      const tasks = snapshot.tasks.filter(task => task.milestoneId === milestone.id && task.required);
      return { id: milestone.id, title: safeOperationalText(milestone.title, 240) ?? '',
        status: !tasks.length ? 'unplanned' : tasks.every(task => task.status === 'accepted') ? 'accepted' : 'active' };
    }),
    requirements: snapshot.run.plan.requirements.map(requirement => ({
      id: requirement.id,
      description: safeOperationalText(requirement.description, 360) ?? ''
    })),
    tasks: snapshot.tasks.map(task => {
      const executionAttemptCount = snapshot.attempts.filter(attempt => attempt.taskId === task.id &&
        attempt.contextManifest.reportOnlyReportRetry !== true).length;
      return {
        id: task.id,
        title: safeOperationalText(task.title, 180) ?? '',
        description: safeOperationalText(task.description, 700) ?? '',
        kind: task.kind,
        repository: safeOperationalText(planTasksById.get(task.id)?.repository ?? snapshot.run.repository, 180) ?? '',
        ownerAgentId: safeAgentId(task.ownerAgentId),
        ownerName: safeAgentName(task.ownerAgentId),
        dependsOn: task.dependsOn,
        requirementIds: task.requirementIds,
        acceptanceCriteria: task.acceptanceCriteria.map(item => safeOperationalText(item, 280) ?? ''),
        requiredChecks: task.requiredChecks,
        dependencyAudit: task.dependencyAudit,
        assignmentReason: safeOperationalText(planTasksById.get(task.id)?.assignmentReason, 500) ??
          `This task needs a ${safeAgentName(task.ownerAgentId)} specialist for ${task.kind} work.`,
        scope: {
          includePaths: task.scope.includePaths.map(safeRepositoryPath).filter((item): item is string => Boolean(item)),
          excludePaths: task.scope.excludePaths.map(safeRepositoryPath).filter((item): item is string => Boolean(item))
        },
        required: task.required,
        status: task.status,
        revision: task.revision,
        attemptCount: task.attemptCount,
        executionAttemptCount,
        retryAvailable: !IS_CLOUD && ALPHA_ORCHESTRATION_ENABLED &&
          ['executing', 'blocked'].includes(snapshot.run.status) &&
          ['failed', 'blocked'].includes(task.status) && executionAttemptCount < 2,
        correctionOfTaskId: task.correctionOfTaskId,
        correctionCycle: task.correctionCycle
      };
    }),
    attempts: snapshot.attempts.map(attempt => {
      const result = attempt.result ?? {};
      const report = result.agentReport && typeof result.agentReport === 'object'
        ? result.agentReport as Record<string, unknown>
        : undefined;
      const deliverables = Array.isArray(report?.deliverables) ? report!.deliverables as Array<Record<string, unknown>> : [];
      const coverage = Array.isArray(report?.requirementCoverage) ? report!.requirementCoverage as Array<Record<string, unknown>> : [];
      const criteria = Array.isArray(report?.criteriaEvidence) ? report!.criteriaEvidence as Array<Record<string, unknown>> : [];
      const reportedChecks = Array.isArray(report?.reportedChecks) ? report!.reportedChecks as Array<Record<string, unknown>> : [];
      const reviewFindings = Array.isArray(report?.reviewFindings) ? report!.reviewFindings as Array<Record<string, unknown>> : [];
      const verification = result.verification && typeof result.verification === 'object'
        ? result.verification as Record<string, unknown>
        : undefined;
      const observed = verification?.observed && typeof verification.observed === 'object'
        ? verification.observed as Record<string, unknown>
        : undefined;
      const commands = Array.isArray(observed?.commands) ? observed!.commands as Array<Record<string, unknown>> : [];
      const acceptance = result.acceptanceEvidence && typeof result.acceptanceEvidence === 'object'
        ? result.acceptanceEvidence as Record<string, unknown>
        : undefined;
      const changedPaths = Array.isArray(acceptance?.changedPaths) ? acceptance!.changedPaths : [];
      return {
        id: attempt.id,
        taskId: attempt.taskId,
        attemptNumber: attempt.attemptNumber,
        reportFormatRetry: attempt.contextManifest.reportOnlyReportRetry === true,
        prototypeRunId: attempt.prototypeRunId,
        agentId: safeAgentId(attempt.agentId),
        agentName: safeAgentName(attempt.agentId),
        status: attempt.status,
        dependencyAudits: (Array.isArray(acceptance?.dependencyAudits) ? acceptance.dependencyAudits : []).flatMap(raw => {
          const parsed = dependencyAuditEvidenceSchema.safeParse(raw);
          if (!parsed.success) return [];
          const audit = parsed.data;
          return [{ id: audit.id, repository: audit.repository, purpose: audit.purpose, level: audit.level, scanner: audit.scanner,
            status: audit.status, passesPolicy: audit.passesPolicy, counts: audit.counts, createdAt: audit.createdAt,
            findings: audit.findings.map(item => ({ package: safeOperationalText(item.package, 200) ?? '', severity: item.severity,
              range: safeOperationalText(item.range, 240) ?? '', advisories: item.advisories.map(value => safeOperationalText(value, 350) ?? '') })) }];
        }),
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        resultCommit: attempt.resultCommit,
        summary: safeOperationalText(result.summary as string | undefined, 900),
        reportResponse: safeOperationalText(result.agentReportResponse as string | undefined, 12_000),
        reportResponseTruncated: result.agentReportResponseTruncated === true,
        reportError: safeOperationalText(result.agentReportError as string | undefined, 900),
        reportSchemaVersionExpected: Number.isInteger(result.agentReportSchemaVersionExpected)
          ? result.agentReportSchemaVersionExpected as number
          : undefined,
        reportSchemaVersionReceived: Number.isInteger(result.agentReportSchemaVersionReceived)
          ? result.agentReportSchemaVersionReceived as number
          : undefined,
        failureReason: safeOperationalText(attempt.failureReason ?? result.rejectionReason as string | undefined, 500),
        report: report ? {
          requirementCoverage: coverage.map(item => ({
            requirementId: safeOperationalText(item.requirementId as string | undefined, 80),
            evidence: safeOperationalText(item.evidence as string | undefined, 350)
          })),
          criteriaEvidence: criteria.map(item => ({
            criterion: safeOperationalText(item.criterion as string | undefined, 280),
            evidence: safeOperationalText(item.evidence as string | undefined, 350)
          })),
          deliverables: deliverables.map(item => ({
            summary: safeOperationalText(item.summary as string | undefined, 350),
            paths: Array.isArray(item.paths) ? item.paths.map(safeRepositoryPath).filter((value): value is string => Boolean(value)) : []
          })),
          reportedChecks: reportedChecks.map(item => ({
            script: safeOperationalText(item.script as string | undefined, 80),
            result: item.result === 'passed' || item.result === 'failed' ? item.result : 'not_run',
            evidence: safeOperationalText(item.evidence as string | undefined, 300)
          })),
          ...(Array.isArray(report?.reviewFindings) ? {
            reviewFindings: reviewFindings.map(item => ({
              targetTaskId: safeOperationalText(item.targetTaskId as string | undefined, 100) ?? '',
              severity: item.severity === 'blocking' || item.severity === 'critical' ? item.severity : 'warning',
              title: safeOperationalText(item.title as string | undefined, 180) ?? 'Review finding',
              requirementId: safeOperationalText(item.requirementId as string | undefined, 80),
              path: safeRepositoryPath(item.path),
              evidence: safeOperationalText(item.evidence as string | undefined, 350) ?? '',
              instruction: safeOperationalText(item.instruction as string | undefined, 450) ?? ''
            }))
          } : {}),
          blockers: Array.isArray(report.blockers) ? report.blockers.filter((item): item is string => typeof item === 'string').map(item => safeOperationalText(item, 180) ?? '') : []
        } : undefined,
        verification: observed ? {
          status: observed.status,
          missingScripts: Array.isArray(observed.missingScripts) ? observed.missingScripts.filter((item): item is string => typeof item === 'string') : [],
          preparation: observed.preparation && typeof observed.preparation === 'object' ? {
            display: safeOperationalText((observed.preparation as Record<string, unknown>).display as string | undefined, 180),
            exitCode: typeof (observed.preparation as Record<string, unknown>).exitCode === 'number' ? (observed.preparation as Record<string, unknown>).exitCode as number : null,
            signal: safeOperationalText((observed.preparation as Record<string, unknown>).signal as string | undefined, 40) ?? null
          } : undefined,
          commands: commands.map(command => {
            const commandInfo = command.command && typeof command.command === 'object' ? command.command as Record<string, unknown> : {};
            return {
              script: safeOperationalText(command.script as string | undefined ?? commandInfo.script as string | undefined, 80),
              display: safeOperationalText(command.display as string | undefined ?? commandInfo.display as string | undefined, 180),
              exitCode: typeof command.exitCode === 'number' ? command.exitCode : null,
              signal: safeOperationalText(command.signal as string | undefined, 40) ?? null
            };
          })
        } : undefined,
        changedPaths: changedPaths.map(safeRepositoryPath).filter((item): item is string => Boolean(item))
      };
    }),
    finalValidation: finalEvidence ? {
      status: safeOperationalText(finalChecks?.status as string | undefined, 40),
      missingScripts: Array.isArray(finalChecks?.missingScripts)
        ? finalChecks!.missingScripts.filter((item): item is string => typeof item === 'string').map(item => safeOperationalText(item, 80) ?? '')
        : [],
      commands: finalCommands.map(command => ({
        script: safeOperationalText(command.script as string | undefined, 80),
        display: safeOperationalText(command.display as string | undefined, 180),
        exitCode: typeof command.exitCode === 'number' ? command.exitCode : null,
        signal: safeOperationalText(command.signal as string | undefined, 40) ?? null
      })),
      resultCommit: safeOperationalText(finalEvidence.resultCommit as string | undefined, 64),
      noOpenBlockingFindings: finalEvidence.noOpenBlockingFindings === true,
      repositories: Array.isArray(finalEvidence.repositories) ? finalEvidence.repositories.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const repository = item as Record<string, unknown>;
        const checks = repository.checks && typeof repository.checks === 'object' ? repository.checks as Record<string, unknown> : {};
        const commands = Array.isArray(checks.observed) ? checks.observed as Array<Record<string, unknown>> : [];
        return [{
          repository: safeOperationalText(repository.repository as string | undefined, 180) ?? '',
          status: safeOperationalText(checks.status as string | undefined, 40),
          missingScripts: Array.isArray(checks.missingScripts) ? checks.missingScripts.filter((value): value is string => typeof value === 'string').map(value => safeOperationalText(value, 100) ?? '') : [],
          commands: commands.map(command => ({
            script: safeOperationalText(command.script as string | undefined, 100),
            display: safeOperationalText(command.display as string | undefined, 180),
            exitCode: typeof command.exitCode === 'number' ? command.exitCode : null,
            signal: safeOperationalText(command.signal as string | undefined, 40) ?? null
          })),
          resultCommit: safeOperationalText(repository.resultCommit as string | undefined, 64)
        }];
      }) : []
    } : undefined,
    artifacts: snapshot.artifacts.map(artifact => ({
      id: artifact.id, taskId: artifact.taskId, type: artifact.type,
      version: artifact.version, contentHash: artifact.contentHash, status: artifact.status, createdAt: artifact.createdAt
    })),
    findings: snapshot.findings.map(finding => ({
      id: finding.id, taskId: finding.taskId, sourceTaskId: finding.sourceTaskId,
      severity: finding.severity, requirementId: finding.requirementId,
      path: safeRepositoryPath(finding.path), status: finding.status,
      correctionTaskId: finding.correctionTaskId,
      title: safeOperationalText(typeof finding.evidence.title === 'string' ? finding.evidence.title : undefined, 180),
      evidence: safeOperationalText(typeof finding.evidence.evidence === 'string' ? finding.evidence.evidence : undefined, 350),
      instruction: safeOperationalText(typeof finding.evidence.instruction === 'string' ? finding.evidence.instruction : undefined, 450),
      check: safeOperationalText(typeof finding.evidence.check === 'string' ? finding.evidence.check : undefined, 80),
      createdAt: finding.createdAt, resolvedAt: finding.resolvedAt
    }))
  };
}

function latestCallActivityAt(call: Pick<AgentCall, 'activities' | 'startedAt' | 'createdAt'>): string {
  return call.activities.at(-1)?.createdAt ?? call.startedAt ?? call.createdAt;
}

function hasStaleAgentSignal(status: RoomCardStatus, updatedAt?: string | null): boolean {
  if (status !== 'running' || !updatedAt) return false;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp > STALE_AGENT_SIGNAL_MS;
}

function describeHandoffWork(run?: PrototypeRun): string {
  const summary = [...(run?.activities ?? [])].reverse().find(activity => activity.kind === 'summary');
  if (summary?.message) return safeOperationalText(summary.message, 320) ?? 'Completed work was passed forward.';
  if (run?.changedFiles) {
    return `${run.changedFiles} file${run.changedFiles === 1 ? '' : 's'} changed on the shared branch.`;
  }
  return 'The next agent received the completed work on the shared branch.';
}

function squadProgress(
  squadRun: SquadRun | undefined,
  memberRunByAgent: ReadonlyMap<string, PrototypeRun>
): number {
  if (!squadRun) return 0;
  if (squadRun.status === 'awaiting_approval') return 100;
  if (!squadRun.memberAgentIds.length) return 0;
  return Math.round(
    squadRun.memberAgentIds.reduce(
      (sum, agentId) => sum + progressForRun(memberRunByAgent.get(agentId)),
      0
    ) / squadRun.memberAgentIds.length
  );
}

function stepDescription(
  step: ProjectBuildStep,
  agentsById: ReadonlyMap<string, Agent>,
  squadsById: ReadonlyMap<string, Squad>
): string {
  const owner = step.agentId
    ? agentsById.get(step.agentId)?.name ?? step.agentId
    : step.squadId
      ? squadsById.get(step.squadId)?.name ?? step.squadId
      : 'No execution owner assigned';
  return step.approvalGate ? `${owner} - approval required` : owner;
}

function safePullRequestTarget(value: string): { id: string; label: string } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.search || url.hash) return undefined;
    const github = url.hostname.toLowerCase() === 'github.com'
      ? url.pathname.match(/^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/)
      : null;
    const gitlab = url.hostname.toLowerCase() === 'gitlab.com'
      ? url.pathname.match(/^\/(?:[^/]+\/)+-\/merge_requests\/(\d+)\/?$/)
      : null;
    const number = github?.[1] ?? gitlab?.[1];
    return number ? { id: url.toString(), label: `Pull request #${number}` } : undefined;
  } catch {
    return undefined;
  }
}

function phaseRows(
  steps: ProjectBuildStep[],
  selectedSquad: Squad,
  agentsById: ReadonlyMap<string, Agent>,
  squadsById: ReadonlyMap<string, Squad>,
  visibleAgentIds: ReadonlySet<string>,
  selectedRun: SquadRun | undefined,
  memberRunByAgent: ReadonlyMap<string, PrototypeRun>
): RoomPhase[] {
  const enabledSteps = steps
    .filter(step => step.enabled)
    .filter(step => !step.agentId || visibleAgentIds.has(step.agentId))
    .filter(step => !step.squadId || squadsById.has(step.squadId))
    .sort((a, b) => a.position - b.position);

  if (enabledSteps.length > 0) {
    return enabledSteps.map(step => {
      if (step.agentId) {
        const memberIndex = selectedSquad.memberAgentIds.indexOf(step.agentId);
        const run = memberRunByAgent.get(step.agentId);
        const status = phaseStatusForCard(cardStatus(run, selectedRun, memberIndex));
        return {
          id: step.id,
          label: step.label,
          description: stepDescription(step, agentsById, squadsById),
          status,
          progress: progressForRun(run)
        };
      }

      const run = step.squadId === selectedSquad.id ? selectedRun : undefined;
      return {
        id: step.id,
        label: step.label,
        description: stepDescription(step, agentsById, squadsById),
        status: phaseStatusForRun(run),
        progress: squadProgress(run, memberRunByAgent)
      };
    });
  }

  // Without an explicit project pipeline, show the project's real squad
  // membership rather than a generic requirements-to-release template.
  return selectedSquad.memberAgentIds.flatMap((agentId, memberIndex) => {
    if (!visibleAgentIds.has(agentId)) return [];
    const agent = agentsById.get(agentId);
    const run = memberRunByAgent.get(agentId);
    const status = phaseStatusForCard(cardStatus(run, selectedRun, memberIndex));
    return [{
      id: `squad-member-${agentId}`,
      label: agent?.name ?? agentId,
      description: agent?.role ?? 'Assigned squad member',
      status,
      progress: progressForRun(run)
    }];
  });
}

/** Return only projects that can actually open a room for this caller. */
liveBuildRoomRouter.get('/live-build-room/projects', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  const all = await projectStore().list(req.workspace!.workspaceId);
  const projects = workspaceRegistry.scopeProjects(all, req.workspace!);
  res.json(projects
    .filter(project => workspaceRegistry.canAccessLiveBuildRoom(req.workspace!, project.id))
    .map(project => ({
      id: project.id,
      key: project.key,
      name: project.name,
      color: project.color
    })));
}));

/**
 * Project-scoped execution room.
 *
 * The endpoint intentionally returns a complete room snapshot rather than
 * making the browser stitch together workspace, project, squad and run rows.
 * That keeps authorization in one place and prevents a client from combining
 * a permitted project with a squad or run from another project.
 */
liveBuildRoomRouter.get('/projects/:projectId/live-build-room', route(async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'squad.read')) return;
  if (!requireProjectWorkspace(req, res, req.params.projectId)) return;
  if (!workspaceRegistry.canAccessLiveBuildRoom(req.workspace!, req.params.projectId)) {
    return res.status(404).json({ error: 'This project room is not available to this account.' });
  }

  const workspaceId = req.workspace!.workspaceId;
  const project = await projectStore().get(workspaceId, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  // Read once for the whole response: every squad below looks itself up in it.
  const [assignments, issues, projectBuildSteps] = await Promise.all([
    workspaceRegistry.listSquadProjectAssignments(workspaceId, project.id),
    issueStore().list(workspaceId),
    projectStore().getBuildSteps(workspaceId, project.id)
  ]);
  const projectSquadIds = new Set(workspaceRegistry.listProjectSquadIds(req.workspace!, project.id));
  const ownerThreads = new Map(
    (await chatStore().listThreads(workspaceId, req.workspace!.userId))
      .filter(thread => thread.projectId === project.id)
      .map(thread => [thread.id, thread] as const)
  );
  const requestedThreadId = typeof req.query.threadId === 'string' ? req.query.threadId : undefined;
  if (requestedThreadId && !ownerThreads.has(requestedThreadId)) {
    return res.status(404).json({ error: 'This conversation is not available in this project.' });
  }
  const squads = workspaceRegistry
    .scopeSquads(await squadStore().list(workspaceId), req.workspace!)
    .filter(squad => projectSquadIds.has(squad.id))
    .map(squad => ({
      ...squad,
      ownerId: workspaceRegistry.squadOwnerId(req.workspace!, squad.id),
      assignment: assignments.find(
        assignment => assignment.squadId === squad.id && assignment.status === 'active'
      )
    }));

  const accessibleSquadIds = new Set(squads.map(squad => squad.id));
  const squadsById = new Map(squads.map(squad => [squad.id, squad]));
  const squadRuns = (await runStore().listSquadRuns(workspaceId))
    .filter(run => run.projectId === project.id && projectSquadIds.has(run.squadId))
    .filter(run => workspaceRegistry.canAccessSquad(req.workspace!, run.squadId))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const requestedRunId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
  const requestedRun = requestedRunId ? squadRuns.find(run => run.id === requestedRunId) : undefined;
  const squadRun = requestedRun ?? squadRuns.find(run => run.status === 'running' || run.status === 'awaiting_approval') ?? squadRuns[0];
  const buildRuns: Array<{
    id: string;
    kind: 'squad' | 'orchestration';
    status: SquadRun['status'] | OrchestrationRunStatus;
    issueIdentifier?: string;
    issueTitle?: string;
    repository?: string;
    branchName: string;
    updatedAt: string;
  }> = squadRuns.slice(0, 40).map(run => {
    const issue = issues.find(item => item.id === run.issueId && item.projectId === project.id);
    return {
      id: run.id,
      kind: 'squad',
      status: run.status,
      issueIdentifier: issue?.identifier,
      issueTitle: issue?.title,
      repository: issue?.githubRepo,
      branchName: run.branchName,
      updatedAt: run.updatedAt
    };
  });
  const selectedSquad = squads.find(squad => squad.id === squadRun?.squadId) ?? squads[0];
  const selectedRun = squadRun && squadRun.squadId === selectedSquad?.id ? squadRun : undefined;
  const membersById = new Map((await agentStore().list(workspaceId)).map(agent => [agent.id, agent]));
  const allProjectRuns = (await runStore().list(workspaceId)).filter(run => run.projectId === project.id);
  const requestedOrchestrationId = typeof req.query.orchestrationRunId === 'string'
    ? req.query.orchestrationRunId
    : typeof req.query.runId === 'string' && req.query.runId.startsWith('orchestration-')
      ? req.query.runId
      : undefined;
  const explicitlySelectedLegacyRun = Boolean(requestedRunId && !requestedOrchestrationId);
  const requestedOrchestration = !IS_CLOUD && requestedOrchestrationId
    ? runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationSnapshot(requestedOrchestrationId))
    : undefined;
  if (requestedThreadId && requestedOrchestrationId && requestedOrchestration?.run.originChatThreadId !== requestedThreadId) {
    return res.status(404).json({ error: 'This build is not part of the selected conversation.' });
  }
  const activeOrchestrationRef = !IS_CLOUD && !requestedThreadId
    ? runWithWorkspace(workspaceId, () => sqliteService.getActiveOrchestrationForProject(project.id))
    : undefined;
  const activeOrchestration = activeOrchestrationRef
    ? runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationSnapshot(activeOrchestrationRef.runId))
    : undefined;
  const latestOrchestration = !IS_CLOUD
    ? runWithWorkspace(workspaceId, () => sqliteService.getLatestOrchestrationSnapshot(project.id, requestedThreadId))
    : undefined;
  const selectedOrchestration = !explicitlySelectedLegacyRun
    ? [requestedOrchestration, activeOrchestration, latestOrchestration].find(item => item?.run.projectId === project.id)
    : undefined;
  // Project-chat calls run on the desktop and remain in that owner's private
  // local history. Cloud rooms use the shared Postgres run telemetry instead;
  // never let a cloud request fall through to the desktop SQLite store.
  const projectAgentCalls = IS_CLOUD
    ? []
    : sqliteService.getAgentCalls({ workspaceId, projectId: project.id });
  const roomAgentIds = new Set([
    ...squads.flatMap(squad => squad.memberAgentIds),
    ...squadRuns.flatMap(run => run.memberAgentIds),
    ...allProjectRuns.map(run => run.agentId),
    ...projectAgentCalls.filter(call => accessibleSquadIds.has(call.squadId)).map(call => call.agentId)
  ]);
  const roomAgentVisibility = await Promise.all(Array.from(roomAgentIds, async agentId => ({
    agentId,
    visible: await workspaceRegistry.canAccessProjectAgentRun(req.workspace!, project.id, agentId)
  })));
  const visibleAgentIds = new Set(roomAgentVisibility.filter(item => item.visible).map(item => item.agentId));
  if (selectedOrchestration) {
    const taskOwners = [...new Set(selectedOrchestration.tasks.map(task => task.ownerAgentId))];
    const taskOwnerVisibility = await Promise.all(taskOwners.map(async agentId => ({
      agentId,
      visible: await workspaceRegistry.canAccessProjectAgentRun(req.workspace!, project.id, agentId)
    })));
    taskOwnerVisibility.filter(item => item.visible).forEach(item => visibleAgentIds.add(item.agentId));
  }
  const orchestrationPrototypeRuns = selectedOrchestration
    ? allProjectRuns.filter(run => run.orchestrationRunId === selectedOrchestration.run.id && visibleAgentIds.has(run.agentId))
    : [];
  const visibleSquadRunIds = new Set(squadRuns.map(run => run.id));
  const visibleSquadRuns = allProjectRuns.filter(run => run.squadRunId && visibleSquadRunIds.has(run.squadRunId) && visibleAgentIds.has(run.agentId));
  const standaloneRunCandidates = allProjectRuns.filter(run => {
    if (run.squadRunId) return false;
    const issue = issues.find(item => item.id === run.issueId && item.projectId === project.id);
    if (!issue) return false;
    if (issue.assignedAgentId === run.agentId) return true;
    const assignedSquad = issue.assignedSquadId ? squadsById.get(issue.assignedSquadId) : undefined;
    return Boolean(assignedSquad?.memberAgentIds.includes(run.agentId));
  });
  const visibleStandaloneRuns = standaloneRunCandidates.filter(run => visibleAgentIds.has(run.agentId));
  const projectRuns = [...visibleSquadRuns, ...visibleStandaloneRuns];
  const memberRuns = selectedRun
    ? projectRuns.filter(run => run.squadRunId === selectedRun.id)
      .sort((a, b) => (a.squadOrder ?? 0) - (b.squadOrder ?? 0))
    : [];
  const memberRunByAgent = new Map(memberRuns.map(run => [run.agentId, run]));

  const authorizedChatCalls = (await Promise.all(
    projectAgentCalls
      .filter(call => call.origin !== 'chat_turn' || call.requestedBy === req.workspace!.userId)
      .map(async call => {
        const allowed = call.origin === 'chat_turn' && call.requestedBy === req.workspace!.userId
          ? true
          : await workspaceRegistry.canAccessProjectAgentRun(req.workspace!, call.projectId, call.agentId);
        if (!allowed) return null;
        const agent = membersById.get(call.agentId);
        const ownedThread = ownerThreads.get(call.threadId);
        const issueTarget = call.revisionTarget?.type === 'issue'
          ? issues.find(issue => issue.id === call.revisionTarget!.id && issue.projectId === project.id)
          : undefined;
        const pullRequest = call.revisionTarget?.type === 'pull_request'
          ? safePullRequestTarget(call.revisionTarget.id)
          : undefined;
        const target = call.revisionTarget ? {
          type: call.revisionTarget.type,
          id: issueTarget?.id ?? (call.revisionTarget.type === 'file' ? safeProjectPath(call.revisionTarget.id) : pullRequest?.id ?? ''),
          label: issueTarget
            ? `${issueTarget.identifier} · ${issueTarget.title}`
            : call.revisionTarget.type === 'file'
              ? safeProjectPath(call.revisionTarget.id)
              : pullRequest?.label
        } : undefined;
        return {
          id: call.id,
          threadId: ownedThread ? call.threadId : undefined,
          messageId: ownedThread ? call.messageId : undefined,
          canOpenChat: Boolean(ownedThread),
          chatLabel: ownedThread?.title || 'Project chat',
          agentId: call.agentId,
          agentName: agent?.name ?? (call.origin === 'chat_turn' ? 'Alpha' : 'Project agent'),
          agentRole: agent?.role ?? (call.origin === 'chat_turn' ? 'Chat assistant' : 'Agent'),
          operationMode: call.operationMode,
          origin: call.origin ?? 'agent_call',
          status: call.status,
          target,
          workingCopyId: call.workingCopyId,
          workingBranch: call.workingBranch,
          createdAt: call.createdAt,
          startedAt: call.startedAt,
          completedAt: call.completedAt,
          activities: (call.activities ?? []).slice(-60).map(activity => ({
            ...activity,
            message: safeOperationalText(activity.message, 320) ?? '',
            toolName: activity.toolName?.replace(/[^A-Za-z0-9_. -]/g, '').slice(0, 80),
            detail: safeOperationalText(activity.detail),
            paths: activity.paths?.slice(0, 30).map(safeProjectPath)
          })),
          artifacts: call.artifacts
            .filter(artifact => artifact.artifactType !== 'patch')
            .map(artifact => ({ id: artifact.id, artifactType: artifact.artifactType, createdAt: artifact.createdAt })),
          hasPatch: call.artifacts.some(artifact => artifact.artifactType === 'patch'),
          patchApplied: (call.activities ?? []).some(activity => activity.kind === 'file_change' && activity.message === 'Proposed patch applied to the project working copy')
        };
      })
  )).filter((call): call is NonNullable<typeof call> => Boolean(call))
    .sort((a, b) => Date.parse(latestCallActivityAt(b)) - Date.parse(latestCallActivityAt(a)));

  const isLiveCall = (call: { status: string }) =>
    call.status === 'queued' || call.status === 'running' || call.status === 'awaiting_confirmation';
  const chatCalls = [
    ...authorizedChatCalls.filter(isLiveCall),
    ...authorizedChatCalls.filter(call => !isLiveCall(call)).slice(0, 100)
  ].sort((a, b) => Date.parse(latestCallActivityAt(b)) - Date.parse(latestCallActivityAt(a)));

  const handoffs: Array<{
    id: string;
    executionId: string;
    source: 'squad' | 'project_chat';
    squadRunId?: string;
    agentCallId?: string;
    fromAgentId?: string;
    from: string;
    toAgentId?: string;
    to: string;
    summary: string;
    createdAt: string;
    branchName?: string;
  }> = [];

  for (const historicalRun of squadRuns.slice(0, 40)) {
    const runsForThisSquad = projectRuns.filter(run => run.squadRunId === historicalRun.id);
    const runsByAgent = new Map(runsForThisSquad.map(run => [run.agentId, run]));
    for (let nextIndex = 1; nextIndex < historicalRun.memberAgentIds.length; nextIndex += 1) {
      const fromAgentId = historicalRun.memberAgentIds[nextIndex - 1];
      const toAgentId = historicalRun.memberAgentIds[nextIndex];
      if (!visibleAgentIds.has(fromAgentId) || !visibleAgentIds.has(toAgentId)) continue;
      const nextRun = runsByAgent.get(toAgentId);
      if ((historicalRun.currentMemberIndex ?? -1) < nextIndex && !nextRun) continue;
      const fromRun = runsByAgent.get(fromAgentId);
      const from = membersById.get(fromAgentId)?.name ?? fromAgentId;
      const to = membersById.get(toAgentId)?.name ?? toAgentId;
      const executionId = nextRun?.id ?? `${historicalRun.id}:agent:${toAgentId}`;
      handoffs.push({
        id: `${historicalRun.id}:handoff:${nextIndex}`,
        executionId,
        source: 'squad',
        squadRunId: historicalRun.id,
        fromAgentId,
        from,
        toAgentId,
        to,
        summary: describeHandoffWork(fromRun),
        createdAt: nextRun?.createdAt ?? historicalRun.updatedAt,
        branchName: historicalRun.branchName
      });
    }
  }

  for (const call of chatCalls) {
    for (const activity of call.activities.filter(item => item.kind === 'handoff')) {
      const sender = activity.message.match(/^Received project chat context from\s+(.+)$/i)?.[1];
      const senderAgent = sender
        ? Array.from(membersById.values()).find(agent => agent.name.toLocaleLowerCase() === sender.toLocaleLowerCase())
        : undefined;
      const senderIsVisible = Boolean(senderAgent && visibleAgentIds.has(senderAgent.id));
      handoffs.push({
        id: `${call.id}:${activity.id}`,
        executionId: call.id,
        source: 'project_chat',
        agentCallId: call.id,
        from: senderIsVisible ? senderAgent!.name : 'Previous project agent',
        toAgentId: call.agentId,
        to: call.agentName,
        summary: senderAgent && !senderIsVisible
          ? 'Project context was passed to this agent.'
          : activity.detail || activity.message,
        createdAt: activity.createdAt,
        branchName: call.workingBranch
      });
    }
  }
  handoffs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const liveChatCalls = chatCalls.filter(isLiveCall);
  const activeSquadRuns = squadRuns.filter(run => run.status === 'running' || run.status === 'awaiting_approval');
  const activeStandaloneRuns = projectRuns.filter(run =>
    !run.squadRunId && ['queued', 'running', 'validating', 'awaiting_approval'].includes(run.status)
  );
  const hasProjectLiveWork = activeSquadRuns.length > 0 || liveChatCalls.length > 0 || activeStandaloneRuns.length > 0;
  const squadRunsForCards = activeSquadRuns.length
    ? activeSquadRuns
    : hasProjectLiveWork
      ? []
      : selectedRun
        ? [selectedRun]
        : [];
  const agentCards: RoomAgentCard[] = squadRunsForCards.flatMap(projectSquadRun => {
    const squad = squadsById.get(projectSquadRun.squadId);
    if (!squad) return [];
    const runsByAgent = new Map(
      projectRuns.filter(run => run.squadRunId === projectSquadRun.id).map(run => [run.agentId, run])
    );
    return projectSquadRun.memberAgentIds.flatMap((agentId, memberIndex) => {
      if (!visibleAgentIds.has(agentId)) return [];
      const agent = membersById.get(agentId);
      const run = runsByAgent.get(agentId);
      const status = cardStatus(run, projectSquadRun, memberIndex);
      const executionId = run?.id ?? `${projectSquadRun.id}:agent:${agentId}`;
      const handoffActivity = handoffs
        .filter(event => event.executionId === executionId && event.source === 'squad')
        .map((event, index) => ({
          id: event.id,
          sequence: 10000 + index,
          kind: 'handoff' as const,
          message: `Handoff received from ${event.from}`,
          detail: event.summary,
          createdAt: event.createdAt
        }));
      const activity = [...roomRunActivity(run?.activities), ...handoffActivity]
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      return [{
        executionId,
        source: 'squad' as const,
        sourceLabel: `${squad.name} squad`,
        agentId,
        agentName: agent?.name ?? agentId,
        agentRole: agent?.role ?? 'Agent',
        avatar: agent?.avatar,
        color: agent?.color,
        status,
        progress: progressForRun(run),
        currentTask: currentTask(run, status, projectSquadRun.memberAssignments?.find(item => item.agentId === agentId)?.stageLabel),
        currentStage: run?.stages?.[run.currentStageIndex]?.label,
        runId: run?.id,
        squadRunId: projectSquadRun.id,
        activity,
        filePaths: [...new Set(activity.flatMap(item => ('paths' in item ? item.paths ?? [] : [])))],
        branchName: run?.branchName ?? projectSquadRun.branchName,
        updatedAt: run?.updatedAt ?? projectSquadRun.updatedAt,
        isStale: hasStaleAgentSignal(status, run?.updatedAt ?? projectSquadRun.updatedAt),
        output: run?.prUrl
          ? { kind: 'pull_request', label: 'Pull request', value: run.prUrl }
          : run?.branchName || projectSquadRun.branchName
            ? { kind: 'branch', label: 'Working branch', value: run?.branchName ?? projectSquadRun.branchName }
            : undefined
      }];
    });
  });

  for (const run of activeStandaloneRuns) {
    const agent = membersById.get(run.agentId);
    if (!agent) continue;
    const status = cardStatus(run, undefined, 0);
    const issue = issues.find(item => item.id === run.issueId && item.projectId === project.id);
    const activity = roomRunActivity(run.activities);
    agentCards.push({
      executionId: run.id,
      source: 'agent_run',
      sourceLabel: issue?.identifier ? `${issue.identifier} · Direct run` : 'Direct project run',
      agentId: run.agentId,
      agentName: agent.name,
      agentRole: agent.role ?? 'Agent',
      avatar: agent.avatar,
      color: agent.color,
      status,
      progress: progressForRun(run),
      currentTask: currentTask(run, status),
      currentStage: run.stages?.[run.currentStageIndex]?.label,
      runId: run.id,
      activity,
      filePaths: [...new Set(activity.flatMap(item => ('paths' in item ? item.paths ?? [] : [])))],
      branchName: run.branchName,
      updatedAt: run.updatedAt,
      isStale: hasStaleAgentSignal(status, run.updatedAt),
      output: run.prUrl
        ? { kind: 'pull_request', label: 'Pull request', value: run.prUrl }
        : run.branchName
          ? { kind: 'branch', label: 'Working branch', value: run.branchName }
          : undefined
    });
  }

  const orchestrationTaskById = new Map((selectedOrchestration?.tasks ?? []).map(task => [task.id, task]));
  const orchestrationTaskCountByAgent = new Map<string, number>();
  for (const task of selectedOrchestration?.tasks ?? []) {
    if (task.ownerAgentId) orchestrationTaskCountByAgent.set(task.ownerAgentId,
      (orchestrationTaskCountByAgent.get(task.ownerAgentId) ?? 0) + 1);
  }
  for (const run of orchestrationPrototypeRuns) {
    const agent = membersById.get(run.agentId);
    if (!agent) continue;
    const task = run.orchestrationTaskId ? orchestrationTaskById.get(run.orchestrationTaskId) : undefined;
    const taskIndex = task ? selectedOrchestration!.tasks.findIndex(item => item.id === task.id) : -1;
    const attempt = selectedOrchestration?.attempts.find(item => item.prototypeRunId === run.id);
    const status = cardStatus(run, undefined, 0);
    const activity = orchestrationRunActivity(run);
    agentCards.push({
      executionId: run.id,
      source: 'agent_run',
      sourceLabel: taskIndex >= 0
        ? `Orchestrator · Step ${String(taskIndex + 1).padStart(2, '0')}${attempt ? ` · Attempt ${attempt.attemptNumber}${attempt.contextManifest.reportOnlyReportRetry === true ? ' · report format only' : ''}` : ''}`
        : 'Orchestrator assignment',
      agentId: run.agentId,
      agentName: agent.name,
      agentRole: agent.role ?? 'Agent',
      avatar: agent.avatar,
      color: agent.color,
      status,
      progress: progressForRun(run),
      currentTask: attempt?.contextManifest.reportOnlyReportRetry === true
        ? 'Fixing the report format only'
        : task?.title ?? currentTask(run, status),
      currentStage: run.stages?.[run.currentStageIndex]?.label,
      runId: run.id,
      orchestrationTaskId: task?.id,
      orchestrationAttemptNumber: attempt?.attemptNumber,
      orchestrationTaskCount: orchestrationTaskCountByAgent.get(run.agentId) ?? 1,
      activity,
      filePaths: [...new Set(activity.flatMap(item => item.paths ?? []))],
      branchName: run.branchName,
      updatedAt: run.updatedAt,
      isStale: hasStaleAgentSignal(status, run.updatedAt),
      output: run.prUrl
        ? { kind: 'pull_request', label: 'Pull request', value: run.prUrl }
        : run.branchName
          ? { kind: 'branch', label: 'Working branch', value: run.branchName }
          : undefined
    });
  }

  if (selectedOrchestration) {
    const tasksByAgent = new Map<string, typeof selectedOrchestration.tasks>();
    for (const task of selectedOrchestration.tasks) {
      if (!task.ownerAgentId || !visibleAgentIds.has(task.ownerAgentId)) continue;
      const assigned = tasksByAgent.get(task.ownerAgentId) ?? [];
      assigned.push(task);
      tasksByAgent.set(task.ownerAgentId, assigned);
    }
    for (const [agentId, assignedTasks] of tasksByAgent) {
      if (agentCards.some(card => card.source === 'agent_run' && card.agentId === agentId &&
          Boolean(card.runId && orchestrationPrototypeRuns.some(run => run.id === card.runId)))) continue;
      const agent = membersById.get(agentId);
      if (!agent) continue;
      const currentTask = assignedTasks.find(task => ['running', 'submitted', 'ready', 'failed', 'blocked'].includes(task.status)) ??
        assignedTasks.find(task => task.status === 'pending') ?? assignedTasks.at(-1);
      const allAccepted = assignedTasks.every(task => task.status === 'accepted');
      const hasStoppedTask = assignedTasks.some(task => ['failed', 'blocked'].includes(task.status));
      agentCards.push({
        executionId: `planned:${selectedOrchestration.run.id}:${agentId}`,
        source: 'agent_run',
        sourceLabel: 'Orchestrator · Planned',
        agentId,
        agentName: agent.name,
        agentRole: agent.role ?? 'Agent',
        avatar: agent.avatar,
        color: agent.color,
        status: allAccepted ? 'completed' : hasStoppedTask ? 'failed' : 'waiting',
        progress: allAccepted ? 100 : 0,
        currentTask: currentTask?.title ?? 'Waiting for an assignment',
        orchestrationTaskId: currentTask?.id,
        orchestrationTaskCount: assignedTasks.length,
        activity: [],
        filePaths: []
      });
    }
  }

  for (const call of liveChatCalls) {
    const agent = membersById.get(call.agentId);
    if (!agent) continue;
    const status = callCardStatus(call.status);
    const targetLabel = call.target?.label || call.target?.type;
    agentCards.push({
      executionId: call.id,
      source: 'project_chat',
      sourceLabel: 'Project chat',
      agentId: call.agentId,
      agentName: call.agentName,
      agentRole: call.agentRole,
      avatar: agent.avatar,
      color: agent.color,
      status,
      progress: 0,
      currentTask: callTask(call, status, targetLabel),
      currentStage: call.activities.slice().reverse().find(activity => activity.kind === 'stage')?.message,
      agentCallId: call.id,
      activity: call.activities.slice(-40),
      filePaths: [...new Set(call.activities.flatMap(activity => activity.paths ?? []))],
      branchName: call.workingBranch,
      updatedAt: latestCallActivityAt(call),
      isStale: hasStaleAgentSignal(status, latestCallActivityAt(call)),
      output: call.workingBranch
        ? { kind: 'branch', label: 'Working branch', value: call.workingBranch }
        : undefined
    });
  }

  if (agentCards.length === 0 && selectedSquad) {
    agentCards.push(...selectedSquad.memberAgentIds.flatMap((agentId, memberIndex) => {
      if (!visibleAgentIds.has(agentId)) return [];
      const agent = membersById.get(agentId);
      const run = memberRunByAgent.get(agentId);
      const status = cardStatus(run, selectedRun, memberIndex);
      const activity = roomRunActivity(run?.activities);
      return [{
        executionId: run?.id ?? `ready:${selectedSquad.id}:${agentId}`,
        source: 'squad' as const,
        sourceLabel: `${selectedSquad.name} squad`,
        agentId,
        agentName: agent?.name ?? agentId,
        agentRole: agent?.role ?? 'Agent',
        avatar: agent?.avatar,
        color: agent?.color,
        status,
        progress: progressForRun(run),
        currentTask: currentTask(run, status, selectedRun?.memberAssignments?.find(item => item.agentId === agentId)?.stageLabel),
        currentStage: run?.stages?.[run.currentStageIndex]?.label,
        runId: run?.id,
        squadRunId: selectedRun?.id,
        activity,
        filePaths: [...new Set(activity.flatMap(item => ('paths' in item ? item.paths ?? [] : [])))],
        branchName: run?.branchName ?? selectedRun?.branchName,
        updatedAt: run?.updatedAt ?? selectedRun?.updatedAt ?? null,
        isStale: hasStaleAgentSignal(status, run?.updatedAt ?? selectedRun?.updatedAt),
        output: run?.prUrl
          ? { kind: 'pull_request', label: 'Pull request', value: run.prUrl }
          : run?.branchName ?? selectedRun?.branchName
            ? { kind: 'branch', label: 'Working branch', value: run?.branchName ?? selectedRun?.branchName! }
            : undefined
      }];
    }));
  }

  const selectedRunMemberIds = new Set(memberRuns.map(run => run.id));
  const artifactRuns = projectRuns.filter(run => selectedRunMemberIds.has(run.id) || agentCards.some(card => card.runId === run.id));
  const artifacts = artifactRuns.flatMap(run => {
    const agent = membersById.get(run.agentId);
    const rows: Array<Record<string, unknown>> = [];
    if (run.changedFiles) {
      rows.push({
        id: `${run.id}-changes`,
        name: `${agent?.name ?? 'Agent'} changes`,
        kind: 'changes',
        detail: `${run.changedFiles} file${run.changedFiles === 1 ? '' : 's'} changed`,
        status: run.status === 'completed' ? 'ready' : 'in_progress',
        runId: run.id
      });
    }
    if (run.prUrl) {
      rows.push({
        id: `${run.id}-pr`,
        name: 'Pull request',
        kind: 'pull_request',
        detail: run.prUrl,
        status: 'ready',
        runId: run.id
      });
    }
    return rows;
  });

  const completed = agentCards.filter(card => card.status === 'completed').length;
  const running = agentCards.filter(card => card.status === 'running').length;
  const waiting = agentCards.filter(card => card.status === 'waiting').length;
  const review = agentCards.filter(card => card.status === 'review').length;
  const failed = agentCards.filter(card => card.status === 'failed').length;
  const stale = agentCards.filter(card => card.isStale).length;
  const measuredProgress = agentCards.filter(card => card.status !== 'idle' && card.progress > 0);
  const latestChatActivity = chatCalls
    .map(call => latestCallActivityAt(call))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  const currentMemberIndex = selectedRun?.currentMemberIndex ?? -1;
  const currentAgentId = selectedRun?.memberAgentIds?.[currentMemberIndex];
  const currentRun = currentAgentId ? memberRunByAgent.get(currentAgentId) : undefined;
  const previousAgentId = currentMemberIndex > 0 ? selectedRun?.memberAgentIds?.[currentMemberIndex - 1] : undefined;
  const nextAgentId = selectedRun?.memberAgentIds?.[currentMemberIndex + 1];
  const visibleSelectedMemberIds = (selectedRun?.memberAgentIds ?? []).filter(agentId => visibleAgentIds.has(agentId));
  const visibleCurrentMemberIndex = currentAgentId && visibleAgentIds.has(currentAgentId)
    ? visibleSelectedMemberIds.indexOf(currentAgentId)
    : -1;
  const agentName = (id?: string) => id && visibleAgentIds.has(id) ? membersById.get(id)?.name ?? id : undefined;
  const issueForRun = (run?: PrototypeRun) => run
    ? issues.find(issue => issue.id === run.issueId && issue.projectId === project.id)
    : undefined;
  const issueForCall = (call: typeof liveChatCalls[number]) => call.target?.type === 'issue'
    ? issues.find(issue => issue.id === call.target?.id && issue.projectId === project.id)
    : undefined;
  const roomIssue = selectedRun
    ? issues.find(issue => issue.id === selectedRun.issueId && issue.projectId === project.id)
    : activeStandaloneRuns.map(issueForRun).find(Boolean)
      ?? liveChatCalls.map(issueForCall).find(Boolean)
      ?? (selectedSquad ? issues.find(issue => issue.projectId === project.id && issue.assignedSquadId === selectedSquad.id) : undefined)
      ?? issues.find(issue => issue.projectId === project.id);
  const planningReservations = !IS_CLOUD
    ? runWithWorkspace(workspaceId, () => sqliteService.listOrchestrationPlanningReservations(project.id))
    : [];
  const planningRecoveryRecords = !IS_CLOUD
    ? runWithWorkspace(workspaceId, () => sqliteService.listOrchestrationPlanningRecoveries(project.id, 10))
    : [];
  const recoveryByRunId = new Map(planningRecoveryRecords.map(record => [record.runId, record]));
  const planningRecoveries = [
    ...planningReservations.flatMap(reservation => {
      const savedRecovery = recoveryByRunId.get(reservation.runId);
      if (!savedRecovery && reservation.ownerSessionId === orchestrationSessionId) return [];
      return [{
        runId: reservation.runId,
        repository: safeOperationalText(reservation.repository, 180) ?? '',
        branchName: safeOperationalText(reservation.branchName, 180) ?? '',
        baseCommit: reservation.baseCommit,
        state: savedRecovery?.state ?? 'interrupted' as const,
        reason: safeOperationalText(savedRecovery?.reason, 1_000) ?? 'Planning stopped before a task plan was activated. Inspect the saved workspace before continuing.',
        revision: savedRecovery?.revision ?? 0,
        createdAt: savedRecovery?.createdAt ?? reservation.createdAt,
        canPreview: savedRecovery?.state === 'needs_review'
      }];
    }),
    ...planningRecoveryRecords.filter(record => record.state === 'retained' || record.state === 'cleaned').map(record => ({
      runId: record.runId,
      repository: safeOperationalText(record.repository, 180) ?? '',
      branchName: safeOperationalText(record.branchName, 180) ?? '',
      baseCommit: record.baseCommit,
      state: record.state,
      reason: record.state === 'cleaned'
        ? 'The clean interrupted planning workspace was safely removed and repository admission was released.'
        : 'The saved planning workspace was kept and repository admission was released.',
      revision: record.revision,
      createdAt: record.createdAt,
      canPreview: record.state === 'retained'
    }))
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 8);
  const activePlanningReservation = !IS_CLOUD && activeOrchestrationRef?.status === 'planning'
    ? runWithWorkspace(workspaceId, () => sqliteService.getOrchestrationPlanningReservation(project.id, activeOrchestrationRef.repository))
    : undefined;
  const activePlanningRecovery = activePlanningReservation
    ? recoveryByRunId.get(activePlanningReservation.runId)
    : undefined;
  const activePlanningWasInterrupted = Boolean(activePlanningReservation &&
    (activePlanningRecovery || activePlanningReservation.ownerSessionId !== orchestrationSessionId));
  const selectedPlanningReservation = !requestedThreadId && !explicitlySelectedLegacyRun && !selectedOrchestration && !activePlanningWasInterrupted
    ? activePlanningReservation
    : undefined;
  const orchestrationRunOptions = [requestedOrchestration, activeOrchestration, latestOrchestration]
    .filter((item): item is NonNullable<typeof item> => Boolean(item && item.run.projectId === project.id));
  for (const reservation of planningReservations) {
    if (buildRuns.some(item => item.id === reservation.runId) || orchestrationRunOptions.some(item => item.run.id === reservation.runId)) continue;
    const savedRecovery = recoveryByRunId.get(reservation.runId);
    const interrupted = Boolean(savedRecovery || reservation.ownerSessionId !== orchestrationSessionId);
    buildRuns.push({
      id: reservation.runId,
      kind: 'orchestration',
      status: interrupted ? 'recovery_required' : 'planning',
      repository: reservation.repository,
      branchName: reservation.branchName,
      updatedAt: savedRecovery?.updatedAt ?? reservation.createdAt
    });
  }
  for (const candidate of orchestrationRunOptions) {
    if (buildRuns.some(item => item.id === candidate.run.id)) continue;
    const issue = issues.find(item => item.id === candidate.run.issueId && item.projectId === project.id);
    buildRuns.push({
      id: candidate.run.id,
      kind: 'orchestration',
      status: candidate.run.status,
      issueIdentifier: issue?.identifier,
      issueTitle: issue?.title,
      repository: candidate.run.repository,
      branchName: candidate.run.branchName ?? '',
      updatedAt: candidate.run.updatedAt
    });
  }
  if (requestedThreadId) {
    for (let index = buildRuns.length - 1; index >= 0; index -= 1) {
      if (buildRuns[index].id !== selectedOrchestration?.run.id) buildRuns.splice(index, 1);
    }
  }
  buildRuns.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const recoveryState = selectedOrchestration
    ? await orchestrationRecoveryService.getState({
        workspaceId,
        runId: selectedOrchestration.run.id,
        canControl: workspaceRegistry.can(req.workspace!.role, 'squad.run')
      }).catch(() => undefined)
    : undefined;
  const orchestration = selectedOrchestration
    ? safeOrchestrationProjection(selectedOrchestration, membersById, visibleAgentIds, recoveryState?.recovery)
    : selectedPlanningReservation ? {
        run: {
          id: selectedPlanningReservation.runId,
          status: 'planning' as const,
          revision: 0,
          planVersion: 0,
          goal: '',
          exclusions: [],
          repository: safeOperationalText(selectedPlanningReservation.repository, 180) ?? '',
          branchName: safeOperationalText(selectedPlanningReservation.branchName, 180),
          currentTaskId: undefined,
          stoppedReason: undefined,
          createdAt: selectedPlanningReservation.createdAt,
          updatedAt: selectedPlanningReservation.createdAt
        },
        requirements: [], tasks: [], attempts: [], artifacts: [], findings: []
      } : null;
  res.json({
    project: {
      id: project.id,
      name: project.name,
      key: project.key,
      description: project.description,
      color: project.color,
      status: project.status
    },
    squad: selectedSquad ? {
      ...selectedSquad,
      memberAgentIds: selectedSquad.memberAgentIds.filter(agentId => visibleAgentIds.has(agentId)),
      ownerId: workspaceRegistry.squadOwnerId(req.workspace!, selectedSquad.id),
      projectIds: Array.from(projectSquadIds),
      memberCount: selectedSquad.memberAgentIds.filter(agentId => visibleAgentIds.has(agentId)).length
    } : null,
    squads: squads.map(squad => {
      const memberAgentIds = squad.memberAgentIds.filter(agentId => visibleAgentIds.has(agentId));
      return { ...squad, memberAgentIds, memberCount: memberAgentIds.length };
    }),
    eligible: true,
    canRun: Boolean(selectedSquad) && workspaceRegistry.can(req.workspace!.role, 'squad.run'),
    canControlOrchestration: workspaceRegistry.can(req.workspace!.role, 'squad.run'),
    orchestrationResumeAvailable: !IS_CLOUD && ALPHA_ORCHESTRATION_ENABLED,
    canManage: Boolean(selectedSquad && workspaceRegistry.canManageSquad(req.workspace!, selectedSquad.id)),
    status: selectedRun?.status ?? 'idle',
    buildRuns,
    summary: {
      totalAgents: agentCards.length,
      completed,
      running,
      waiting,
      review,
      failed,
      stale,
      progress: measuredProgress.length ? Math.round(measuredProgress.reduce((sum, card) => sum + card.progress, 0) / measuredProgress.length) : 0
    },
    phases: selectedSquad && selectedRun ? phaseRows(
      projectBuildSteps ?? [],
      selectedSquad,
      membersById,
      squadsById,
      visibleAgentIds,
      selectedRun,
      memberRunByAgent
    ) : [],
    issue: selectedOrchestration
      ? issues.find(issue => issue.id === selectedOrchestration.run.issueId && issue.projectId === project.id)
      : roomIssue,
    activeRun: selectedRun ? {
      ...selectedRun,
      mission: safeOperationalText(selectedRun.mission, 700) ?? '',
      plan: selectedRun.plan.map(item => safeOperationalText(item, 360) ?? ''),
      memberAssignments: (selectedRun.memberAssignments ?? [])
        .filter(assignment => visibleAgentIds.has(assignment.agentId))
        .map(assignment => ({
          ...assignment,
          stageLabel: safeOperationalText(assignment.stageLabel, 180) ?? '',
          instructions: safeOperationalText(assignment.instructions, 1000) ?? ''
        })),
      stoppedReason: safeOperationalText(selectedRun.stoppedReason, 500),
      memberAgentIds: visibleSelectedMemberIds,
      currentMemberIndex: visibleCurrentMemberIndex,
      memberRuns: memberRuns.map(safeRoomRun),
      activities: currentRun ? safeRoomRun(currentRun).activities ?? [] : []
    } : null,
    agentCards,
    activity: roomRunActivity(currentRun?.activities),
    handoffs: handoffs.slice(0, 120),
    handoff: {
      from: agentName(previousAgentId) ?? 'Project brief',
      to: agentName(currentAgentId) ?? agentName(selectedSquad?.memberAgentIds[0]) ?? 'No active agent',
      current: agentName(currentAgentId),
      next: agentName(nextAgentId)
    },
    artifacts,
    chatCalls,
    orchestration,
    planningRecoveries,
    lastUpdated: [selectedRun?.updatedAt, selectedOrchestration?.run.updatedAt, selectedPlanningReservation?.createdAt,
      latestChatActivity, ...planningRecoveries.map(recovery => recovery.createdAt),
      ...agentCards.map(card => card.updatedAt ?? undefined), project.createdAt]
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  });
}));
