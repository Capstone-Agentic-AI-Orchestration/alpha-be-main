import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOrchestrationPlan } from './orchestrationContract.js';
import { OrchestrationService, type OrchestrationLaunchRequest } from './orchestrationService.js';
import { SQLiteService } from './sqliteService.js';
import { TaskAcceptanceService, finalValidationBlockReason, pathMatchesScope } from './taskAcceptanceService.js';
import { runWithWorkspace } from './workspaceContext.js';
import { getHeadCommit } from '../utils/gitUtils.js';

const workspaceId = 'workspace-acceptance-test';
const projectId = 'project-acceptance-test';
const issueId = 'issue-acceptance-test';

async function startAndApprove(orchestration: OrchestrationService, input: any) {
  const plan = await orchestration.start(input);
  return orchestration.startPlannedWork({
    workspaceId: input.workspaceId,
    runId: plan.run.id,
    expectedRevision: plan.run.revision,
    actorId: input.createdBy
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '--all']);
  execFileSync('git', [
    '-c', 'user.name=Alpha Test', '-c', 'user.email=alpha-test@example.com', 'commit', '-m', message
  ], { cwd, stdio: 'ignore' });
  return git(cwd, ['rev-parse', 'HEAD']);
}

function completedRun(
  request: OrchestrationLaunchRequest,
  resultCommit: string,
  changedPaths: string[],
  reportOverrides: Record<string, unknown> = {}
) {
  const report = {
    schemaVersion: 1,
    taskId: request.taskId,
    summary: 'The task endpoint is implemented.',
    requirementCoverage: request.taskPackage.requirements.map(requirement => ({
      requirementId: requirement.id, evidence: 'The API implementation provides this behavior.'
    })),
    criteriaEvidence: request.taskPackage.task.acceptanceCriteria.map(criterion => ({
      criterion, evidence: 'The implementation and observed task checks provide evidence.'
    })),
    deliverables: [{ summary: 'Task API changes and supporting correction.', paths: changedPaths }],
    reportedChecks: request.taskPackage.task.requiredChecks.map(script => ({
      script, result: 'not_run' as const, evidence: 'Alpha executes the registered check after the agent exits.'
    })),
    blockers: [],
    ...(request.taskKind === 'review' ? { reviewFindings: [] } : {}),
    ...(request.taskPackage.findingIds.length ? {
      findingCoverage: request.taskPackage.findingIds.map(findingId => ({
        findingId, evidence: 'The correction changed the reported behavior and its registered check now covers the case.'
      }))
    } : {}),
    ...reportOverrides
  };
  return {
    id: `prototype-${request.attemptId}`,
    workspaceId,
    projectId,
    issueId,
    agentId: request.ownerAgentId,
    orchestrationRunId: request.runId,
    orchestrationTaskId: request.taskId,
    orchestrationAttemptId: request.attemptId,
    status: 'completed',
    branchName: request.branchName,
    checkpointCommit: resultCommit,
    changedFiles: 1,
    insertions: 2,
    deletions: 0,
    activities: [{ id: 'summary', sequence: 1, kind: 'assistant', message: JSON.stringify(report), createdAt: '2026-10-19T00:00:00.000Z' }],
    stages: [{ id: 'tests', status: 'success' }],
    verificationEvidence: {
      status: 'passed',
      missingScripts: [],
      commands: [{ script: 'test', display: 'npm test', exitCode: 0, signal: null }]
    },
    testSummary: 'Verification passed: npm test.'
  } as any;
}

describe('task acceptance scope matching', () => {
  it('says exactly why final validation stopped', () => {
    const passed = { status: 'passed' as const, missingScripts: [], summary: 'ok', commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }] };
    const failed = { status: 'failed' as const, missingScripts: [], summary: 'lint failed', commands: [{ command: { script: 'lint', bin: 'npm', args: ['run', 'lint'], display: 'npm run lint' }, exitCode: 1, signal: null, output: '' }] };
    const finding = (title: string) => ({ id: title, runId: 'r', taskId: 't', sourceTaskId: 's', severity: 'blocking', evidence: { title }, status: 'open', createdAt: '' });
    expect(finalValidationBlockReason([{ repository: 'acme/shop-fe', verification: passed }], [finding('Token in local storage')]))
      .toBe('Every final check passed, but 1 blocking review finding is still open: “Token in local storage”.');
    expect(finalValidationBlockReason([{ repository: 'acme/shop-fe', verification: passed }, { repository: 'acme/shop-be', verification: failed }], []))
      .toBe('Final checks failed: shop-be: npm run lint (exit 1).');
  });

  it('supports nested globs without letting a single star cross directories', () => {
    expect(pathMatchesScope('src/api/handler.ts', 'src/**')).toBe(true);
    expect(pathMatchesScope('src/api/handler.test.ts', '**/*.test.ts')).toBe(true);
    expect(pathMatchesScope('src/api/handler.ts', 'src/*')).toBe(false);
  });
});

