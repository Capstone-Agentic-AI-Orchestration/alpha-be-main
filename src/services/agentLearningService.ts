import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sqliteService, type SQLiteService } from './sqliteService.js';
import { agentMemoryDir, ensureMemoryScaffold } from './memoryService.js';

type History = ReturnType<SQLiteService['getAgentBuildHistory']>;

export interface AgentScorecard {
  /** Distinct build tasks this agent worked on. */
  tasks: number;
  /** Tasks accepted on their first work attempt. */
  acceptedFirstTry: number;
  /** Tasks accepted after one or more retries. */
  acceptedAfterRetry: number;
  attempts: number;
  reportFormatRejections: number;
  blockersReported: number;
  scopeRejections: number;
  checkFailures: number;
  /** Blocking or critical findings independent reviewers raised against this agent's work. */
  reviewFindings: number;
  lastWorkedAt?: string;
}

export interface AgentLesson {
  id: string;
  kind: 'report_format' | 'deliverables' | 'scope' | 'checks' | 'read_only' | 'coverage' | 'review';
  text: string;
  occurrences: number;
  lastSeenAt: string;
}

export const MAX_BUILD_LESSONS = 20;
const LESSONS_HEADING = '## Lessons from builds';

const REPORT_INVALID = /^The specialist report (?:is invalid|does not match version \d+): ?(.*)$/s;
/** Scope refusals, in the current wording and the older "belongs to already accepted task" kept in saved history. */
const SCOPE_REJECTION = /which is outside its approved path scope|belongs to already accepted task|which accepted task \S+ delivered/;
const CHAR_LIMIT = /(\w+)(?:\.\d+)? String must contain at most (\d+) character/;

/** A failure reason Alpha recorded, as an instruction the agent can follow next time. */
function lessonFor(reason: string): { kind: AgentLesson['kind']; text: string } | undefined {
  const report = reason.match(REPORT_INVALID);
  if (report) {
    const limit = report[1].match(CHAR_LIMIT);
    if (limit) return { kind: 'report_format', text: 'Keep each ' + limit[1] + ' entry in the task report within ' + limit[2] + ' characters.' };
    if (/deliverables Array must contain at least 1/.test(report[1])) return undefined;
    return { kind: 'report_format', text: 'Return the task report exactly in the JSON shape Alpha shows; a report was rejected for: ' + report[1].replace(/^The specialist report does not match version \d+: /, '').slice(0, 140) };
  }
  if (/does not identify changed file .+ as a deliverable/.test(reason)) {
    return { kind: 'deliverables', text: 'List every file you change under deliverables in the task report.' };
  }
  if (SCOPE_REJECTION.test(reason)) {
    return { kind: 'scope', text: 'Change only files inside the task\'s allowed paths, and leave files from earlier accepted tasks alone unless your task builds on them.' };
  }
  const check = reason.match(/Required check “(.+?)” was not observed passing/);
  if (check) return { kind: 'checks', text: 'Make the required check ' + check[1] + ' pass before you report the task done.' };
  if (/observed verification commands failed/.test(reason)) {
    return { kind: 'checks', text: 'Run the required checks and fix their failures before you report the task done.' };
  }
  if (/planning, review, validation, or delivery task changed repository files/.test(reason)) {
    return { kind: 'read_only', text: 'In planning, review, and validation tasks, read and report only; do not change repository files.' };
  }
  if (/evidence for every assigned requirement|address every acceptance criterion/.test(reason)) {
    return { kind: 'coverage', text: 'Give evidence for every assigned requirement and acceptance criterion exactly once in the task report.' };
  }
  return undefined;
}

export function buildScorecard(history: History): AgentScorecard {
  const work = history.attempts.filter(attempt => !attempt.reportRetry);
  const byTask = new Map<string, typeof history.attempts>();
  for (const attempt of history.attempts) {
    const key = attempt.runId + ':' + attempt.taskId;
    byTask.set(key, [...(byTask.get(key) ?? []), attempt]);
  }
  let acceptedFirstTry = 0;
  let acceptedAfterRetry = 0;
  for (const attempts of byTask.values()) {
    const accepted = attempts.some(attempt => attempt.status === 'accepted');
    if (!accepted) continue;
    // Report-format retries repeat the same work, so one work attempt is a first try.
    if (attempts.filter(attempt => !attempt.reportRetry).length === 1) acceptedFirstTry += 1;
    else acceptedAfterRetry += 1;
  }
  const reasons = history.attempts.map(attempt => attempt.failureReason ?? '');
  return {
    tasks: byTask.size,
    acceptedFirstTry,
    acceptedAfterRetry,
    attempts: work.length,
    reportFormatRejections: reasons.filter(reason => REPORT_INVALID.test(reason)).length,
    blockersReported: reasons.filter(reason => reason.startsWith('The specialist reported a blocker')).length,
    scopeRejections: reasons.filter(reason => SCOPE_REJECTION.test(reason)).length,
    checkFailures: reasons.filter(reason => /Required check “|observed verification commands failed/.test(reason)).length,
    reviewFindings: history.reviewFindings.filter(finding => ['blocking', 'critical'].includes(finding.severity)).length,
    lastWorkedAt: history.attempts.at(-1)?.createdAt
  };
}

