import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../models/index.js';
import type { CliTurnOptions, CliTurnResult } from './cliRunner.js';
import { MAX_PROJECT_CONTEXT_CHARS, parseOrchestrationPlan, validateOrchestrationPlan } from './orchestrationContract.js';
import { OrchestrationPlanner, pictureMissingDecision } from './orchestrationPlanner.js';
import { orchestrationPlanDocument } from './orchestrationPlanDocument.js';
import { splitOversizedTasks } from './orchestrationPlanSize.js';
import type { OrchestrationTaskPackage } from './orchestrationService.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';
import { fitCheckCards, fitCheckConflicts, fitCheckProblems } from './planFitCheck.js';
import { productPictureFor, productPictureRoom, type ProductPictureSource } from './productPicture.js';
import { AGENT_PRODUCT_PICTURE_UNAVAILABLE, agentProductPicture, readAgentProductPicture } from './productPictureSource.js';
import { appendOrchestrationTaskPolicy, formatOrchestrationTaskPackage, productFitInstruction, RunnerService } from './runnerService.js';
import { plannedJson } from '../test/planFitFixture.js';

/** Project A as it stood on 2026-11-23 (PRODUCT_EXPLANATION_PLAN "What happened"). */
const projectA = { id: 'project-a', name: 'Project A', description: 'I want project a to be a informational website' };
const KEEP_INFORMATIONAL = 'Keep Project A informational. Reconcile the expense workflow tasks PRO-102 through PRO-106 with that direction.';
const EXPENSE_CARDS = ['Expense storage', 'Add, edit, and delete expenses', 'Filters and search', 'Spending summary', 'Expense categories'];
const EXPENSE_KEYS = EXPENSE_CARDS.map((_, index) => `PRO-${102 + index}`);

function card(identifier: string, title: string, status: Issue['status'], extra: Partial<Issue> = {}): Issue {
  return { id: `issue-${identifier}`, identifier, title, description: '', status, priority: 'medium', projectId: projectA.id,
    labels: [], createdAt: '2026-11-20T00:00:00.000Z', ...extra } as unknown as Issue;
}

const projectAIssues: Issue[] = [
  card('PRO-101', 'Landing Page', 'todo'),
  ...EXPENSE_CARDS.map((title, index) => card(EXPENSE_KEYS[index], title, 'backlog')),
  card('PRO-110', 'Build: Keep Project A informational.', 'todo', { labels: ['alpha:chat-build'], createdAt: '2026-11-21T00:00:00.000Z',
    description: `Build requested from project chat.\n\nOriginal request: ${KEEP_INFORMATIONAL}` })
];

const projectASource: ProductPictureSource = {
  issues: () => projectAIssues,
  snapshots: () => [{
    // Approved and started: a specialist stopped on the question (Project A's blocker).
    run: { status: 'blocked', plan: { goal: 'Complete the expense workflow tasks', decisions: [{ about: 'Scope', decision: 'Expense tracking stays out until the owner decides.' }] } },
    tasks: [], attempts: [{ taskId: 't1', status: 'rejected', failureReason: 'The specialist reported a blocker: Should Project A stay informational?' }]
  } as unknown as OrchestrationSnapshot],
  approvedSpec: () => null
};

const response = (content: string): CliTurnResult => ({ content, thinking: '', tools: [], sessionId: null, bin: 'fixture', failureDetail: null, failureKind: null });

const landingTask = {
  id: 'landing', title: 'Informational landing page', description: 'Build the landing page that introduces Project A.', kind: 'frontend',
  ownerAgentId: 'frontend-agent', dependsOn: [], requirementIds: ['REQ-SITE'], acceptanceCriteria: ['The landing page explains what Project A offers.'],
  requiredChecks: ['test'], scope: { includePaths: ['src/**'], excludePaths: [] }, required: true
};
const expenseTask = {
  ...landingTask, id: 'expenses', title: 'Expense tracker', description: 'Add, edit and delete expenses with a spending summary.',
  requirementIds: ['REQ-EXPENSES'], acceptanceCriteria: ['Expenses can be added, edited and deleted.']
};
const CONFLICT_DECISION = 'Expense workflow vs the informational brief';
/** The planner's own decision on the conflict: names every conflicting card and task, and says how to choose otherwise. */
const conflictDecision = { about: CONFLICT_DECISION,
  decision: 'PRO-102, PRO-103, PRO-104, PRO-105, PRO-106 and task expenses are built as asked, although the brief says informational.',
  toChange: 'Say "keep it informational" and Alpha will plan without the expense cards.' };

