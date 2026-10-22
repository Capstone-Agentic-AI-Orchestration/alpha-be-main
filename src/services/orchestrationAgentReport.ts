import type { ZodTypeAny } from 'zod';
import {
  orchestrationAgentReportSchema,
  ORCHESTRATION_AGENT_REPORT_SCHEMA_VERSION,
  type OrchestrationAgentReport
} from './orchestrationContract.js';

export type AgentReportValidation =
  | { success: true; report: OrchestrationAgentReport; schemaVersion: number }
  | { success: false; error: string; schemaVersion?: number };

type ReportContract = {
  schema: ZodTypeAny;
  normalize: (value: unknown) => unknown;
};

/** Add a contract here only when Alpha intentionally supports that version. */
const reportContracts: Readonly<Record<number, ReportContract>> = {
  [ORCHESTRATION_AGENT_REPORT_SCHEMA_VERSION]: {
    schema: orchestrationAgentReportSchema,
    normalize: normalizeVersion1Report
  }
};

function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          objects.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
    if (objects.length >= 8) break;
  }
  return objects;
}

function normalizeVersion1Report(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const report = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...report };
  // A blocked or read-only task often delivers no files. An empty list used to
  // reject an otherwise correct report; acceptance still fails any changed
  // file the report does not declare, so the placeholder cannot hide changes.
  if (Array.isArray(report.deliverables) && report.deliverables.length === 0) {
    normalized.deliverables = [{ summary: 'No files delivered; see the summary, evidence, and blockers.', paths: [] }];
  }
  if (Array.isArray(report.requirementCoverage)) {
    normalized.requirementCoverage = report.requirementCoverage.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const coverage = { ...(item as Record<string, unknown>) };
      if (typeof coverage.requirementId !== 'string' && typeof coverage.requirement === 'string') {
        coverage.requirementId = coverage.requirement;
        delete coverage.requirement;
      } else if (coverage.requirementId === coverage.requirement) {
        delete coverage.requirement;
      }
      return coverage;
    });
  }
  if (Array.isArray(report.reportedChecks)) {
    normalized.reportedChecks = report.reportedChecks.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const check = { ...(item as Record<string, unknown>) };
      if (check.script === undefined && typeof check.name === 'string') {
        check.script = check.name;
        delete check.name;
      } else if (check.script === check.name) {
        delete check.name;
      }

      const rawResult = check.result !== undefined ? check.result : check.status;
      const normalizedResult = normalizeReportedCheckResult(rawResult);
      if (normalizedResult !== undefined) {
        check.result = normalizedResult;
        if (check.status !== undefined && normalizeReportedCheckResult(check.status) === normalizedResult) {
          delete check.status;
        }
      }
      return check;
    });
  }
  if (Array.isArray(report.reviewFindings)) {
    normalized.reviewFindings = report.reviewFindings.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const finding = { ...(item as Record<string, unknown>) };
      const aliases: Array<[string, string]> = [
        ['targetTaskId', 'taskId'],
        ['requirementId', 'requirement'],
        ['path', 'file'],
        ['instruction', 'recommendation']
      ];
      for (const [field, alias] of aliases) {
        if (finding[field] === undefined && typeof finding[alias] === 'string') {
          finding[field] = finding[alias];
          delete finding[alias];
        } else if (finding[field] === finding[alias]) {
          delete finding[alias];
        }
      }
      const severity = normalizeReviewFindingSeverity(finding.severity);
      if (severity !== undefined) finding.severity = severity;
      return finding;
    });
  }
  return normalized;
}

/** Convert wording only where its contract meaning is unambiguous. */
function normalizeReportedCheckResult(value: unknown): 'passed' | 'failed' | 'not_run' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['passed', 'pass', 'success', 'successful', 'succeeded', 'ok'].includes(normalized)) return 'passed';
  if (['failed', 'fail', 'failure', 'error', 'errored'].includes(normalized)) return 'failed';
  // A blocked check did not execute. Keep that explanation in evidence and
  // preserve any task-level blocker in the separate blockers field.
  if (['not_run', 'skipped', 'skip', 'not_executed', 'unrun', 'blocked'].includes(normalized)) return 'not_run';
  return undefined;
}

function normalizeReviewFindingSeverity(value: unknown): 'warning' | 'blocking' | 'critical' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['warning', 'warn', 'info', 'informational', 'low', 'minor'].includes(normalized)) return 'warning';
  if (['blocking', 'blocker', 'medium', 'moderate', 'high', 'major'].includes(normalized)) return 'blocking';
  if (['critical', 'severe'].includes(normalized)) return 'critical';
  return undefined;
}

/**
 * Canonicalize and validate a report against its declared version and, when
 * supplied, the exact version bound to the task attempt. This is used at both
 * ingestion and acceptance so replay cannot bypass the same contract.
 */
export function normalizeAndValidateAgentReport(
  value: unknown,
  expectedSchemaVersion?: number
): AgentReportValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { success: false, error: 'The specialist response is not a JSON task-report object.' };
  }
  const declaredVersion = (value as Record<string, unknown>).schemaVersion;
  if (typeof declaredVersion !== 'number' || !Number.isInteger(declaredVersion)) {
    return { success: false, error: 'The specialist report is missing a valid integer schemaVersion.' };
  }
  if (expectedSchemaVersion !== undefined && declaredVersion !== expectedSchemaVersion) {
    return {
      success: false,
      schemaVersion: declaredVersion,
      error: `The task expects specialist report schema version ${expectedSchemaVersion}, but the agent returned version ${declaredVersion}.`
    };
  }
  const contract = reportContracts[declaredVersion];
  if (!contract) {
    return {
      success: false,
      schemaVersion: declaredVersion,
      error: `Alpha does not support specialist report schema version ${declaredVersion}.`
    };
  }
  const parsed = contract.schema.safeParse(contract.normalize(value));
  if (parsed.success) return { success: true, report: parsed.data, schemaVersion: declaredVersion };
  const issues = parsed.error.issues.slice(0, 8).map(issue =>
    `${issue.path.join('.') || 'report'} ${issue.message}`
  );
  return {
    success: false,
    schemaVersion: declaredVersion,
    error: `The specialist report does not match version ${declaredVersion}: ${issues.join('; ')}.`
  };
}

export function parseAgentReport(
  text: string,
  expectedSchemaVersion?: number
): { report?: Record<string, unknown>; error?: string; schemaVersion?: number } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const payload = fenced ? fenced[1] : trimmed;
  const candidates = [payload, ...extractJsonObjects(payload).filter(candidate => candidate !== payload)];
  let lastError = 'The specialist response is not a single valid JSON task report.';
  let lastSchemaVersion: number | undefined;
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const validation = normalizeAndValidateAgentReport(value, expectedSchemaVersion);
    if (validation.schemaVersion !== undefined) lastSchemaVersion = validation.schemaVersion;
    if (validation.success) {
      return {
        report: validation.report as unknown as Record<string, unknown>,
        schemaVersion: validation.schemaVersion
      };
    }
    lastError = validation.error;
  }
  return { error: lastError, schemaVersion: lastSchemaVersion };
}
