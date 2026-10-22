import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-learning-'));
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const at = (minute: number) => '2026-10-22T10:' + String(minute).padStart(2, '0') + ':00.000Z';
const history = {
  attempts: [
    { runId: 'r1', taskId: 'ui', attemptNumber: 1, status: 'rejected', failureReason: 'The specialist report is invalid: The specialist report does not match version 1: blockers.0 String must contain at most 240 character(s).', reportRetry: false, createdAt: at(1) },
    { runId: 'r1', taskId: 'ui', attemptNumber: 2, status: 'accepted', reportRetry: true, createdAt: at(2) },
    { runId: 'r2', taskId: 'ui', attemptNumber: 1, status: 'rejected', failureReason: 'The task changed README.md, which is outside its approved path scope.', reportRetry: false, createdAt: at(3) },
    { runId: 'r2', taskId: 'ui', attemptNumber: 2, status: 'rejected', failureReason: 'The task changed docs/x.md, which is outside its approved path scope.', reportRetry: false, createdAt: at(4) },
    { runId: 'r2', taskId: 'ui', attemptNumber: 3, status: 'accepted', reportRetry: false, createdAt: at(5) },
    { runId: 'r3', taskId: 'api', attemptNumber: 1, status: 'rejected', failureReason: 'The specialist reported a blocker: docs/payments-api.md is missing.', reportRetry: false, createdAt: at(6) },
    { runId: 'r4', taskId: 'ui', attemptNumber: 1, status: 'rejected', failureReason: 'Required check “test” was not observed passing on this attempt.', reportRetry: false, createdAt: at(7) }
  ],
  reviewFindings: [
    { runId: 'r2', taskId: 'ui', severity: 'blocking', path: 'src/App.tsx', title: 'Amounts render without the currency symbol', instruction: 'Use formatCurrency for every amount.', status: 'resolved', createdAt: at(8) },
    { runId: 'r2', taskId: 'ui', severity: 'warning', path: 'src/App.css', title: 'Unused class', status: 'open', createdAt: at(9) }
  ]
};

function fakeStore() {
  const decisions: any[] = [];
  return {
    decisions,
    getAgentBuildHistory: () => history,
    getAgentLessonDecisions: () => decisions,
    saveAgentLessonDecision: (input: any) => {
      const index = decisions.findIndex(item => item.lessonId === input.lessonId);
      const row = { lessonId: input.lessonId, status: input.status, text: input.text, decidedBy: input.decidedBy, decidedAt: at(30) };
      if (index >= 0) decisions[index] = row; else decisions.push(row);
    }
  };
}

describe('agent scorecard and lessons', () => {
  it('scores first-try acceptance, counting report-format retries as the same try', async () => {
    const { buildScorecard } = await import('./agentLearningService.js');
    expect(buildScorecard(history as any)).toMatchObject({
      tasks: 4, acceptedFirstTry: 1, acceptedAfterRetry: 1, attempts: 6,
      reportFormatRejections: 1, blockersReported: 1, scopeRejections: 2, checkFailures: 1, reviewFindings: 1
    });
  });

  it('drafts one instruction per kind of mistake, plus blocking review findings, and none for honest blockers', async () => {
    const { draftLessons } = await import('./agentLearningService.js');
    const lessons = draftLessons(history as any);
    expect(lessons.map(lesson => lesson.text)).toEqual([
      'Change only files inside the task\'s allowed paths, and leave files owned by earlier accepted tasks alone.',
      'A reviewer found: Amounts render without the currency symbol (src/App.tsx). Use formatCurrency for every amount.',
      'Make the required check test pass before you report the task done.',
      'Keep each blockers entry in the task report within 240 characters.'
    ]);
    expect(lessons[0].occurrences).toBe(2);
  });

  it('writes an accepted lesson to the agent memory file once, and hides decided suggestions', async () => {
    const { AgentLearningService } = await import('./agentLearningService.js');
    const store = fakeStore();
    const service = new AgentLearningService(store as any);
    const [first, second] = service.performance('agent-frontend').lessons;
    service.decide({ agentId: 'agent-frontend', lessonId: first.id, action: 'accept', actorId: 'lloyd' });
    service.decide({ agentId: 'agent-frontend', lessonId: first.id, action: 'accept', actorId: 'lloyd' });
    service.decide({ agentId: 'agent-frontend', lessonId: second.id, action: 'dismiss', actorId: 'lloyd' });
    const file = fs.readFileSync(path.join(tmp, 'memory', 'agents', 'agent-frontend', 'learnings.md'), 'utf8');
    expect(file).toContain('## Lessons from builds\n\n- ' + first.text);
    expect(file.split(first.text).length - 1).toBe(1);
    expect(file).not.toContain(second.text);
    const after = service.performance('agent-frontend');
    expect(after.accepted).toEqual([first.text]);
    expect(after.lessons.map(lesson => lesson.id)).not.toContain(first.id);
    expect(after.lessons.map(lesson => lesson.id)).not.toContain(second.id);
  });

  it('keeps the memory file short', async () => {
    const { AgentLearningService, MAX_BUILD_LESSONS } = await import('./agentLearningService.js');
    const dir = path.join(tmp, 'memory', 'agents', 'agent-frontend');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'learnings.md'), '## Lessons from builds\n\n' + Array.from({ length: MAX_BUILD_LESSONS }, (_, i) => '- lesson ' + i).join('\n') + '\n');
    const service = new AgentLearningService(fakeStore() as any);
    const [lesson] = service.performance('agent-frontend').lessons;
    expect(() => service.decide({ agentId: 'agent-frontend', lessonId: lesson.id, action: 'accept', actorId: 'lloyd' }))
      .toThrow(/already has 20 lessons/);
  });
});