const planningInput = {
  runId: 'run-fit', cwd: 'D:/repositories/project-a', goal: KEEP_INFORMATIONAL,
  projectContext: `Project: ${projectA.description}`,
  productPicture: productPictureFor(projectA, 'team', projectASource),
  repositoryContext: 'React starter scaffold.', availableScripts: ['test'],
  eligibleAgents: [{ id: 'frontend-agent', role: 'Frontend Agent' }],
  planner: { id: 'orchestrator', name: 'Orchestrator', role: 'Orchestrator Agent', provider: 'OpenAI', modelName: 'fixture-model' }
} as const;

/** The planning input for a request that builds the five expense cards, as projectBuildOrchestrator sends it. */
const cardBuildInput = { ...planningInput, buildsCards: EXPENSE_KEYS.map(key => ({ key })) };

const expensePlan = (fitCheck: unknown[], decisions: unknown[] = []) => ({
  schemaVersion: 1, goal: KEEP_INFORMATIONAL, decisions,
  requirements: [{ id: 'REQ-EXPENSES', description: 'The expense cards PRO-102 to PRO-106.' }],
  tasks: [expenseTask], fitCheck
});
const cardConflicts = (surfacedIn?: string) => EXPENSE_KEYS.map(key => ({ subject: key, subjectType: 'card', verdict: 'conflicts',
  reason: 'An expense tracker goes against the brief (an informational website) and the request to keep Project A informational.',
  ...(surfacedIn ? { surfacedIn } : {}) }));
const taskConflict = (surfacedIn?: string) => ({ subject: 'expenses', subjectType: 'task', verdict: 'conflicts',
  reason: 'Builds expense features the brief and the recorded request rule out.', ...(surfacedIn ? { surfacedIn } : {}) });

function scripted(...replies: unknown[]) {
  return vi.fn(async (_options: CliTurnOptions) => {
    const next = replies.length > 1 ? replies.shift() : replies[0];
    return response(typeof next === 'string' ? next : JSON.stringify(next));
  });
}

describe('the planner gets the product picture', () => {
  it('puts the brief, board, chat requests and recorded decisions in the planning input, with the fit-check rule', async () => {
    const turn = scripted(plannedJson({ schemaVersion: 1, goal: 'Landing page', requirements: [{ id: 'REQ-SITE', description: 'Landing page.' }], tasks: [landingTask] }, EXPENSE_KEYS));
    await new OrchestrationPlanner(turn).createPlan(cardBuildInput);
    const { prompt, systemPrompt } = turn.mock.calls[0][0];
    expect(prompt).toContain('I want project a to be a informational website');
    expect(prompt).toContain('PRO-103 Add, edit, and delete expenses');
    expect(prompt).toContain('Keep Project A informational.');
    expect(prompt).toContain('Expense tracking stays out until the owner decides.');
    expect(prompt).toContain('"boardCardsBuilt"');
    expect(prompt).toContain('"PRO-106"');
    expect(prompt).toContain('return fitCheck: one entry for every task');
    expect(systemPrompt).toContain('Plan for the product, not only the code.');
    expect(systemPrompt).toContain('"Fit with the product"');
  });

  it('says plainly when no picture was supplied instead of leaving the planner to guess', async () => {
    const turn = scripted(plannedJson({ schemaVersion: 1, goal: 'Landing page', requirements: [{ id: 'REQ-SITE', description: 'Landing page.' }], tasks: [landingTask] }));
    await new OrchestrationPlanner(turn).createPlan({ ...planningInput, productPicture: undefined });
    expect(turn.mock.calls[0][0].prompt).toContain('"productPicture": "Not available for this plan: no product picture was supplied for this plan.');
  });
});