/** Lessons drafted from rejections and review findings, most frequent first. */
export function draftLessons(history: History): AgentLesson[] {
  const lessons = new Map<string, AgentLesson>();
  const add = (kind: AgentLesson['kind'], text: string, at: string) => {
    const id = createHash('sha256').update(kind + ':' + text).digest('hex').slice(0, 16);
    const current = lessons.get(id);
    if (current) {
      current.occurrences += 1;
      if (at > current.lastSeenAt) current.lastSeenAt = at;
    } else {
      lessons.set(id, { id, kind, text, occurrences: 1, lastSeenAt: at });
    }
  };
  for (const attempt of history.attempts) {
    const lesson = attempt.failureReason ? lessonFor(attempt.failureReason) : undefined;
    if (lesson) add(lesson.kind, lesson.text, attempt.createdAt);
  }
  for (const finding of history.reviewFindings) {
    if (!['blocking', 'critical'].includes(finding.severity) || !finding.title) continue;
    const where = finding.path ? ' (' + finding.path + ')' : '';
    const fix = finding.instruction ? ' ' + finding.instruction.replace(/\s+/g, ' ').trim() : '';
    add('review', ('A reviewer found: ' + finding.title + where + '.' + fix).slice(0, 240), finding.createdAt);
  }
  return [...lessons.values()].sort((a, b) => b.occurrences - a.occurrences || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export class AgentLessonError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

function learningsFile(agentId: string): string {
  return path.join(agentMemoryDir(agentId), 'learnings.md');
}

/** Lesson lines Alpha added under its own heading in the agent's learnings file. */
function savedLessons(agentId: string): string[] {
  let text = '';
  try { text = fs.readFileSync(learningsFile(agentId), 'utf8'); } catch { return []; }
  const start = text.indexOf(LESSONS_HEADING);
  if (start < 0) return [];
  return text.slice(start + LESSONS_HEADING.length).split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).trim());
}

export class AgentLearningService {
  constructor(private readonly store: SQLiteService = sqliteService) {}

  performance(agentId: string): { scorecard: AgentScorecard; lessons: AgentLesson[]; accepted: string[] } {
    const history = this.store.getAgentBuildHistory(agentId);
    const decided = new Set(this.store.getAgentLessonDecisions(agentId).map(decision => decision.lessonId));
    const accepted = savedLessons(agentId);
    const lessons = draftLessons(history).filter(lesson => !decided.has(lesson.id) && !accepted.includes(lesson.text));
    return { scorecard: buildScorecard(history), lessons, accepted };
  }

  /**
   * Accept a suggested lesson into the agent's memory, or dismiss it.
   *
   * Accepted lessons go under one heading in learnings.md, which is added to
   * the agent's instructions on every run, so the list is capped.
   */
  decide(input: { agentId: string; lessonId: string; action: 'accept' | 'dismiss'; actorId: string }): { accepted: string[] } {
    const lesson = draftLessons(this.store.getAgentBuildHistory(input.agentId)).find(item => item.id === input.lessonId);
    if (!lesson) throw new AgentLessonError('That suggestion is no longer available. Refresh the agent.', 404);
    if (input.action === 'accept') {
      const saved = savedLessons(input.agentId);
      if (!saved.includes(lesson.text)) {
        if (saved.length >= MAX_BUILD_LESSONS) {
          throw new AgentLessonError('This agent already has ' + MAX_BUILD_LESSONS + ' lessons. Remove one from its learnings file before adding another.', 409);
        }
        ensureMemoryScaffold({ agentId: input.agentId });
        const file = learningsFile(input.agentId);
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const next = current.includes(LESSONS_HEADING)
          ? current.replace(/\s*$/, '\n') + '- ' + lesson.text + '\n'
          : current.replace(/\s*$/, '\n\n') + LESSONS_HEADING + '\n\n- ' + lesson.text + '\n';
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, next, 'utf8');
      }
    }
    this.store.saveAgentLessonDecision({
      agentId: input.agentId, lessonId: lesson.id, status: input.action === 'accept' ? 'accepted' : 'dismissed',
      text: lesson.text, decidedBy: input.actorId
    });
    return { accepted: savedLessons(input.agentId) };
  }
}

export const agentLearningService = new AgentLearningService();