describe('task acceptance and targeted correction', () => {
  let directory = '';
  let store: SQLiteService | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    // Windows can hold a folder for a moment after git or SQLite let go of it.
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    directory = '';
  });

  it('retries a task a file tool stopped, with how to get past it, instead of blocking the build', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-tool-blocker-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'App.tsx'), 'export const App = () => null;\n');
    commit(repository, 'Initial fixture');
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'tool blocker fixture'));
    const launches: OrchestrationLaunchRequest[] = [];
    let branchName = '';
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'HEAD', workingDir: repository };
      },
      async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
    });
    const plan = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Build the tracker UI.', exclusions: [],
      requirements: [{ id: 'REQ-UI', description: 'Show the tracker.' }],
      tasks: [{ id: 'tracker-ui', title: 'Build the tracker UI', description: 'Replace the App component.', kind: 'frontend', ownerAgentId: 'frontend-agent',
        dependsOn: [], requirementIds: ['REQ-UI'], acceptanceCriteria: ['The tracker renders.'], requiredChecks: ['test'], scope: { includePaths: ['src/**'], excludePaths: [] } }] });
    let snapshot = await startAndApprove(orchestration, { workspaceId, projectId, issueId, repository: 'acme/tracker', requestKey: 'request-tool-blocker',
      requestFingerprint: 'fingerprint-tool-blocker', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents: [{ id: 'frontend-agent', role: 'Frontend Agent' }] as const, plan });
    const first = launches[0];
    const blocker = 'The scoped project file tool rejected replacement of src/App.tsx because its exact-content guard did not match.';
    snapshot = (await orchestration.handleRunnerCompleted(completedRun(first, await getHeadCommit(repository), [], { blockers: [blocker] })))!;
    const acceptance = new TaskAcceptanceService(store, orchestration, { worktreePathFor: () => repository,
      runVerification: async () => ({ status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }] }) });

    const outcome = await acceptance.evaluateAndAccept({ workspaceId, runId: snapshot.run.id, taskId: 'tracker-ui', attemptId: first.attemptId, acceptedBy: 'orchestrator' });

    expect(outcome.decision).toBe('retrying');
    expect(outcome.snapshot.run.status).toBe('executing');
    expect(launches).toHaveLength(2);
    expect(launches[1].taskPackage.corrections.join(' ')).toContain('This is not a product blocker. Re-read the file and retry');
  });

  /** Your "hello" build: a building task that changed nothing, or claims a file it never touched, is sent back. */
  describe('accepting a building task on the evidence of its code', () => {
    const setUp = async (name: string) => {
      const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
      fs.mkdirSync(tempRoot, { recursive: true });
      directory = fs.mkdtempSync(path.join(tempRoot, name));
      const repository = path.join(directory, 'repository');
      fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
      git(directory, ['init', '-b', 'main', repository]);
      fs.writeFileSync(path.join(repository, 'src', 'App.tsx'), 'export const App = () => null;\n');
      commit(repository, 'Initial fixture');
      store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
      runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'evidence fixture'));
      const launches: OrchestrationLaunchRequest[] = [];
      let branchName = '';
      const orchestration = new OrchestrationService(store, {
        async prepare(request) {
          branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
          if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
          return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'HEAD', workingDir: repository };
        },
        async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
      });
      const plan = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Build the homepage.', exclusions: [],
        requirements: [{ id: 'REQ-HOME', description: 'Show the homepage.' }],
        tasks: [{ id: 'homepage', title: 'Build the homepage', description: 'Replace the App component.', kind: 'frontend', ownerAgentId: 'frontend-agent',
          dependsOn: [], requirementIds: ['REQ-HOME'], acceptanceCriteria: ['The homepage renders.'], requiredChecks: ['test'], scope: { includePaths: ['src/**'], excludePaths: [] } }] });
      const snapshot = await startAndApprove(orchestration, { workspaceId, projectId, issueId, repository: 'acme/site', requestKey: 'request-' + name,
        requestFingerprint: 'fingerprint-' + name, createdBy: 'user-test', executorId: 'desktop-test',
        eligibleAgents: [{ id: 'frontend-agent', role: 'Frontend Agent' }] as const, plan });
      const acceptance = new TaskAcceptanceService(store, orchestration, { worktreePathFor: () => repository,
        runVerification: async () => ({ status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
          commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }] }) });
      return { repository, launches, orchestration, acceptance, runId: snapshot.run.id };
    };

    it('sends back a building task that changed no files, however good its report sounds', async () => {
      const { repository, launches, orchestration, acceptance, runId } = await setUp('alpha-no-changes-');
      const first = launches[0];
      await orchestration.handleRunnerCompleted(completedRun(first, await getHeadCommit(repository), [], { summary: 'Run finished: 5 file(s) changed.' }));
      const outcome = await acceptance.evaluateAndAccept({ workspaceId, runId, taskId: 'homepage', attemptId: first.attemptId, acceptedBy: 'orchestrator' });
      expect(outcome.decision).toBe('retrying');
      expect(launches[1].taskPackage.corrections.join(' ')).toContain('This task changed no files.');
    });

    it('sends back a report that claims a file the task did not change', async () => {
      const { repository, launches, orchestration, acceptance, runId } = await setUp('alpha-claimed-unchanged-');
      const first = launches[0];
      fs.writeFileSync(path.join(repository, 'src', 'App.tsx'), 'export const App = () => "Home";\n');
      const resultCommit = commit(repository, 'Homepage');
      await orchestration.handleRunnerCompleted(completedRun(first, resultCommit, ['src/App.tsx', 'src/App.css']));
      const outcome = await acceptance.evaluateAndAccept({ workspaceId, runId, taskId: 'homepage', attemptId: first.attemptId, acceptedBy: 'orchestrator' });
      expect(outcome.decision).toBe('retrying');
      expect(launches[1].taskPackage.corrections.join(' ')).toContain('The report lists src/App.css as a deliverable, but this task did not change it.');
    });
  });

  it('sends back a task whose own diff removes a test that was there before it started', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-own-test-weakening-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'tests'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    const existingTests = 'import { total } from "../src/cart";\nit("adds items", () => { expect(total([1, 2])).toBe(3); });\nit("handles an empty cart", () => { expect(total([])).toBe(0); });\n';
    fs.writeFileSync(path.join(repository, 'tests', 'cart.test.ts'), existingTests);
    commit(repository, 'Initial fixture');
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'own test weakening fixture'));
    const launches: OrchestrationLaunchRequest[] = [];
    let branchName = '';
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'HEAD', workingDir: repository };
      },
      async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
    });
    const plan = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Add discounts to the cart.', exclusions: [],
      requirements: [{ id: 'REQ-DISCOUNT', description: 'Apply discounts.' }],
      tasks: [{ id: 'cart-discounts', title: 'Add cart discounts', description: 'Apply discounts in the cart total.', kind: 'backend', ownerAgentId: 'backend-agent',
        dependsOn: [], requirementIds: ['REQ-DISCOUNT'], acceptanceCriteria: ['Discounts apply.'], requiredChecks: ['test'], scope: { includePaths: ['src/**', 'tests/**'], excludePaths: [] } }] });
    let snapshot = await startAndApprove(orchestration, { workspaceId, projectId, issueId, repository: 'acme/cart', requestKey: 'request-own-weakening',
      requestFingerprint: 'fingerprint-own-weakening', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan });
    const first = launches[0];
    // The specialist "fixed" a failing case by deleting it and added a test of its own.
    fs.writeFileSync(path.join(repository, 'tests', 'cart.test.ts'),
      'import { total } from "../src/cart";\nit("adds items", () => { expect(total([1, 2])).toBe(3); });\nit("applies a discount", () => { expect(total([10], 0.5)).toBe(5); });\n');
    const resultCommit = commit(repository, 'Discounts');
    snapshot = (await orchestration.handleRunnerCompleted(completedRun(first, resultCommit, ['tests/cart.test.ts'])))!;
    const acceptance = new TaskAcceptanceService(store, orchestration, { worktreePathFor: () => repository,
      runVerification: async () => ({ status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }] }) });

    const outcome = await acceptance.evaluateAndAccept({ workspaceId, runId: snapshot.run.id, taskId: 'cart-discounts', attemptId: first.attemptId, acceptedBy: 'orchestrator' });

    expect(outcome.decision).toBe('retrying');
    expect(outcome.snapshot.findings).toContainEqual(expect.objectContaining({
      evidence: expect.objectContaining({ check: 'test_weakened', changedPath: 'tests/cart.test.ts' })
    }));
    expect(launches).toHaveLength(2);
    expect(launches[1].taskPackage.corrections.join(' ')).toContain('replaced test cases (“handles an empty cart”)');
    // The finding lists every test it names, for the person to retire.
    expect(outcome.snapshot.findings).toContainEqual(expect.objectContaining({
      evidence: expect.objectContaining({ check: 'test_weakened', testTitles: ['handles an empty cart'] })
    }));

    // The person retires that test as obsolete: the same change now passes, and the other tests stay held.
    runWithWorkspace(workspaceId, () => (store as unknown as { appendOrchestrationEvent: (...args: unknown[]) => void }).appendOrchestrationEvent(
      snapshot.run.id, 'tests_retired', { tests: [{ taskId: 'cart-discounts', repository: 'acme/cart', path: 'tests/cart.test.ts',
        titles: ['handles an empty cart'], actorId: 'user-test', retiredAt: '2026-11-26T00:00:00.000Z' }] }, 'user-test'));
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'src', 'cart.ts'), 'export const total = (items: number[], discount = 0) => items.reduce((a, b) => a + b, 0) * (1 - discount);\n');
    const retryCommit = commit(repository, 'Discounts, again');
    snapshot = (await orchestration.handleRunnerCompleted(completedRun(launches[1], retryCommit, ['tests/cart.test.ts', 'src/cart.ts'])))!;
    const retried = await acceptance.evaluateAndAccept({ workspaceId, runId: snapshot.run.id, taskId: 'cart-discounts', attemptId: launches[1].attemptId, acceptedBy: 'orchestrator' });
    expect(retried.snapshot.attempts.find(item => item.id === launches[1].attemptId)?.status).toBe('accepted');
  });

  describe('an Orchestrator fix is held to what it was cleared to change', () => {
    /** A build whose only task is being retried under an Orchestrator resolution; the retry changes `files`. */
    async function retryUnderResolution(files: Record<string, string>, resolution: Record<string, unknown> = {}, addedByOrchestrator = false,
      initialFiles: Record<string, string> = {}) {
      const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
      fs.mkdirSync(tempRoot, { recursive: true });
      directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-fix-bounds-'));
      const repository = path.join(directory, 'repository');
      fs.mkdirSync(path.join(repository, 'src', 'auth'), { recursive: true });
      git(directory, ['init', '-b', 'main', repository]);
      fs.writeFileSync(path.join(repository, 'src', 'cart.ts'), 'export const total = (items: number[]) => items.reduce((a, b) => a + b, 0);\n');
      fs.writeFileSync(path.join(repository, 'src', 'auth', 'session.ts'), 'export const SESSION_COOKIE = "sid";\n');
      for (const [file, content] of Object.entries(initialFiles)) fs.writeFileSync(path.join(repository, file), content);
      commit(repository, 'Initial fixture');
      store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
      runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'fix bounds fixture'));
      const launches: OrchestrationLaunchRequest[] = [];
      let branchName = '';
      const orchestration = new OrchestrationService(store, {
        async prepare(request) {
          branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
          if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
          return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'HEAD', workingDir: repository };
        },
        async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
      });
      const plan = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Add discounts to the cart.', exclusions: [],
        requirements: [{ id: 'REQ-DISCOUNT', description: 'Apply discounts.' }],
        tasks: [{ id: 'cart-discounts', title: 'Add cart discounts', description: 'Apply discounts in the cart total.', kind: 'backend', ownerAgentId: 'backend-agent',
          dependsOn: [], requirementIds: ['REQ-DISCOUNT'], acceptanceCriteria: ['Discounts apply.'], requiredChecks: ['test'], scope: { includePaths: ['src/**'], excludePaths: [] } }] });
      let snapshot = await startAndApprove(orchestration, { workspaceId, projectId, issueId, repository: 'acme/cart', requestKey: 'request-fix-bounds',
        requestFingerprint: 'fingerprint-fix-bounds', createdBy: 'user-test', executorId: 'desktop-test',
        eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan });
      runWithWorkspace(workspaceId, () => store!.saveOrchestrationRecoveryEpisode({ episode: {
        id: 'recovery-fix-bounds', workspaceId, projectId: snapshot.run.projectId, runId: snapshot.run.id, issueId: snapshot.run.issueId,
        taskId: 'cart-discounts', source: 'acceptance', category: 'project_code', code: 'acceptance_project_code', summary: 'Lint failed.',
        fingerprint: 'f', phase: addedByOrchestrator ? 'resolved' : 'repairing', episodeNumber: 1, repairBudget: 4, attemptsUsed: 3, initiatedBy: 'orchestrator', revision: 0,
        createdAt: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T10:00:00.000Z',
        evidence: { resolution: addedByOrchestrator
          // The Orchestrator added this task to the plan on its own (a missing prerequisite).
          ? { outcome: 'prerequisite_added', fingerprint: 'f', turn: true, startedAt: '', tier: 1,
            proposedPrerequisite: { summary: 'Add one task.', tasks: [], fitCheck: [], addedTaskIds: ['cart-discounts'] }, ...resolution }
          : { outcome: 'retrying', fingerprint: 'f', turn: true, startedAt: '', tier: 0, priorChangedPaths: [],
            proposedFix: { instructions: 'Apply the discount in src/cart.ts.', expectedFiles: [{ repository: 'acme/cart', path: 'src/cart.ts' }] }, ...resolution } }
      } }));
      const first = launches[0];
      for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(repository, file), content);
      const resultCommit = commit(repository, 'Orchestrator fix retry');
      snapshot = (await orchestration.handleRunnerCompleted(completedRun(first, resultCommit, Object.keys(files))))!;
      const acceptance = new TaskAcceptanceService(store, orchestration, { worktreePathFor: () => repository,
        runVerification: async () => ({ status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
          commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }] }) });
      const outcome = await acceptance.evaluateAndAccept({ workspaceId, runId: snapshot.run.id, taskId: 'cart-discounts', attemptId: first.attemptId, acceptedBy: 'orchestrator' });
      return { outcome, launches, attempt: outcome.snapshot.attempts.find(item => item.id === first.attemptId)! };
    }

    const discounted = 'export const total = (items: number[], discount = 0) => items.reduce((a, b) => a + b, 0) * (1 - discount);\n';

    it('holds a retry that touched a sensitive path for the person, without an automatic repair', async () => {
      const { outcome, launches, attempt } = await retryUnderResolution({
        'src/cart.ts': discounted,
        'src/auth/session.ts': 'export const SESSION_COOKIE = "session";\n'
      });
      expect(outcome.decision).toBe('rejected');
      expect(outcome.snapshot.run.status).toBe('blocked');
      expect(attempt.status).toBe('rejected');
      expect(outcome.snapshot.findings).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({
        check: 'orchestrator_fix_review', sensitivePaths: ['src/auth/session.ts'], outsidePaths: ['src/auth/session.ts']
      }) }));
      expect(launches).toHaveLength(1);
    });

    it('accepts a retry that stayed within its expected files', async () => {
      const { outcome, attempt } = await retryUnderResolution({ 'src/cart.ts': discounted });
      expect(outcome.decision).not.toBe('blocked');
      expect(attempt.status).toBe('accepted');
    });

    it('holds work from a task the Orchestrator added that changed a sensitive area, whatever its scope said', async () => {
      // The task's scope (src/**) did not name the auth folder; what it changed decides.
      const { outcome, launches, attempt } = await retryUnderResolution({
        'src/cart.ts': discounted,
        'src/auth/session.ts': 'export const SESSION_COOKIE = "session";\n'
      }, {}, true);
      expect(outcome.decision).toBe('rejected');
      expect(attempt.status).toBe('rejected');
      expect(attempt.failureReason).toContain('added by the Orchestrator');
      expect(outcome.snapshot.findings).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({
        check: 'orchestrator_fix_review', sensitivePaths: ['src/auth/session.ts'], outsidePaths: [] }) }));
      expect(launches).toHaveLength(1);
    });

    it('accepts an added task that stayed out of sensitive areas, and one the person added', async () => {
      expect((await retryUnderResolution({ 'src/cart.ts': discounted }, {}, true)).attempt.status).toBe('accepted');
      const personAdded = await retryUnderResolution({ 'src/cart.ts': discounted, 'src/auth/session.ts': 'export const SESSION_COOKIE = "session";\n' },
        { appliedBy: 'pm-1' }, true);
      expect(personAdded.attempt.status).toBe('accepted');
    });

    describe('a fix cleared to put weakened tests back', () => {
      const cartTest = 'import { total } from "./cart";\nit("adds items", () => { expect(total([1, 2])).toBe(3); });\n';
      const restoring = {
        restoreTests: ['src/cart.test.ts'], priorChangedPaths: ['src/cart.test.ts'],
        proposedFix: { instructions: 'Put the cart test back.', expectedFiles: [{ repository: 'acme/cart', path: 'src/cart.ts' }, { repository: 'acme/cart', path: 'src/cart.test.ts' }] }
      };

      it('accepts a retry that has every original test back word for word, plus its own', async () => {
        const { attempt } = await retryUnderResolution({
          'src/cart.ts': discounted,
          'src/cart.test.ts': `${cartTest}it("applies a discount", () => { expect(total([10], 0.5)).toBe(5); });\n`
        }, restoring, false, { 'src/cart.test.ts': cartTest });
        expect(attempt.status).toBe('accepted');
      });

      it('holds a retry whose test kept its title and assertion count but checks something else', async () => {
        // The ordinary test guard counts assertions and would let this through; the fix was cleared only to restore.
        const { outcome, launches, attempt } = await retryUnderResolution({
          'src/cart.ts': discounted,
          'src/cart.test.ts': cartTest.replace('toBe(3)', 'toBeGreaterThan(0)')
        }, restoring, false, { 'src/cart.test.ts': cartTest });
        expect(attempt.status).toBe('rejected');
        expect(attempt.failureReason).toContain('not back word for word');
        expect(outcome.snapshot.findings).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({
          check: 'orchestrator_fix_review', unrestoredTests: [{ path: 'src/cart.test.ts', titles: ['adds items'] }] }) }));
        expect(launches).toHaveLength(1);
      });
    });

    it('accepts a fix the person applied, even in a sensitive area', async () => {
      const { outcome, attempt } = await retryUnderResolution({
        'src/cart.ts': discounted,
        'src/auth/session.ts': 'export const SESSION_COOKIE = "session";\n'
      }, { appliedBy: 'pm-1', tier: 2 });
      expect(outcome.decision).not.toBe('blocked');
      expect(attempt.status).toBe('accepted');
    });
  });

  it('completes an accepted read-only report without a publication stage', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'report-completion-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(repository);
    git(repository, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(repository, 'README.md'), 'Report-only fixture\n');
    const baseCommit = commit(repository, 'Base');
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'read-only fixture'));
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        const branchName = `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: baseCommit, branchName, baseRef: 'main', workingDir: repository };
      },
      async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
    });
    const plan = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Inspect repository status',
      requirements: [{ id: 'R1', description: 'Report the repository state.' }],
      tasks: [{ id: 'inspect', title: 'Inspect repository', description: 'Read and report.', kind: 'requirements', ownerAgentId: 'manager',
        dependsOn: [], requirementIds: ['R1'], acceptanceCriteria: ['Repository state is reported.'], requiredChecks: [],
        scope: { includePaths: [], excludePaths: [] } }] });
    let current = await startAndApprove(orchestration, { workspaceId, projectId, issueId, repository: 'acme/report',
      requestKey: 'report', requestFingerprint: 'report', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents: [{ id: 'manager', role: 'Manager Agent' }], plan, baseRef: 'main' });
    const request = launches[0];
    current = (await orchestration.handleRunnerCompleted(completedRun(request, baseCommit, [], { summary: 'Repository inspected.', deliverables: [{ summary: 'No unpushed changes.', paths: [] }] })))!;
    const runVerification = vi.fn();
    const acceptance = new TaskAcceptanceService(store, orchestration, { worktreePathFor: () => repository, runVerification });
    const outcome = await acceptance.evaluateAndAccept({ workspaceId, runId: current.run.id, taskId: request.taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator' });
    expect(outcome.decision, outcome.reason).toBe('completed');
    expect(outcome.snapshot.run.status).toBe('completed');
    expect(runVerification).not.toHaveBeenCalled();
    const events = runWithWorkspace(workspaceId, () => store!.listOrchestrationEvents(current.run.id));
    expect(events.some(event => event.type === 'run_awaiting_approval')).toBe(false);
    expect(events.at(-1)?.payload.evidence).toMatchObject({ completionType: 'report_only', noOpenBlockingFindings: true });
    expect(store.listAllPublishedOrchestrationSnapshots().some(snapshot => snapshot.run.id === current.run.id)).toBe(true);
  });

  it('allows scoped evolution of an accepted file in a persisted later milestone', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-milestone-evolution-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'), 'export const version = 0;\n');
    commit(repository, 'Initial fixture');
    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'milestone fixture'));
    const eligibleAgents = [{ id: 'backend-agent', role: 'Backend Agent' }] as const;
    vi.spyOn(store, 'getAgents').mockReturnValue(eligibleAgents as any);
    const plan = parseOrchestrationPlan({ schemaVersion: 2, goal: 'Create then extend the API.',
      requirements: [{ id: 'CREATE', description: 'Create API.' }, { id: 'EXTEND', description: 'Extend the accepted API.' }],
      milestones: [
        { id: 'first', title: 'Create', objective: 'Create API.', requirementIds: ['CREATE'], repositories: ['acme/api'] },
        { id: 'second', title: 'Extend', objective: 'Extend API.', requirementIds: ['EXTEND'], repositories: ['acme/api'] }
      ], tasks: [{ id: 'create', milestoneId: 'first', title: 'Create API', description: 'Implement API.', kind: 'backend', repository: 'acme/api', ownerAgentId: 'backend-agent',
        requirementIds: ['CREATE'], acceptanceCriteria: ['API works.'], requiredChecks: ['test'], scope: { includePaths: ['src/api.ts'], excludePaths: [] } }] });
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        const branchName = `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'main', workingDir: repository };
      },
      async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
    }, undefined, async () => ({ checkpoints: [{ repository: 'acme/api', commit: await getHeadCommit(repository) }],
      tasks: [{ ...plan.tasks[0], id: 'extend', milestoneId: 'second', requirementIds: ['EXTEND'], title: 'Extend API' }] }));
    let current = await startAndApprove(orchestration, { workspaceId, projectId, issueId, repository: 'acme/api',
      requestKey: 'milestone-evolution', requestFingerprint: 'milestone-evolution', createdBy: 'user-test', executorId: 'desktop-test', eligibleAgents, plan, baseRef: 'main' });
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({ status: 'passed', missingScripts: [], summary: 'Tests passed.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }] })
    });
    for (const [index, taskId] of ['create', 'extend'].entries()) {
      const request = launches[index];
      expect(request.taskId).toBe(taskId);
      if (index === 1) expect(request.taskPackage.acceptedDependencies.map(item => item.taskId)).toContain('create');
      fs.writeFileSync(path.join(repository, 'src', 'api.ts'), `export const version = ${index + 1};\n`);
      const resultCommit = commit(repository, `Implement ${taskId}`);
      current = (await orchestration.handleRunnerCompleted(completedRun(request, resultCommit, ['src/api.ts'])))!;
      const result = await acceptance.evaluateAndAccept({ workspaceId, runId: current.run.id, taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator' });
      expect(result.decision).toBe(index === 0 ? 'accepted' : 'awaiting_approval');
      current = result.snapshot;
    }
    expect(current.run.planVersion).toBe(2);
    expect(current.tasks.every(task => task.status === 'accepted')).toBe(true);
    expect(current.findings.filter(finding => finding.status === 'open')).toEqual([]);
  });

  it('revalidates legacy report aliases at acceptance and gives the next agent canonical prerequisite evidence', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-canonical-handoff-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'base.ts'), 'export const ready = true;\n');
    commit(repository, 'Initial handoff fixture');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'canonical handoff fixture'));
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        const branchName = `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'main', workingDir: repository };
      },
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1,
      goal: 'Complete a small API change and continue to a dependent validation task.',
      exclusions: [],
      requirements: [
        { id: 'REQ-API', description: 'Implement the API behavior.' },
        { id: 'REQ-VALIDATE', description: 'Validate the accepted API behavior.' }
      ],
      tasks: [
        {
          id: 'implement-api', title: 'Implement API', description: 'Implement the API.', kind: 'backend',
          ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-API'],
          acceptanceCriteria: ['The API behavior is implemented.'], requiredChecks: ['test'],
          scope: { includePaths: ['src/**'], excludePaths: [] }
        },
        {
          id: 'validate-api', title: 'Validate API', description: 'Review the accepted API evidence.', kind: 'validation',
          ownerAgentId: 'validation-agent', dependsOn: ['implement-api'], requirementIds: ['REQ-VALIDATE'],
          acceptanceCriteria: ['The accepted API change is validated.'], requiredChecks: [],
          scope: { includePaths: [], excludePaths: [] }
        }
      ]
    });
    const eligibleAgents = [
      { id: 'backend-agent', role: 'Backend Agent' },
      { id: 'validation-agent', role: 'Validation / Checking Agent' }
    ] as const;
    const snapshot = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/canonical-handoff',
      requestKey: 'canonical-handoff', requestFingerprint: 'canonical-handoff-fingerprint',
      createdBy: 'user-test', executorId: 'desktop-test', eligibleAgents, plan, baseRef: 'main'
    });
    const request = launches[0];
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'), 'export function api() { return true; }\n');
    const resultCommit = commit(repository, 'Implement API');
    const rawReport = JSON.parse(completedRun(request, resultCommit, ['src/api.ts']).activities[0].message);
    rawReport.reportedChecks = [{
      name: 'npm test', status: 'blocked', evidence: 'The agent could not run this check in its isolated tools.'
    }];
    const running = runWithWorkspace(workspaceId, () => store!.getOrchestrationSnapshot(snapshot.run.id))!;
    const submitted = runWithWorkspace(workspaceId, () => store!.submitOrchestrationAttempt({
      runId: snapshot.run.id,
      taskId: request.taskId,
      attemptId: request.attemptId,
      expectedTaskRevision: running.tasks.find(task => task.id === request.taskId)!.revision,
      resultCommit,
      result: {
        resultSchemaVersion: 1,
        summary: rawReport.summary,
        prototypeRunId: `prototype-${request.attemptId}`,
        branchName: request.branchName,
        agentReport: rawReport,
        agentReportResponse: JSON.stringify(rawReport),
        agentReportSchemaVersionExpected: 1,
        agentReportSchemaVersionReceived: 1,
        verification: {
          stageStatus: 'success',
          observed: {
            status: 'passed', missingScripts: [],
            commands: [{ script: 'test', display: 'npm test', exitCode: 0, signal: null }]
          }
        }
      }
    }));
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({
        status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }]
      })
    });

    const outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted.run.id, taskId: request.taskId,
      attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });

    expect(outcome.decision, outcome.reason).toBe('accepted');
    expect(outcome.snapshot.attempts.find(attempt => attempt.id === request.attemptId)?.result?.agentReport)
      .toMatchObject({ reportedChecks: [{ script: 'npm test', result: 'not_run' }] });
    expect(launches[1].taskPackage.acceptedDependencies[0]).toMatchObject({
      taskId: 'implement-api',
      acceptedRevision: expect.any(Number),
      resultCommit,
      requirementCoverage: [{ requirementId: 'REQ-API', evidence: expect.any(String) }],
      deliverables: [{ paths: ['src/api.ts'] }],
      verificationStatus: 'passed',
      observedChecks: [{ script: 'test', result: 'passed' }],
      changedPaths: ['src/api.ts']
    });
  });

  it('rejects an out-of-scope edit, targets its owner, and accepts only after the bad edit is removed', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-task-acceptance-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    const originalReadme = '# Task service\n';
    fs.writeFileSync(path.join(repository, 'docs', 'readme.md'), originalReadme);
    fs.writeFileSync(path.join(repository, 'src', 'base.ts'), 'export const ready = true;\n');
    const baseCommit = commit(repository, 'Initial fixture');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'task acceptance fixture'));
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        const currentBranch = git(repository, ['branch', '--show-current']);
        if (currentBranch !== branchName) git(repository, ['checkout', '-b', branchName]);
        return {
          startingCommit: await getHeadCommit(repository), branchName, baseRef: 'HEAD', workingDir: repository
        };
      },
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1,
      goal: 'Implement the task service API.',
      exclusions: [],
      requirements: [
        { id: 'REQ-API', description: 'Create a task through the API.' },
        { id: 'REQ-COMPAT', description: 'Preserve the accepted task API behavior.' }
      ],
      tasks: [
        {
          id: 'create-api', title: 'Create task API', description: 'Implement the task creation endpoint.',
          kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-API'],
          acceptanceCriteria: ['The API persists a created task.'], requiredChecks: ['test'],
          scope: { includePaths: ['src/**'], excludePaths: [] }
        },
        {
          // Does not build on create-api: the plan runs them as separate work, so its accepted files stay protected.
          id: 'preserve-api', title: 'Preserve task API behavior', description: 'Make a compatible improvement to the API implementation.',
          kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-COMPAT'],
          acceptanceCriteria: ['The accepted create API behavior remains intact.'], requiredChecks: ['test'],
          scope: { includePaths: ['src/**'], excludePaths: [] }
        }
      ]
    });
    const input = {
      workspaceId, projectId, issueId, repository: 'acme/tasks', requestKey: 'request-acceptance',
      requestFingerprint: 'fingerprint-acceptance', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const,
      plan
    };

    let snapshot = await startAndApprove(orchestration, input);
    expect(snapshot.run.baseCommit).toBe(baseCommit);
    expect(snapshot.run.worktreePath).toBe(repository);
    const firstRequest = launches[0];
    fs.writeFileSync(path.join(repository, 'docs', 'readme.md'), '# Unapproved edit\n');
    let resultCommit = commit(repository, 'Make an out-of-scope edit');
    snapshot = (await orchestration.handleRunnerCompleted(completedRun(firstRequest, resultCommit, ['docs/readme.md'])))!;
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({
        status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }]
      })
    });

    const rejected = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'create-api', attemptId: firstRequest.attemptId, acceptedBy: 'orchestrator'
    });
    expect(rejected.decision).toBe('retrying');
    expect(rejected.snapshot.run.status).toBe('executing');
    expect(rejected.snapshot.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'open', path: 'docs/readme.md', correctionTaskId: 'create-api' })
    ]));

    snapshot = rejected.snapshot;
    const correctionRequest = launches[1];
    expect(correctionRequest.ownerAgentId).toBe('backend-agent');
    expect(correctionRequest.taskPackage.corrections.join('\n')).toContain('outside its approved path scope');

    fs.writeFileSync(path.join(repository, 'docs', 'readme.md'), originalReadme);
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'), 'export function createTask(name: string) { return { name }; }\n');
    resultCommit = commit(repository, 'Correct scope and implement API');
    snapshot = (await orchestration.handleRunnerCompleted(completedRun(correctionRequest, resultCommit, ['docs/readme.md', 'src/api.ts'])))!;
    const accepted = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'create-api', attemptId: correctionRequest.attemptId, acceptedBy: 'orchestrator'
    });

    expect(accepted.decision).toBe('accepted');
    expect(accepted.snapshot.run.status).toBe('executing');
    expect(accepted.snapshot.findings.every(finding => finding.status === 'resolved')).toBe(true);
    expect(accepted.snapshot.attempts.find(attempt => attempt.id === correctionRequest.attemptId)?.result)
      .toHaveProperty('acceptanceEvidence.scope.passed', true);

    const acceptedApiCommit = resultCommit;
    const preserveRequest = launches[2];
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'), 'export function createTask() { return null; }\n');
    resultCommit = commit(repository, 'Break accepted API behavior');
    snapshot = (await orchestration.handleRunnerCompleted(completedRun(preserveRequest, resultCommit, ['src/api.ts'])))!;
    const invalidated = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'preserve-api', attemptId: preserveRequest.attemptId, acceptedBy: 'orchestrator'
    });
    expect(invalidated.decision).toBe('retrying');
    expect(invalidated.snapshot.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'open', path: 'src/api.ts',
        evidence: expect.objectContaining({ check: 'accepted_artifact_mutation', acceptedTaskId: 'create-api' })
      })
    ]));

    snapshot = invalidated.snapshot;
    const restoreRequest = launches[3];
    expect(restoreRequest.taskPackage.corrections.join('\n')).toContain('which accepted task create-api delivered, and this task does not build on create-api');
    const acceptedApi = git(repository, ['show', `${acceptedApiCommit}:src/api.ts`]);
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'), `${acceptedApi}\n`);
    resultCommit = commit(repository, 'Restore accepted API behavior');
    snapshot = (await orchestration.handleRunnerCompleted(completedRun(restoreRequest, resultCommit, ['src/api.ts'])))!;
    const finalAcceptance = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'preserve-api', attemptId: restoreRequest.attemptId, acceptedBy: 'orchestrator'
    });

    expect(finalAcceptance.decision).toBe('awaiting_approval');
    expect(finalAcceptance.snapshot.run.status).toBe('awaiting_approval');
    expect(finalAcceptance.snapshot.findings.every(finding => finding.status === 'resolved')).toBe(true);
    expect(finalAcceptance.evidence).toMatchObject({ cumulativeChangedPaths: ['src/api.ts'] });
    expect(finalAcceptance.evidence).toHaveProperty('checks.status', 'passed');
  });

  it('measures a retried task from where the task started, so its owner and review see the rejected attempt\'s work', async () => {
    // A retry continues the rejected attempt's checkpoint. Measured from the retry's own start, a retry
    // that changed nothing was accepted with no files: nobody owned the code and the review diff was empty.
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-task-baseline-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'index.ts'), 'export const ready = true;\n');
    const baseCommit = commit(repository, 'Initial fixture');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    store.addAllowedPath(directory, 'task baseline fixture');
    const eligibleAgents = [
      { id: 'frontend-agent', role: 'Frontend Agent' },
      { id: 'reviewer-agent', role: 'Security / Code Quality Agent' }
    ] as const;
    vi.spyOn(store, 'getAgents').mockReturnValue(eligibleAgents.map(agent => ({ ...agent })) as any);
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'main', workingDir: repository };
      },
      async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1,
      goal: 'Build the landing page.',
      exclusions: [],
      requirements: [{ id: 'REQ-PAGE', description: 'Show the landing page.' }],
      plannerReads: [{ repository: 'acme/site', path: 'src/index.ts' }, { repository: 'acme/other', path: 'src/elsewhere.ts' }],
      tasks: [
        {
          id: 'landing-page', title: 'Landing page', description: 'Build the landing page.',
          kind: 'frontend', ownerAgentId: 'frontend-agent', dependsOn: [], requirementIds: ['REQ-PAGE'],
          acceptanceCriteria: ['The page renders.'], requiredChecks: ['test'],
          scope: { includePaths: ['src/**'], excludePaths: [] }
        },
        {
          id: 'review-page', title: 'Review the landing page', description: 'Inspect the accepted page.',
          kind: 'review', ownerAgentId: 'reviewer-agent', dependsOn: ['landing-page'], requirementIds: ['REQ-PAGE'],
          acceptanceCriteria: ['Review the page and give evidence.']
        }
      ]
    });
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({
        status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }]
      })
    });
    let snapshot = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/site', requestKey: 'request-task-baseline',
      requestFingerprint: 'fingerprint-task-baseline', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents, plan, baseRef: 'main', baseCommit
    });
    expect(launches[0].taskPackage.earlierAttemptChangedPaths).toBeUndefined();
    // The specialist starts from the files the Orchestrator opened in its own repository.
    expect(launches[0].taskPackage.plannerReadPaths).toEqual(['src/index.ts']);

    // Attempt 1 writes the page, but its check fails: rejected, and its checkpoint stays for the retry.
    fs.writeFileSync(path.join(repository, 'src', 'landing.ts'), 'export const landing = () => "<h1>Resort</h1>";\n');
    const pageCommit = commit(repository, 'Build the landing page');
    snapshot = (await orchestration.handleRunnerCompleted({
      ...completedRun(launches[0], pageCommit, ['src/landing.ts']),
      verificationEvidence: { status: 'failed', missingScripts: [], commands: [{ script: 'test', display: 'npm test', exitCode: 1, signal: null }] }
    }))!;
    const rejected = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'landing-page', attemptId: launches[0].attemptId, acceptedBy: 'orchestrator'
    });
    expect(rejected.decision).toBe('retrying');

    // The retry is told which files are already its work, changes nothing, and its checks pass.
    expect(launches[1].taskPackage.earlierAttemptChangedPaths).toEqual(['src/landing.ts']);
    snapshot = (await orchestration.handleRunnerCompleted(completedRun(launches[1], pageCommit, ['src/landing.ts'])))!;
    const accepted = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'landing-page', attemptId: launches[1].attemptId, acceptedBy: 'orchestrator'
    });
    expect(accepted.decision).toBe('accepted');
    expect(accepted.snapshot.attempts.find(attempt => attempt.id === launches[1].attemptId)?.result).toMatchObject({
      acceptanceEvidence: { diffStartingCommit: baseCommit, changedPaths: ['src/landing.ts'] }
    });

    // The independent review gets the page as a diff, not an empty patch.
    expect(launches[2].taskPackage.reviewInputs).toEqual([expect.objectContaining({
      taskId: 'landing-page', startingCommit: baseCommit, changedPaths: ['src/landing.ts'],
      diff: expect.stringContaining('+export const landing')
    })]);
  });

  it('holds every code task to its repository checks and lets work that builds on a task update its files', async () => {
    // The shape of a real stuck build: the first task was planned without lint, the next one with it.
    // Lint covers the whole repository, so the later task met lint errors in the first task's test file
    // and could neither fix them (that file was accepted work) nor leave them (lint failed).
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-repository-checks-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repository, 'tests'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'index.ts'), 'export const ready = true;\n');
    commit(repository, 'Initial fixture');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'repository checks fixture'));
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'HEAD', workingDir: repository };
      },
      async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1,
      goal: 'Store accounts and add sign-in.',
      exclusions: [],
      requirements: [
        { id: 'REQ-STORE', description: 'Store accounts.' },
        { id: 'REQ-AUTH', description: 'Sign customers in.' }
      ],
      tasks: [
        {
          id: 'accounts-data', title: 'Account storage', description: 'Store accounts.',
          kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-STORE'],
          acceptanceCriteria: ['Accounts are stored.'], requiredChecks: ['test'],
          scope: { includePaths: ['src/**', 'tests/**'], excludePaths: [] }
        },
        {
          id: 'auth-api', title: 'Sign-in API', description: 'Sign customers in with stored accounts.',
          kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: ['accounts-data'], requirementIds: ['REQ-AUTH'],
          acceptanceCriteria: ['Customers can sign in.'], requiredChecks: ['test', 'lint'],
          scope: { includePaths: ['src/**', 'tests/**'], excludePaths: [] }
        }
      ]
    });
    const observed = (scripts: string[]) => ({
      status: 'passed', missingScripts: [], commands: scripts.map(script => ({ script, display: `npm run ${script}`, exitCode: 0, signal: null }))
    });
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({
        status: 'passed', missingScripts: [], summary: 'Verification passed.',
        commands: ['test', 'lint'].map(script => ({ command: { script, bin: 'npm', args: ['run', script], display: `npm run ${script}` }, exitCode: 0, signal: null, output: '' }))
      })
    });

    let snapshot = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/accounts', requestKey: 'request-repository-checks',
      requestFingerprint: 'fingerprint-repository-checks', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }] as const, plan
    });
    // The runner is told to run, and acceptance requires, every check the repository runs.
    expect(launches[0].taskPackage.task.requiredChecks).toEqual(['test', 'lint']);

    fs.writeFileSync(path.join(repository, 'src', 'accounts.ts'), 'export const accounts = new Map<string, string>();\n');
    fs.writeFileSync(path.join(repository, 'tests', 'accounts.spec.ts'), 'const accounts = require("../src/accounts");\n');
    let resultCommit = commit(repository, 'Store accounts');
    snapshot = (await orchestration.handleRunnerCompleted({
      ...completedRun(launches[0], resultCommit, ['src/accounts.ts', 'tests/accounts.spec.ts']), verificationEvidence: observed(['test'])
    }))!;
    const withoutLint = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'accounts-data', attemptId: launches[0].attemptId, acceptedBy: 'orchestrator'
    });
    expect(withoutLint.decision).toBe('retrying');
    expect(withoutLint.snapshot.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'open', evidence: expect.objectContaining({ check: 'required_check', requiredScript: 'lint' }) })
    ]));

    // The owner fixes the lint error in its own file, so it is never left for later work. The retry
    // continues attempt 1's checkpoint, and reports that attempt's files as its work too.
    expect(launches[1].taskPackage.earlierAttemptChangedPaths).toEqual(['src/accounts.ts', 'tests/accounts.spec.ts']);
    const acceptedTest = 'import { accounts } from "../src/accounts";\ntest("stores accounts", () => { expect(accounts.size).toBe(0); });\n';
    fs.writeFileSync(path.join(repository, 'tests', 'accounts.spec.ts'), acceptedTest);
    resultCommit = commit(repository, 'Fix the account test lint error');
    snapshot = (await orchestration.handleRunnerCompleted({
      ...completedRun(launches[1], resultCommit, launches[1].taskPackage.earlierAttemptChangedPaths!), verificationEvidence: observed(['test', 'lint'])
    }))!;
    const accepted = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'accounts-data', attemptId: launches[1].attemptId, acceptedBy: 'orchestrator'
    });
    expect(accepted.decision).toBe('accepted');

    // auth-api builds on accounts-data and its scope names tests/**, so it may update that task's test
    // file, but not drop the test it delivered: that fails closed instead of relying on the reviewer.
    fs.writeFileSync(path.join(repository, 'tests', 'accounts.spec.ts'), 'import { signIn } from "../src/auth";\n');
    fs.writeFileSync(path.join(repository, 'src', 'auth.ts'), 'export const signIn = (email: string) => email;\n');
    resultCommit = commit(repository, 'Add sign-in and drop the account test');
    snapshot = (await orchestration.handleRunnerCompleted({
      ...completedRun(launches[2], resultCommit, ['src/auth.ts', 'tests/accounts.spec.ts']), verificationEvidence: observed(['test', 'lint'])
    }))!;
    const weakened = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'auth-api', attemptId: launches[2].attemptId, acceptedBy: 'orchestrator'
    });
    expect(weakened.decision).toBe('retrying');
    expect(weakened.snapshot.findings).toEqual(expect.arrayContaining([expect.objectContaining({
      status: 'open', path: 'tests/accounts.spec.ts',
      evidence: expect.objectContaining({ check: 'accepted_artifact_weakened', acceptedTaskId: 'accounts-data' })
    })]));

    // Keeping the test and adding to the file is accepted, and recorded for the reviewers that build on auth-api.
    fs.writeFileSync(path.join(repository, 'tests', 'accounts.spec.ts'), `${acceptedTest}import { signIn } from "../src/auth";\n`);
    resultCommit = commit(repository, 'Keep the account test');
    snapshot = (await orchestration.handleRunnerCompleted({
      ...completedRun(launches[3], resultCommit, ['src/auth.ts', 'tests/accounts.spec.ts']), verificationEvidence: observed(['test', 'lint'])
    }))!;
    const evolved = await acceptance.evaluateAndAccept({
      workspaceId, runId: snapshot.run.id, taskId: 'auth-api', attemptId: launches[3].attemptId, acceptedBy: 'orchestrator'
    });
    expect(evolved.decision).toBe('awaiting_approval');
    expect(evolved.snapshot.findings.filter(finding => finding.status === 'open')).toEqual([]);
    expect(evolved.snapshot.attempts.find(attempt => attempt.id === launches[3].attemptId)?.result)
      .toHaveProperty('acceptanceEvidence.evolvedAcceptedPaths', [{ path: 'tests/accounts.spec.ts', ownerTaskId: 'accounts-data' }]);
  });

  it('blocks with an Alpha finding when repository acceptance checks throw', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-acceptance-system-failure-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'index.ts'), 'export const ready = false;\n');
    commit(repository, 'Initial code');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'acceptance failure fixture'));
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'HEAD', workingDir: repository };
      },
      async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1, goal: 'Implement the API.', requirements: [{ id: 'REQ-API', description: 'Provide the API.' }],
      tasks: [{
        id: 'implement-api', title: 'Implement API', description: 'Add the API behavior.', kind: 'backend',
        ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-API'],
        acceptanceCriteria: ['The API returns the expected result.'], requiredChecks: ['test'],
        scope: { includePaths: ['src/**'], excludePaths: [] }
      }]
    });
    const started = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/acceptance-failure', requestKey: 'acceptance-system-failure',
      requestFingerprint: 'acceptance-system-failure', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }], plan
    });
    const request = launches[0];
    fs.writeFileSync(path.join(repository, 'src', 'index.ts'), 'export const ready = true;\n');
    const resultCommit = commit(repository, 'Implement API');
    await orchestration.handleRunnerCompleted(completedRun(request, resultCommit, ['src/index.ts']));
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      getCurrentBranch: async () => { throw new Error('EACCES: permission denied reading branch.'); }
    });

    const outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: started.run.id, taskId: 'implement-api', attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });

    expect(outcome.decision).toBe('blocked');
    expect(outcome.snapshot.run.status).toBe('blocked');
    expect(outcome.reason).toContain('EACCES');
    expect(outcome.snapshot.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence: expect.objectContaining({ check: 'acceptance_system', origin: 'alpha_acceptance' }) })
    ]));
  });

  it('turns an unexpected handoff-recording exception into a recoverable Alpha finding', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-handoff-system-failure-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'index.ts'), 'export const ready = false;\n');
    commit(repository, 'Initial code');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'handoff failure fixture'));
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'HEAD', workingDir: repository };
      },
      async launch(request) { launches.push(request); return { prototypeRunId: `prototype-${request.attemptId}` }; }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1, goal: 'Implement the API.', requirements: [{ id: 'REQ-API', description: 'Provide the API.' }],
      tasks: [{
        id: 'implement-api', title: 'Implement API', description: 'Add the API behavior.', kind: 'backend',
        ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-API'],
        acceptanceCriteria: ['The API returns the expected result.'], requiredChecks: ['test'],
        scope: { includePaths: ['src/**'], excludePaths: [] }
      }]
    });
    const started = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/handoff-failure', requestKey: 'handoff-system-failure',
      requestFingerprint: 'handoff-system-failure', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents: [{ id: 'backend-agent', role: 'Backend Agent' }], plan
    });
    const request = launches[0];
    fs.writeFileSync(path.join(repository, 'src', 'index.ts'), 'export const ready = true;\n');
    const resultCommit = commit(repository, 'Implement API');
    const submitted = await orchestration.handleRunnerCompleted(completedRun(request, resultCommit, ['src/index.ts']));
    vi.spyOn(orchestration, 'acceptAttempt').mockRejectedValue(new Error('SQLite handoff write failed.'));
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({
        status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }]
      })
    });

    const outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: 'implement-api', attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });

    expect(outcome.decision).toBe('blocked');
    expect(outcome.snapshot.run.status).toBe('blocked');
    expect(outcome.reason).toContain('SQLite handoff write failed');
    expect(outcome.snapshot.attempts.find(attempt => attempt.id === request.attemptId)?.status).toBe('rejected');
    expect(outcome.snapshot.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence: expect.objectContaining({ check: 'acceptance_system', origin: 'alpha_acceptance' }) })
    ]));
  });

  it('retries malformed reports twice with the same read-only specialist before escalating', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-report-correction-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'), 'export const ready = true;\n');
    commit(repository, 'Initial API');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'report correction fixture'));
    const eligibleAgents = [{ id: 'backend-agent', role: 'Backend Agent' }] as const;
    vi.spyOn(store, 'getAgents').mockReturnValue(eligibleAgents.map(agent => ({ ...agent })) as any);
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'main', workingDir: repository };
      },
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1,
      goal: 'Implement the API endpoint.',
      exclusions: [],
      requirements: [{ id: 'REQ-API', description: 'The API endpoint is available.' }],
      tasks: [{
        id: 'api', title: 'Implement API', description: 'Implement the API endpoint.', kind: 'backend',
        ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-API'],
        acceptanceCriteria: ['The API endpoint is implemented.'], requiredChecks: ['test'],
        scope: { includePaths: ['src/**'], excludePaths: [] }
      }]
    });
    let snapshot = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/report-correction', requestKey: 'request-report-correction',
      requestFingerprint: 'fingerprint-report-correction', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents, plan, baseRef: 'main'
    });
    const invalidReportedChecks = [
      { name: 'npm test', status: 'complete', evidence: 'The command completed.' }
    ];
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({
        status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.', commands: []
      })
    });
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'), 'export const ready = true;\nexport function api() { return true; }\n');
    const resultCommit = commit(repository, 'Implement API');

    let request = launches[0];
    let submitted = await orchestration.handleRunnerCompleted(
      completedRun(request, resultCommit, ['src/api.ts'], { reportedChecks: invalidReportedChecks })
    );
    expect(submitted!.attempts.find(attempt => attempt.id === request.attemptId)?.result).toMatchObject({
      agentReport: null,
      agentReportSchemaVersionExpected: 1,
      agentReportSchemaVersionReceived: 1,
      agentReportError: expect.stringContaining('reportedChecks.0'),
      agentReportResponseTruncated: false
    });
    let outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: 'api', attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });
    expect(outcome.decision).toBe('retrying');
    expect(launches).toHaveLength(2);
    expect(launches[1].ownerAgentId).toBe('backend-agent');
    expect(launches[1].taskPackage.reportCorrection?.validationErrors.join('\n')).toContain('reportedChecks.0');
    expect(launches[1].taskPackage.task.id).toBe('api');

    request = launches[1];
    submitted = await orchestration.handleRunnerCompleted(
      completedRun(request, resultCommit, [], { reportedChecks: invalidReportedChecks })
    );
    outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: 'api', attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });
    expect(outcome.decision).toBe('retrying');
    expect(launches).toHaveLength(3);
    expect(launches[2].ownerAgentId).toBe('backend-agent');
    expect(launches[2].taskPackage.reportCorrection?.validationErrors.join('\n')).toContain('reportedChecks.0');

    request = launches[2];
    submitted = await orchestration.handleRunnerCompleted(
      completedRun(request, resultCommit, [], { reportedChecks: invalidReportedChecks })
    );
    outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: 'api', attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });

    expect(outcome.decision).toBe('rejected');
    expect(outcome.reason).toContain('reportedChecks.0');
    expect(outcome.snapshot.run.status).toBe('blocked');
    expect(outcome.snapshot.attempts.filter(attempt => attempt.contextManifest.reportOnlyReportRetry).length).toBe(2);
    expect(launches).toHaveLength(3);
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(resultCommit);
  });

  it('recovers a malformed report and failed final check before completing review and validation', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-report-handoff-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'), 'export const ready = true;\n');
    commit(repository, 'Initial API');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    runWithWorkspace(workspaceId, () => store!.addAllowedPath(directory, 'report handoff fixture'));
    const eligibleAgents = [
      { id: 'backend-agent', role: 'Backend Agent' },
      { id: 'reviewer-agent', role: 'Security / Code Quality Agent' },
      { id: 'qa-agent', role: 'Validation / Checking Agent' }
    ] as const;
    vi.spyOn(store, 'getAgents').mockReturnValue(eligibleAgents.map(agent => ({ ...agent })) as any);
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'main', workingDir: repository };
      },
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1,
      goal: 'Implement and independently review the API endpoint.',
      exclusions: [],
      requirements: [{ id: 'REQ-API', description: 'The API endpoint is available.' }],
      tasks: [
        {
          id: 'api', title: 'Implement API', description: 'Implement the API endpoint.', kind: 'backend',
          ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-API'],
          acceptanceCriteria: ['The API endpoint is implemented.'], requiredChecks: ['test'],
          scope: { includePaths: ['src/**'], excludePaths: [] }
        },
        {
          id: 'review-api', title: 'Independently review API', description: 'Review the accepted API changes.', kind: 'review',
          ownerAgentId: 'reviewer-agent', dependsOn: ['api'], requirementIds: ['REQ-API'],
          acceptanceCriteria: ['The API change meets the requirement.']
        },
        {
          id: 'validate-api', title: 'Validate API', description: 'Run the API verification checks.', kind: 'validation',
          ownerAgentId: 'qa-agent', dependsOn: ['review-api'], requirementIds: ['REQ-API'],
          acceptanceCriteria: ['The registered API check passes.'], requiredChecks: ['test']
        }
      ]
    });
    let snapshot = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/report-handoff', requestKey: 'request-report-handoff',
      requestFingerprint: 'fingerprint-report-handoff', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents, plan, baseRef: 'main'
    });
    const malformedCheck = [{ name: 'npm test', status: 'complete', evidence: 'The command completed.' }];
    const correctedCheck = [{ name: 'npm test', status: 'passed', evidence: 'The original task observed npm test pass.' }];
    let finalCheckRuns = 0;
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => {
        finalCheckRuns += 1;
        const failed = finalCheckRuns === 1;
        return {
          status: failed ? 'failed' as const : 'passed' as const,
          missingScripts: [],
          summary: failed ? 'npm test failed in src/api.ts.' : 'Verification passed: npm test.',
          commands: [{
            command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' },
            exitCode: failed ? 1 : 0, signal: null, output: failed ? 'Regression in src/api.ts' : ''
          }]
        };
      }
    });
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'), 'export const ready = true;\nexport function api() { return true; }\n');
    const resultCommit = commit(repository, 'Implement API');
    let request = launches[0];
    let submitted = await orchestration.handleRunnerCompleted(
      completedRun(request, resultCommit, ['src/api.ts'], { reportedChecks: malformedCheck })
    );
    let outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: 'api', attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });
    expect(outcome.decision).toBe('retrying');

    request = launches[1];
    submitted = await orchestration.handleRunnerCompleted(
      completedRun(request, resultCommit, ['src/api.ts'], { reportedChecks: correctedCheck })
    );
    outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: 'api', attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });

    expect(outcome.decision).toBe('accepted');
    expect(outcome.snapshot.run.status).toBe('executing');
    expect(outcome.snapshot.run.currentTaskId).toBe('review-api');
    expect(launches).toHaveLength(3);
    expect(launches[2].ownerAgentId).toBe('reviewer-agent');
    expect(launches[2].taskPackage.reviewInputs[0].changedPaths).toEqual(['src/api.ts']);
    expect(launches[2].taskPackage.reviewInputs[0].diff).toContain('function api()');

    request = launches[2];
    submitted = await orchestration.handleRunnerCompleted(completedRun(request, resultCommit, []));
    outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: request.taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });
    expect(outcome.decision).toBe('accepted');
    expect(outcome.snapshot.run.currentTaskId).toBe('validate-api');
    expect(launches[3].ownerAgentId).toBe('qa-agent');

    request = launches[3];
    submitted = await orchestration.handleRunnerCompleted(completedRun(request, resultCommit, []));
    outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: request.taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });
    expect(outcome.decision).toBe('retrying');
    expect(outcome.snapshot.run.status).toBe('executing');
    expect(outcome.reason).toContain('Final checks failed');
    expect(launches).toHaveLength(5);
    expect(launches[4].ownerAgentId).toBe('backend-agent');
    expect(launches[4].taskPackage.corrections.join('\n')).toContain('Final validation failed');

    request = launches[4];
    fs.writeFileSync(path.join(repository, 'src', 'api.ts'),
      'export const ready = true;\nexport function api() { return true; }\n// final-check correction\n');
    const correctedCommit = commit(repository, 'Correct final validation failure');
    submitted = await orchestration.handleRunnerCompleted(completedRun(request, correctedCommit, ['src/api.ts']));
    outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: request.taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });
    expect(outcome.decision).toBe('accepted');
    expect(outcome.snapshot.run.currentTaskId).toMatch(/^review-/);
    expect(launches[5].ownerAgentId).toBe('reviewer-agent');

    request = launches[5];
    submitted = await orchestration.handleRunnerCompleted(completedRun(request, correctedCommit, []));
    outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: request.taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });
    expect(outcome.decision).toBe('accepted');
    expect(launches[6].ownerAgentId).toBe('qa-agent');

    request = launches[6];
    submitted = await orchestration.handleRunnerCompleted(completedRun(request, correctedCommit, []));
    outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted!.run.id, taskId: request.taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });
    expect(outcome.decision).toBe('awaiting_approval');
    expect(outcome.snapshot.run.status).toBe('awaiting_approval');
    expect(finalCheckRuns).toBe(2);
    expect(launches.map(launch => launch.ownerAgentId)).toEqual([
      'backend-agent', 'backend-agent', 'reviewer-agent', 'qa-agent',
      'backend-agent', 'reviewer-agent', 'qa-agent'
    ]);
  });

  it('routes an independent review finding to its owner, then repeats review and validation before approval', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-review-correction-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'tasks.ts'), 'export function createTask() { return null; }\n');
    fs.writeFileSync(path.join(repository, 'src', 'tasks.test.ts'), 'test("task creation rejects invalid identifiers", () => {});\n');
    const baseCommit = commit(repository, 'Initial task service');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    store.addAllowedPath(directory, 'independent review correction fixture');
    const eligibleAgents = [
      { id: 'backend-agent', role: 'Backend Agent' },
      { id: 'reviewer-agent', role: 'Security / Code Quality Agent' },
      { id: 'qa-agent', role: 'Validation / Checking Agent' }
    ] as const;
    vi.spyOn(store, 'getAgents').mockReturnValue(eligibleAgents.map(agent => ({ ...agent })) as any);
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'main', workingDir: repository };
      },
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1,
      goal: 'Create task records safely.',
      exclusions: ['No authentication.'],
      requirements: [{ id: 'REQ-CREATE', description: 'The service rejects invalid task identifiers.' }],
      tasks: [
        {
          id: 'create-api', title: 'Implement task creation', description: 'Create a task only when the input is valid.',
          kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-CREATE'],
          acceptanceCriteria: ['Invalid identifiers receive the documented not-found result.'], requiredChecks: ['test'],
          scope: { includePaths: ['src/**'], excludePaths: [] }
        },
        {
          id: 'review-1', title: 'Independently review task creation', description: 'Inspect the accepted backend changes.',
          kind: 'review', ownerAgentId: 'reviewer-agent', dependsOn: ['create-api'], requirementIds: ['REQ-CREATE'],
          acceptanceCriteria: ['Review the implementation and provide evidence for each criterion.']
        },
        {
          id: 'validation-1', title: 'Validate task creation', description: 'Run the task service checks.',
          kind: 'validation', ownerAgentId: 'qa-agent', dependsOn: ['review-1'], requirementIds: ['REQ-CREATE'],
          acceptanceCriteria: ['The registered task service check passes.'], requiredChecks: ['test']
        }
      ]
    });
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({
        status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }]
      })
    });
    let snapshot = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/tasks', requestKey: 'request-review-correction',
      requestFingerprint: 'fingerprint-review-correction', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents, plan, baseRef: 'main', baseCommit
    });

    const execute = async (request: OrchestrationLaunchRequest, changedPaths: string[], message: string, reportOverrides: Record<string, unknown> = {}) => {
      if (changedPaths.includes('src/tasks.ts') && request.taskKind !== 'review') {
        const previous = fs.readFileSync(path.join(repository, 'src', 'tasks.ts'), 'utf8');
        const updated = request.taskPackage.findingIds.length
          ? 'export function createTask(id: string) { if (!id) throw new Error("not found"); return { id }; }\n'
          : 'export function createTask(id: string) { return { id }; }\n';
        fs.writeFileSync(path.join(repository, 'src', 'tasks.ts'), updated);
      }
      const resultCommit = changedPaths.length ? commit(repository, message) : await getHeadCommit(repository);
      snapshot = (await orchestration.handleRunnerCompleted(completedRun(request, resultCommit, changedPaths, reportOverrides)))!;
      return acceptance.evaluateAndAccept({ workspaceId, runId: snapshot.run.id, taskId: request.taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator' });
    };

    const implementationRequest = launches[0];
    const implementationAccepted = await execute(implementationRequest, ['src/tasks.ts'], 'Implement task creation');
    expect(implementationAccepted.decision).toBe('accepted');
    expect(implementationAccepted.snapshot.run.currentTaskId).toBe('review-1');

    const firstReviewRequest = launches[1];
    expect(firstReviewRequest.taskPackage.reviewInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'create-api',
        changedPaths: ['src/tasks.ts'],
        diffHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        diff: expect.stringContaining('+export function createTask(id: string) { return { id }; }'),
        sourceFiles: expect.arrayContaining([
          expect.objectContaining({
            path: 'src/tasks.ts',
            content: 'export function createTask(id: string) { return { id }; }\n',
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
          }),
          expect.objectContaining({ path: 'src/tasks.test.ts', content: expect.stringContaining('rejects invalid identifiers') })
        ])
      })
    ]));
    const reviewFinding = {
      targetTaskId: 'create-api', severity: 'blocking', title: 'Invalid identifiers are accepted',
      requirementId: 'REQ-CREATE', path: 'src/tasks.ts',
      evidence: 'The function returns a task even when its identifier is empty.',
      instruction: 'Reject empty identifiers and keep the regression check passing.'
    };
    const reviewAccepted = await execute(firstReviewRequest, [], 'Review task creation', { reviewFindings: [reviewFinding] });
    expect(reviewAccepted.decision).toBe('accepted');
    expect(reviewAccepted.snapshot.run.planVersion).toBe(2);
    expect(reviewAccepted.snapshot.run.currentTaskId).toMatch(/^correction-/);
    expect(reviewAccepted.snapshot.findings).toMatchObject([{
      status: 'open', taskId: 'create-api', sourceTaskId: 'review-1', severity: 'blocking'
    }]);

    const correctionRequest = launches[2];
    expect(correctionRequest.ownerAgentId).toBe('backend-agent');
    expect(correctionRequest.taskPackage.findingIds).toHaveLength(1);
    expect(correctionRequest.taskPackage.corrections.join('\n')).toContain('Reject empty identifiers');
    const correctionAccepted = await execute(correctionRequest, ['src/tasks.ts'], 'Correct task validation');
    expect(correctionAccepted.decision).toBe('accepted');
    expect(correctionAccepted.snapshot.findings[0].status).toBe('open');
    expect(correctionAccepted.snapshot.run.currentTaskId).toMatch(/^review-2/);

    const secondReviewRequest = launches[3];
    expect(secondReviewRequest.taskPackage.reviewInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: correctionRequest.taskId,
        diff: expect.stringContaining('if (!id)'),
        relatedFindings: [expect.objectContaining({ title: 'Invalid identifiers are accepted' })]
      })
    ]));
    const secondReviewAccepted = await execute(secondReviewRequest, [], 'Re-review corrected task creation', { reviewFindings: [] });
    expect(secondReviewAccepted.decision).toBe('accepted');
    expect(secondReviewAccepted.snapshot.findings[0].status).toBe('resolved');
    expect(secondReviewAccepted.snapshot.run.currentTaskId).toBe('validation-2');

    const validationRequest = launches[4];
    const validated = await execute(validationRequest, [], 'Validate corrected task creation');
    expect(validated.decision).toBe('awaiting_approval');
    expect(validated.snapshot.run.status).toBe('awaiting_approval');
    expect(validated.snapshot.tasks.find(task => task.id === 'validation-1')?.required).toBe(false);
    expect(launches.map(request => request.ownerAgentId)).toEqual([
      'backend-agent', 'reviewer-agent', 'backend-agent', 'reviewer-agent', 'qa-agent'
    ]);
  });

  it('closes report-format findings once the corrected review is accepted, so final validation can pass', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-review-format-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'tasks.ts'), 'export function createTask() { return null; }\n');
    const baseCommit = commit(repository, 'Initial task service');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    store.addAllowedPath(directory, 'review format fixture');
    const eligibleAgents = [
      { id: 'backend-agent', role: 'Backend Agent' },
      { id: 'reviewer-agent', role: 'Security / Code Quality Agent' }
    ] as const;
    vi.spyOn(store, 'getAgents').mockReturnValue(eligibleAgents.map(agent => ({ ...agent })) as any);
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'main', workingDir: repository };
      },
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1,
      goal: 'Create task records safely.',
      exclusions: [],
      requirements: [
        { id: 'REQ-CREATE', description: 'The service creates tasks.' },
        { id: 'REQ-SAFE', description: 'The build has no security defects.' }
      ],
      tasks: [
        {
          id: 'create-api', title: 'Implement task creation', description: 'Create a task.',
          kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-CREATE'],
          acceptanceCriteria: ['Tasks are created.'], requiredChecks: ['test'],
          scope: { includePaths: ['src/**'], excludePaths: [] }
        },
        {
          id: 'review-1', title: 'Review task creation', description: 'Inspect the accepted backend changes.',
          kind: 'review', ownerAgentId: 'reviewer-agent', dependsOn: ['create-api'], requirementIds: ['REQ-CREATE', 'REQ-SAFE'],
          acceptanceCriteria: ['Review the implementation.']
        }
      ]
    });
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({
        status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }]
      })
    });
    let snapshot = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/tasks', requestKey: 'request-review-format',
      requestFingerprint: 'fingerprint-review-format', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents, plan, baseRef: 'main', baseCommit
    });
    const execute = async (request: OrchestrationLaunchRequest, changedPaths: string[], reportOverrides: Record<string, unknown> = {}) => {
      if (changedPaths.length) fs.writeFileSync(path.join(repository, 'src', 'tasks.ts'), 'export function createTask(id: string) { return { id }; }\n');
      const resultCommit = changedPaths.length ? commit(repository, 'Implement task creation') : await getHeadCommit(repository);
      snapshot = (await orchestration.handleRunnerCompleted(completedRun(request, resultCommit, changedPaths, reportOverrides)))!;
      return acceptance.evaluateAndAccept({ workspaceId, runId: snapshot.run.id, taskId: request.taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator' });
    };

    expect((await execute(launches[0], ['src/tasks.ts'])).decision).toBe('accepted');
    const finding = {
      targetTaskId: 'create-api', severity: 'warning', title: 'Responses are not validated',
      path: 'src/tasks.ts', evidence: 'The identifier is returned unchecked.', instruction: 'Validate the identifier.'
    };
    // The reviewer ties its warning to REQ-SAFE, which the backend task does not own: a report-format rejection.
    const rejected = await execute(launches[1], [], { reviewFindings: [{ ...finding, requirementId: 'REQ-SAFE' }] });
    expect(rejected.snapshot.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'open', severity: 'blocking', evidence: expect.objectContaining({ check: 'review_requirement' }) })
    ]));
    expect(launches[2].ownerAgentId).toBe('reviewer-agent');

    const corrected = await execute(launches[2], [], { reviewFindings: [finding] });
    expect(corrected.snapshot.findings.filter(item => item.evidence.check === 'review_requirement').map(item => item.status)).toEqual(['resolved']);
    expect(corrected.snapshot.run.status).toBe('awaiting_approval');
  });

  it('blocks before reviewer dispatch when accepted patches exceed the review context limit', async () => {
    const tempRoot = path.resolve(process.cwd(), '..', '.tmp-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(tempRoot, 'alpha-review-context-limit-'));
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    git(directory, ['init', '-b', 'main', repository]);
    fs.writeFileSync(path.join(repository, 'src', 'payload.ts'), 'export const payload = "small";\n');
    commit(repository, 'Initial payload');

    store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    store.addAllowedPath(directory, 'review context limit fixture');
    const eligibleAgents = [
      { id: 'backend-agent', role: 'Backend Agent' },
      { id: 'reviewer-agent', role: 'Security / Code Quality Agent' }
    ] as const;
    vi.spyOn(store, 'getAgents').mockReturnValue(eligibleAgents.map(agent => ({ ...agent })) as any);
    let branchName = '';
    const launches: OrchestrationLaunchRequest[] = [];
    const orchestration = new OrchestrationService(store, {
      async prepare(request) {
        branchName ||= `alpha/orchestration/${request.runId.replace(/[^a-zA-Z0-9]/g, '').slice(-20).toLowerCase()}`;
        if (git(repository, ['branch', '--show-current']) !== branchName) git(repository, ['checkout', '-b', branchName]);
        return { startingCommit: await getHeadCommit(repository), branchName, baseRef: 'main', workingDir: repository };
      },
      async launch(request) {
        launches.push(request);
        return { prototypeRunId: `prototype-${request.attemptId}` };
      }
    });
    const plan = parseOrchestrationPlan({
      schemaVersion: 1,
      goal: 'Store the full payload safely.',
      exclusions: [],
      requirements: [{ id: 'REQ-PAYLOAD', description: 'Keep the supplied payload available.' }],
      tasks: [
        {
          id: 'payload', title: 'Store payload', description: 'Store the payload in the service.',
          kind: 'backend', ownerAgentId: 'backend-agent', dependsOn: [], requirementIds: ['REQ-PAYLOAD'],
          acceptanceCriteria: ['The stored payload remains available.'], requiredChecks: ['test'],
          scope: { includePaths: ['src/**'], excludePaths: [] }
        },
        {
          id: 'review-payload', title: 'Review payload implementation', description: 'Inspect the accepted patch.',
          kind: 'review', ownerAgentId: 'reviewer-agent', dependsOn: ['payload'], requirementIds: ['REQ-PAYLOAD'],
          acceptanceCriteria: ['The accepted implementation meets the requirement.']
        }
      ]
    });
    const acceptance = new TaskAcceptanceService(store, orchestration, {
      worktreePathFor: () => repository,
      runVerification: async () => ({
        status: 'passed', missingScripts: [], summary: 'Verification passed: npm test.',
        commands: [{ command: { script: 'test', bin: 'npm', args: ['test'], display: 'npm test' }, exitCode: 0, signal: null, output: '' }]
      })
    });
    const snapshot = await startAndApprove(orchestration, {
      workspaceId, projectId, issueId, repository: 'acme/payloads', requestKey: 'request-review-context-limit',
      requestFingerprint: 'fingerprint-review-context-limit', createdBy: 'user-test', executorId: 'desktop-test',
      eligibleAgents, plan, baseRef: 'main'
    });
    const request = launches[0];
    fs.writeFileSync(path.join(repository, 'src', 'payload.ts'), `export const payload = "${'x'.repeat(270 * 1024)}";\n`);
    const resultCommit = commit(repository, 'Store large payload');
    const submitted = (await orchestration.handleRunnerCompleted(completedRun(request, resultCommit, ['src/payload.ts'])))!;
    const outcome = await acceptance.evaluateAndAccept({
      workspaceId, runId: submitted.run.id, taskId: request.taskId, attemptId: request.attemptId, acceptedBy: 'orchestrator'
    });

    expect(outcome.decision).toBe('accepted');
    expect(outcome.snapshot.run.status).toBe('blocked');
    expect(outcome.snapshot.tasks.find(task => task.id === 'review-payload')?.status).toBe('blocked');
    expect(outcome.snapshot.run.stoppedReason).toContain('256 KiB');
    expect(launches.map(launch => launch.taskId)).toEqual(['payload']);
    expect(snapshot.run.status).toBe('executing');
  });
});