describe('a Project A plan against "keep it informational"', () => {
  it('may leave the expense features out: an informational plan that fits is accepted', async () => {
    const informational = { schemaVersion: 1, goal: KEEP_INFORMATIONAL,
      decisions: [{ about: 'Fit with the product', decision: 'Only the informational landing page is planned; the expense cards stay unbuilt, as the request asks.' }],
      requirements: [{ id: 'REQ-SITE', description: 'An informational landing page.' }], tasks: [landingTask],
      fitCheck: [{ subject: 'landing', subjectType: 'task', verdict: 'fits', reason: 'The brief and the request ask for an informational website.' }] };
    const result = await new OrchestrationPlanner(scripted(informational)).createPlan(planningInput);
    expect(result.plan.tasks.map(task => task.title)).toEqual(['Informational landing page']);
    expect(result.plan.fitCheck).toHaveLength(1);
  });

  it('may ask one planning question before any work starts', async () => {
    const turn = scripted({ needsDecision: { question: 'The board plans an expense tracker, but the brief says Project A is an informational website. Which should this build follow?',
      options: [{ label: 'Keep it informational' }, { label: 'Add the expense tracker' }] } });
    await expect(new OrchestrationPlanner(turn).createPlan(cardBuildInput)).rejects.toMatchObject({
      code: 'needs_decision', decision: { question: expect.stringContaining('informational website') } });
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it('may build the cards when it records the conflict as a decision the person sees when approving', async () => {
    const decision = conflictDecision;
    const plan = expensePlan([...cardConflicts(CONFLICT_DECISION), taskConflict(CONFLICT_DECISION)], [decision]);
    const result = await new OrchestrationPlanner(scripted(plan)).createPlan(cardBuildInput);
    expect(result.plan.decisions).toContainEqual(decision);
    const document = orchestrationPlanDocument(result.plan, 1).content;
    expect(document).toContain('## Fit with the product');
    expect(document).toContain('conflicts: An expense tracker goes against the brief');
  });

  it('may cite the settled question that decided the conflict', async () => {
    const question = 'Should Project A stay informational or add the expense tracker?';
    const plan = expensePlan([...cardConflicts(question), taskConflict(question)]);
    const result = await new OrchestrationPlanner(scripted(plan)).createPlan({ ...cardBuildInput,
      settledDecisions: [{ question, answer: 'Add the expense tracker.' }] });
    expect(result.plan.fitCheck?.every(entry => entry.surfacedIn === question)).toBe(true);
  });
});

describe('the required fit check is enforced', () => {
  it('refuses a plan whose fit check misses a card it builds, after one correction', async () => {
    const missing = expensePlan([...cardConflicts(CONFLICT_DECISION).slice(1), taskConflict(CONFLICT_DECISION)],
      [conflictDecision]);
    const turn = scripted(missing);
    await expect(new OrchestrationPlanner(turn).createPlan(cardBuildInput)).rejects.toThrow(/no card entry for board card PRO-102/);
    expect(turn).toHaveBeenCalledTimes(2);
    expect(turn.mock.calls[1][0].prompt).toContain("Keep the plan's fit check complete while correcting it.");
  });

  it('refuses a plan that lists a conflict without a planning question or a decision for it', async () => {
    const unsurfaced = expensePlan([...cardConflicts(), taskConflict('A decision that does not exist')]);
    await expect(new OrchestrationPlanner(scripted(unsurfaced)).createPlan(cardBuildInput))
      .rejects.toThrow(/conflict for PRO-102, PRO-103, PRO-104, PRO-105, PRO-106, expenses that is not surfaced/);
  });

  it('refuses a plan with no fit check, and accepts the correction that adds one', async () => {
    const plan = { schemaVersion: 1, goal: 'Landing page', requirements: [{ id: 'REQ-SITE', description: 'Landing page.' }], tasks: [landingTask] };
    await expect(new OrchestrationPlanner(scripted(plan)).createPlan(planningInput)).rejects.toThrow(/The plan has no fitCheck/);
    const turn = scripted(plan, plannedJson(plan));
    const result = await new OrchestrationPlanner(turn).createPlan(planningInput);
    expect(turn.mock.calls[1][0].prompt).toContain('The plan has no fitCheck');
    expect(result.plan.fitCheck).toEqual([expect.objectContaining({ subject: 'landing', verdict: 'fits' })]);
  });

  it('names every missing task, and is satisfied by entries for split task parts', () => {
    const plan = parseOrchestrationPlan(expensePlan([taskConflict(CONFLICT_DECISION)], [conflictDecision]));
    expect(fitCheckProblems({ ...plan, tasks: [...plan.tasks, { ...plan.tasks[0], id: 'summary' }] }, { cards: [], settledQuestions: [], decisionsVisible: true }))
      .toEqual([expect.stringContaining('no task entry for summary')]);
    const requirementIds = Array.from({ length: 14 }, (_, index) => `REQ-${index}`);
    const oversized = { ...expensePlan([taskConflict(CONFLICT_DECISION)], [conflictDecision]),
      requirements: requirementIds.map(id => ({ id, description: id })), tasks: [{ ...expenseTask, requirementIds }] };
    const split = parseOrchestrationPlan(splitOversizedTasks(oversized).candidate);
    expect(split.tasks.map(task => task.id)).toEqual(['expenses', 'expenses-part-2']);
    expect(fitCheckProblems(split, { cards: [], settledQuestions: [], decisionsVisible: true })).toEqual([]);
  });
});

describe('plans saved before the fit check', () => {
  it('still parse and pass the plan checks a saved plan runs under at start; only a new or corrected plan needs one', () => {
    const saved = parseOrchestrationPlan({ schemaVersion: 1, goal: 'Landing page', requirements: [{ id: 'REQ-SITE', description: 'Landing page.' }],
      tasks: [{ ...landingTask, requiredChecks: ['test'] }] });
    expect(saved.fitCheck).toBeUndefined();
    expect(validateOrchestrationPlan(saved, [{ id: 'frontend-agent', role: 'Frontend Agent' }])).toEqual([]);
    expect(fitCheckCards(saved)).toEqual([]);
    expect(fitCheckProblems(saved, { cards: [], settledQuestions: [], decisionsVisible: true })).toEqual([expect.stringContaining('no fitCheck')]);
  });

  it('a revision checks again the cards the saved plan was checked against', () => {
    expect(fitCheckCards(parseOrchestrationPlan(expensePlan([...cardConflicts(CONFLICT_DECISION), taskConflict(CONFLICT_DECISION)]))))
      .toEqual(EXPENSE_KEYS.map(key => ({ key })));
  });
});

describe('the picture stays within the planner context bounds', () => {
  it('fills only the room the project context leaves, keeps the brief and never shortens the project context', () => {
    // About 600 characters of room left: less than the whole picture, more than its brief.
    const longRules = `Project: ${projectA.description}\n${'Keep every page accessible. '.repeat(262)}`;
    expect(productPictureFor(projectA, 'team', projectASource).length).toBeGreaterThan(productPictureRoom(longRules));
    const picture = agentProductPicture(projectA, longRules, projectASource);
    expect(longRules.length + picture.length).toBeLessThanOrEqual(MAX_PROJECT_CONTEXT_CHARS);
    expect(picture).toContain('Brief (project description): I want project a to be a informational website');
    expect(picture.endsWith('… (shortened)')).toBe(true);
    expect(productPictureRoom('x'.repeat(MAX_PROJECT_CONTEXT_CHARS - 100))).toBe(0);
    expect(agentProductPicture(projectA, 'x'.repeat(MAX_PROJECT_CONTEXT_CHARS - 100), projectASource)).toBe('');
  });

  it('cuts an oversized picture in the planning prompt to the room left', async () => {
    const turn = scripted(plannedJson({ schemaVersion: 1, goal: 'Landing page', requirements: [{ id: 'REQ-SITE', description: 'Landing page.' }], tasks: [landingTask] }));
    const projectContext = 'p'.repeat(MAX_PROJECT_CONTEXT_CHARS - 50);
    await new OrchestrationPlanner(turn).createPlan({ ...planningInput, projectContext, productPicture: `${'q'.repeat(50)}TAIL-THAT-DOES-NOT-FIT` });
    expect(turn.mock.calls[0][0].prompt).toContain(`"productPicture": "${'q'.repeat(50)}"`);
  });

  it('says the records could not be read instead of dropping the picture', () => {
    const failing: ProductPictureSource = { ...projectASource, snapshots: () => { throw new Error('database is locked'); } };
    expect(agentProductPicture(projectA, '', failing)).toBe(AGENT_PRODUCT_PICTURE_UNAVAILABLE);
  });
});

function taskPackage(kind: OrchestrationTaskPackage['task']['kind'], extra: Partial<OrchestrationTaskPackage> = {}): OrchestrationTaskPackage {
  return {
    packageVersion: 8, reportSchemaVersion: 1, goal: KEEP_INFORMATIONAL, projectContext: `Project: ${projectA.description}`,
    productPicture: productPictureFor(projectA, 'team', projectASource), exclusions: [],
    task: { id: 'landing', title: 'Landing page', kind, repository: 'acme/site', description: 'Build the landing page.',
      acceptanceCriteria: ['It explains the product.'], requiredChecks: ['test'], scope: { includePaths: ['src/**'], excludePaths: [] } },
    requirements: [{ id: 'REQ-SITE', description: 'Landing page.' }], acceptedDependencies: [], reviewInputs: [], corrections: [], findingIds: [],
    ...extra
  } as OrchestrationTaskPackage;
}

const orchestrationFor = (pkg: OrchestrationTaskPackage) => ({
  orchestrationRunId: 'run', taskId: pkg.task.id, attemptId: 'attempt', branchName: 'alpha/build', planVersion: 1, taskPackage: pkg,
  personaHash: 'hash', modelProvider: 'OpenAI', modelName: 'fixture'
});

describe('specialists and reviewers choose by fit with the product', () => {
  const CHOOSE = 'Choose the approach that fits the product\'s purpose, its existing stack and its recorded decisions';
  const REVIEW = 'Review for fit with the product, not only code quality';

  it('every orchestration prompt builder carries the picture and the one fit instruction', () => {
    const pkg = taskPackage('frontend');
    const policy = appendOrchestrationTaskPolicy('Persona.', { name: 'Frontend', role: 'Frontend Agent' }, orchestrationFor(pkg));
    const formatted = formatOrchestrationTaskPackage(pkg);
    const buildTaskPrompt = (RunnerService.prototype as unknown as { buildTaskPrompt: (...args: unknown[]) => string }).buildTaskPrompt;
    const taskPrompt = buildTaskPrompt({ identifier: 'PRO-101', title: 'Landing Page', description: '' }, [], undefined, [], 'read', undefined, orchestrationFor(pkg));
    for (const prompt of [policy, formatted, taskPrompt]) expect(prompt).toContain(CHOOSE);
    for (const prompt of [formatted, taskPrompt]) {
      expect(prompt).toContain('Product picture (Alpha\'s own records about this product');
      expect(prompt).toContain('I want project a to be a informational website');
    }
    expect(productFitInstruction(pkg)).toContain('prefer the one the repository already uses. Say in your report summary');
  });

  it('a reviewer checks fit with the product, and a format-only correction gets no new instruction', () => {
    const review = taskPackage('review');
    expect(appendOrchestrationTaskPolicy('Persona.', { name: 'Security', role: 'Security / Code Quality Agent' }, orchestrationFor(review))).toContain(REVIEW);
    expect(formatOrchestrationTaskPackage(review)).toContain(REVIEW);
    expect(formatOrchestrationTaskPackage(review)).not.toContain(CHOOSE);
    expect(productFitInstruction(taskPackage('frontend', { reportCorrection: { validationErrors: ['x'], previousResponse: '{}' } }))).toBe('');
  });

  it('a package saved before the picture still renders without it', () => {
    const old = taskPackage('frontend', { packageVersion: 7, productPicture: undefined });
    expect(formatOrchestrationTaskPackage(old)).not.toContain('Product picture (');
    expect(formatOrchestrationTaskPackage(old)).toContain(CHOOSE);
  });
});

describe('task packages carry the picture, read fresh at dispatch', () => {
  let directory = '';
  afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = ''; });

  it('a card recorded after the plan was saved reaches the task dispatched after it', async () => {
    const { SQLiteService } = await import('./sqliteService.js');
    const { OrchestrationService } = await import('./orchestrationService.js');
    const { runWithWorkspace } = await import('./workspaceContext.js');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-product-fit-'));
    const store = new SQLiteService({ dbPath: path.join(directory, 'alpha.db'), seedDefaults: false });
    try {
      const workspaceId = 'workspace-fit';
      runWithWorkspace(workspaceId, () => store.createProject({ id: projectA.id, name: projectA.name, key: 'PRO', description: projectA.description }));
      const launches: Array<{ taskPackage: OrchestrationTaskPackage }> = [];
      const orchestrator = new OrchestrationService(store, { async launch(request) { launches.push(request); return { prototypeRunId: `p-${request.attemptId}` }; } });
      const plan = parseOrchestrationPlan({ schemaVersion: 1, goal: KEEP_INFORMATIONAL, projectContext: `Project: ${projectA.description}`,
        requirements: [{ id: 'REQ-SITE', description: 'Landing page.' }], tasks: [{ ...landingTask, requiredChecks: [] }] });
      const saved = await orchestrator.start({ workspaceId, projectId: projectA.id, issueId: 'issue-fit', repository: 'acme/site', requestKey: 'fit',
        requestFingerprint: 'fit', createdBy: 'user', executorId: 'desktop', eligibleAgents: [{ id: 'frontend-agent', role: 'Frontend Agent' }], plan });
      runWithWorkspace(workspaceId, () => store.createIssue({ projectId: projectA.id, identifier: 'PRO-120', title: 'Contact page', status: 'todo' }));
      await orchestrator.startPlannedWork({ workspaceId, runId: saved.run.id, expectedRevision: saved.run.revision, actorId: 'user' });
      store.addAllowedPath(directory, 'product fit test workspace');
      runWithWorkspace(workspaceId, () => store.bindOrchestrationWorkspace({ runId: saved.run.id, branchName: 'alpha/orchestration/fit',
        baseRef: 'refs/heads/main', baseCommit: 'a'.repeat(40), worktreePath: directory }));
      expect(launches).toHaveLength(1);
      const pkg = launches[0].taskPackage;
      expect(pkg.packageVersion).toBe(8);
      expect(pkg.productPicture).toContain('Brief (project description): I want project a to be a informational website');
      expect(pkg.productPicture).toContain('PRO-120 Contact page');
      expect(pkg.projectContext.length + (pkg.productPicture?.length ?? 0)).toBeLessThanOrEqual(MAX_PROJECT_CONTEXT_CHARS);
    } finally {
      store.close();
    }
  });
});

