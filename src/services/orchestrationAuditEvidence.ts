import path from 'node:path';
import { sameRepository } from '../utils/repositoryName.js';
import fs from 'node:fs';
import { RUNS_DIR } from '../config/env.js';
import { dependencyInputs, readDependencyAuditEvidence } from './dependencyAuditService.js';
import { dependencyAuditEvidenceSchema, type DependencyAuditEvidence } from './dependencyAuditContract.js';
import type { OrchestrationAttemptRecord, OrchestrationSnapshot, OrchestrationTaskRecord } from './orchestrationStateMachine.js';
import { roleCanOwnTask } from './agentRoleContracts.js';

/** Reads only artifacts written by this task's MCP execution, including format-only retries. */
export function taskAuditEvidence(snapshot: OrchestrationSnapshot, task: OrchestrationTaskRecord, attempt: OrchestrationAttemptRecord,
  worktree: string, evidenceIds: readonly string[] | undefined, runsDirectory = RUNS_DIR): DependencyAuditEvidence[] {
  if (!task.dependencyAudit) return [];
  if (!evidenceIds?.length || new Set(evidenceIds).size !== evidenceIds.length) throw new Error('The audit report must reference completed tool evidence exactly once.');
  const directories = snapshot.attempts.filter(candidate => candidate.taskId === task.id && candidate.agentId === attempt.agentId && candidate.createdAt <= attempt.createdAt)
    .flatMap(candidate => candidate.prototypeRunId && path.basename(candidate.prototypeRunId) === candidate.prototypeRunId ? [path.join(runsDirectory, candidate.prototypeRunId, 'audits')] : []);
  const current = dependencyInputs(worktree);
  return evidenceIds.map(id => {
    if (!/^audit-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid audit evidence id.');
    const directory = directories.find(dir => fs.existsSync(path.join(dir, id + '.json')));
    if (!directory) throw new Error('The audit evidence was not produced by this task.');
    const evidence = readDependencyAuditEvidence(directory, [id])[0];
    if (evidence.taskId !== task.id || evidence.repository.toLowerCase() !== (task.repository ?? snapshot.run.repository).toLowerCase() ||
        evidence.purpose !== task.dependencyAudit!.purpose || evidence.level !== task.dependencyAudit!.level || evidence.status === 'error' ||
        evidence.inputHash !== current.inputHash || !/^[a-f0-9]{40,64}$/i.test(evidence.sourceCommit)) {
      throw new Error('Audit evidence is stale, failed, or does not match the approved task/repository/policy.');
    }
    const report = attempt.result?.agentReport as { reviewFindings?: Array<{ severity: string }> } | undefined;
    const routedFindings = task.kind === 'review' && report?.reviewFindings?.some(finding => ['blocking', 'critical'].includes(finding.severity));
    if (task.dependencyAudit!.purpose === 'verification' && (!evidence.passesPolicy || evidence.resolvedFromManifest) && !routedFindings) {
      throw new Error(evidence.resolvedFromManifest ? 'Final dependency verification requires a committed lockfile for reproducible versions.' : 'Security verification still reports vulnerabilities at the approved policy threshold.');
    }
    return evidence;
  });
}

/** Self-checks are useful evidence, but only an accepted independent Security task closes this gate. */
export function finalDependencyAuditProblem(snapshot: OrchestrationSnapshot, repository: string, worktree: string,
  roles: readonly { id: string; role: string }[]): string | undefined {
  const related = snapshot.tasks.filter(task => task.dependencyAudit && sameRepository((task.repository ?? snapshot.run.repository), repository));
  if (!related.some(task => task.required && task.dependencyAudit?.purpose !== 'self-check')) return;
  const current = dependencyInputs(worktree);
  for (const task of related.filter(task => task.required && task.status === 'accepted' && task.dependencyAudit?.purpose === 'verification')) {
    const role = roles.find(agent => agent.id === task.ownerAgentId)?.role;
    if (!role || !roleCanOwnTask('audit', role) || !['audit', 'review'].includes(task.kind)) continue;
    const attempt = [...snapshot.attempts].reverse().find(candidate => candidate.taskId === task.id && candidate.status === 'accepted');
    const records = (attempt?.result?.acceptanceEvidence as Record<string, unknown> | undefined)?.dependencyAudits;
    if (!Array.isArray(records)) continue;
    const valid = records.some(record => {
      const parsed = dependencyAuditEvidenceSchema.safeParse(record);
      return parsed.success && parsed.data.taskId === task.id && sameRepository(parsed.data.repository, repository) &&
        parsed.data.purpose === 'verification' && parsed.data.status !== 'error' && parsed.data.passesPolicy &&
        !parsed.data.resolvedFromManifest && parsed.data.inputHash === current.inputHash && parsed.data.level === task.dependencyAudit!.level;
    });
    if (valid) return;
  }
  return `Security verification is missing or stale for ${repository}. Request a repository-scoped Security re-audit; functional tests and self-checks cannot replace it.`;
}