describe('only a decision the person can act on surfaces a conflict', () => {
  const scope = { cards: [], settledQuestions: [], decisionsVisible: true };
  const withDecision = (decision: Record<string, unknown>) =>
    parseOrchestrationPlan(expensePlan([taskConflict(String(decision.about))], [decision]));

  it('does not count a decision Alpha added, the general fit note, or one that does not name the work or say how to change it', () => {
    expect(fitCheckProblems(withDecision({ ...conflictDecision, by: 'alpha' }), scope)).toEqual([expect.stringContaining('not surfaced')]);
    expect(fitCheckProblems(withDecision({ ...conflictDecision, about: 'Fit with the product' }), scope)).toEqual([expect.stringContaining('not surfaced')]);
    expect(fitCheckProblems(withDecision({ ...conflictDecision, toChange: undefined }), scope)).toEqual([expect.stringContaining('not surfaced')]);
    expect(fitCheckProblems(withDecision({ ...conflictDecision, decision: 'The expense cards are built as asked.' }), scope))
      .toEqual([expect.stringContaining('not surfaced')]);
    expect(fitCheckProblems(withDecision(conflictDecision), scope)).toEqual([]);
  });

  it('never lets the planner mark its own decision as written by Alpha', async () => {
    const plan = expensePlan([...cardConflicts(CONFLICT_DECISION), taskConflict(CONFLICT_DECISION)], [{ ...conflictDecision, by: 'alpha' }]);
    const result = await new OrchestrationPlanner(scripted(plan)).createPlan(cardBuildInput);
    expect(result.plan.decisions?.find(item => item.about === CONFLICT_DECISION)).not.toHaveProperty('by');
  });

  it('matches coverage by subject type: a task entry does not cover a card of the same name', () => {
    const plan = parseOrchestrationPlan(expensePlan([taskConflict(CONFLICT_DECISION),
      { subject: 'PRO-102', subjectType: 'task', verdict: 'fits', reason: 'Mislabelled.' }], [conflictDecision]));
    expect(fitCheckProblems(plan, { ...scope, cards: [{ key: 'PRO-102' }] })).toEqual([expect.stringContaining('no card entry for board card PRO-102')]);
  });

  it('in a later milestone, which nobody approves, a conflict must be asked rather than recorded', async () => {
    const plan = parseOrchestrationPlan(expensePlan([taskConflict(CONFLICT_DECISION)], [conflictDecision]));
    expect(fitCheckProblems(plan, { ...scope, decisionsVisible: false })).toEqual([expect.stringContaining('Nobody approves a later milestone')]);
    const turn = scripted(plan);
    await expect(new OrchestrationPlanner(turn).createPlan({ ...planningInput, approvedRequirements: plan.requirements,
      milestoneContext: { id: 'm2', title: 'Expenses', objective: 'Expenses.' } })).rejects.toThrow(/Nobody approves a later milestone/);
    expect(turn.mock.calls[0][0].prompt).toContain('This is a later milestone: nobody approves its plan');
  });

  it('shows every conflict next to the decisions in the plan-ready chat message', async () => {
    const { describePlanDecisions } = await import('./chatService.js');
    const plan = parseOrchestrationPlan(expensePlan([...cardConflicts(CONFLICT_DECISION), taskConflict(CONFLICT_DECISION)], [conflictDecision]));
    const text = describePlanDecisions(plan.decisions, fitCheckConflicts(plan))!;
    expect(text).toContain('**Where this plan goes against the product**');
    for (const subject of [...EXPENSE_KEYS, 'expenses']) expect(text).toContain(`- **${subject}:**`);
    expect(text).toContain(`(see: ${CONFLICT_DECISION})`);
    expect(text.indexOf('goes against the product')).toBeLessThan(text.indexOf('What the Orchestrator decided'));
    expect(describePlanDecisions(undefined, fitCheckConflicts(plan))).toContain('PRO-102');
  });
});

describe('a plan made without the product picture says so where the person approves', () => {
  const plan = { schemaVersion: 1, goal: 'Landing page', requirements: [{ id: 'REQ-SITE', description: 'Landing page.' }], tasks: [landingTask] };

  it('carries Alpha\'s own decision that fit was not checked, with the reason, even when every task is marked as fitting', async () => {
    const result = await new OrchestrationPlanner(scripted(plannedJson(plan))).createPlan({ ...planningInput, productPicture: undefined,
      productPictureMissing: "the project's records could not be read" });
    expect(result.plan.decisions?.[0]).toEqual(pictureMissingDecision("the project's records could not be read"));
    expect(result.plan.decisions?.[0].decision).toContain('Not checked against the product\'s records: the project\'s records could not be read.');
  });

  it('counts a picture cut to nothing by the context bound as missing too', async () => {
    const result = await new OrchestrationPlanner(scripted(plannedJson(plan))).createPlan({ ...planningInput,
      projectContext: 'p'.repeat(MAX_PROJECT_CONTEXT_CHARS) });
    expect(result.plan.decisions?.[0]).toMatchObject({ about: 'Fit with the product', by: 'alpha',
      decision: expect.stringContaining('the project context left no room for it') });
  });

  it('refuses a plan whose own decisions crowd that note out', async () => {
    const crowded = { ...plan, decisions: Array.from({ length: 12 }, (_, index) => ({ about: `Choice ${index}`, decision: 'Chosen.' })) };
    await expect(new OrchestrationPlanner(scripted(plannedJson(crowded))).createPlan({ ...planningInput, productPicture: undefined }))
      .rejects.toThrow(/must keep Alpha's "Fit with the product" decision/);
  });

  it('a picture that was read adds no such note', async () => {
    const result = await new OrchestrationPlanner(scripted(plannedJson(plan))).createPlan(planningInput);
    expect(result.plan.decisions ?? []).not.toContainEqual(expect.objectContaining({ by: 'alpha', about: 'Fit with the product' }));
  });

  it('says why the picture is missing: no project, no room, or unreadable records', () => {
    expect(readAgentProductPicture(undefined, '', projectASource)).toEqual({ productPictureMissing: 'the project record was not found' });
    expect(readAgentProductPicture(projectA, 'x'.repeat(MAX_PROJECT_CONTEXT_CHARS), projectASource).productPictureMissing).toContain('no room');
    const failing: ProductPictureSource = { ...projectASource, issues: () => { throw new Error('locked'); } };
    expect(readAgentProductPicture(projectA, '', failing)).toEqual({ productPictureMissing: "the project's records could not be read" });
    expect(readAgentProductPicture(projectA, '', projectASource).productPicture).toContain('Brief (project description)');
  });
});
