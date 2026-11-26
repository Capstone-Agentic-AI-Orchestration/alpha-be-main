import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Alpha as the Orchestrator.
 *
 * The chat no longer has a mode switch. Alpha answers every unaddressed
 * message and, when it decides the user wants a product change, writes one
 * decision line. These pin what the server does with that line: which replies
 * start a build, which become a question to the user, and which never can.
 */

let tmp: string;
let opened: { close(): void }[] = [];
let cliReply: { content: string; failureKind?: string };
let systemPrompts: string[];
let turnInputs: any[];
let cliReplies: string[];
/** The isolated consent check's answer (it sees only the message, the action and the build's state). */
let consentAnswer = true;
const startProjectBuildBatch = vi.fn();
const cancelRun = vi.fn();
const startPlannedWork = vi.fn();
const approveAndPublish = vi.fn();
const requestReviewChanges = vi.fn();
const reviseBoardPlan = vi.fn();

const context = { workspaceId: 'ws-default', userId: 'user-1', role: 'admin', access: {} } as any;
const twoRepos = [{ type: 'github_repo', pathOrUrl: 'https://github.com/org/fe' }, { type: 'github_repo', pathOrUrl: 'https://github.com/org/be' }];

async function load() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  vi.doMock('./cliRunner.js', () => ({
    providerResumesSessions: (provider: string) => provider !== 'OpenAI',
    runCliTurn: vi.fn(async (input: { systemPrompt?: string; mcpServers?: string[]; responseSchema?: any }) => {
      systemPrompts.push(input.systemPrompt ?? '');
      turnInputs.push(input);
      if (input.responseSchema?.properties?.consent) {
        const asked = JSON.parse((input as { prompt: string }).prompt);
        return { content: JSON.stringify({ consent: consentAnswer, evidence: consentAnswer ? asked.message : '' }), bin: 'claude', thinking: '', tools: [], sessionId: undefined };
      }
      let content = cliReplies.shift() ?? cliReply.content;
      if (input.responseSchema?.properties?.contract) {
        const { parseAlphaRoute } = await import('./chatRouter.js');
        const parsed = parseAlphaRoute(content);
        if (!parsed.malformed) content = JSON.stringify({ contract: 'alpha_chat_v1', message: parsed.message,
          decision: parsed.decision ? { ...parsed.decision, assignments: parsed.decision.assignments ?? [] } : null });
      }
      return {
        content,
        failureKind: cliReply.failureKind,
        failureDetail: cliReply.failureKind ? 'not signed in' : undefined,
        bin: 'claude',
        thinking: '',
        tools: [],
        sessionId: undefined
      };
    })
  }));
  vi.doMock('./projectBuildOrchestrator.js', () => ({ startProjectBuildBatch }));
  vi.doMock('./orchestrationRuntime.js', () => ({ orchestrationService: { cancelRun, startPlannedWork, approveAndPublish, requestReviewChanges } }));
  vi.doMock('./boardPlanRevision.js', () => ({ reviseBoardPlan }));
  const sql = await import('./sqliteService.js');
  opened.push(sql.sqliteService as any);
  opened.push((await import('./workspaceRegistry.js')).workspaceRegistry as any);
  sql.sqliteService.saveRuntimes([{
    id: 'claude', name: 'Claude Code CLI', provider: 'Anthropic', status: 'online',
    type: 'cloud', latencyMs: 1, models: ['claude-sonnet-5'], isDefault: true
  }] as any);
  const { chatService } = await import('./chatService.js');
  return { chatService, sqlite: sql.sqliteService };
}

const send = (chatService: any, content: string, over: Record<string, unknown> = {}) => chatService.sendMessage({
  threadId: 'thread-1',
  content,
  clientMessageId: `msg-${Math.random().toString(36).slice(2)}`,
  routing: { context, canBuild: true },
  ...over
});

describe('board cards from the routing decision', () => {
  it('passes the router\'s card choice to the build, and keeps it on a proposal', async () => {
    const { chatService } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Build the remaining tasks","repositories":[],"cards":["all"]}' };
    await send(chatService, 'start will the task, do it per phase', { projectId: 'project-1' });
    expect(startProjectBuildBatch.mock.calls[0][0].boardCards).toEqual(['all']);

    cliReply = { content: 'ALPHA_ROUTE {"route":"confirm_build","goal":"Build the scaffold","repositories":[],"cards":["PRO-103"]}\nShall I plan the scaffold?' };
    const proposal = await send(chatService, 'maybe do the scaffold', { projectId: 'project-1' });
    expect(proposal.agentMessage.routeProposal).toMatchObject({ status: 'open', cards: ['PRO-103'] });
  });
});

beforeEach(() => {
  consentAnswer = true;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-chat-routing-'));
  opened = [];
  systemPrompts = [];
  turnInputs = [];
  cliReplies = [];
  startProjectBuildBatch.mockReset();
  cancelRun.mockReset();
  startPlannedWork.mockReset(); approveAndPublish.mockReset();
  process.env.ALPHA_ORCHESTRATION_ENABLED = '1';
  startProjectBuildBatch.mockResolvedValue([{
    status: 'plan_ready', orchestrationRunId: 'orchestration-1', issueIdentifier: 'MON-1', orchestrationTaskCount: 2
  }]);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const handle of opened) {
    try { handle.close(); } catch { /* already closed */ }
  }
  vi.doUnmock('./cliRunner.js');
  vi.doUnmock('./projectBuildOrchestrator.js');
  vi.doUnmock('./orchestrationRuntime.js');
  delete process.env.ALPHA_HOME;
  delete process.env.ALPHA_ORCHESTRATION_ENABLED;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function specialistFixture() {
  const loaded = await load();
  loaded.sqlite.createProject({ id: 'project-1', name: 'Task app', key: 'TASK', resources: [] } as any);
  for (const [id, role] of [['backend-specialist', 'Backend Agent'], ['frontend-specialist', 'Frontend Agent']]) {
    loaded.sqlite.createAgent({ id, name: id, role, modelProvider: 'Anthropic', modelName: 'claude-sonnet-5',
      description: `Expert in ${role}`, autonomyLevel: 'Full Autonomy', skills: ['sk-fs', 'sk-bash'],
      mcpServers: ['unrelated-server'], allowedUsers: 'team' } as any);
  }
  const { workspaceRegistry } = await import('./workspaceRegistry.js');
  vi.spyOn(workspaceRegistry, 'canAccessProject').mockReturnValue(true);
  const access = vi.spyOn(workspaceRegistry, 'canAccessProjectAgentRun').mockResolvedValue(true);
  return { ...loaded, access };
}

describe('specialist analysis handoffs', () => {
  it('stops the preview when the Orchestrator decides to, without changing the build', async () => {
    const { chatService } = await specialistFixture();
    const { localPreviewService } = await import('./localPreviewService.js');
    const stop = vi.spyOn(localPreviewService, 'stopForThread').mockResolvedValue(1);
    cliReply = { content: 'ALPHA_ROUTE {"route":"stop_preview"}' };
    const result = await send(chatService, 'now stop the local run', { projectId: 'project-1' });
    expect(result.agentMessage.content).toContain('preview has stopped');
    expect(stop).toHaveBeenCalledWith(context, 'thread-1');
    expect(startProjectBuildBatch).not.toHaveBeenCalled(); expect(cancelRun).not.toHaveBeenCalled();
  });
  it('reports a preview shutdown failure instead of claiming success', async () => {
    const { chatService } = await specialistFixture();
    const { localPreviewService } = await import('./localPreviewService.js');
    vi.spyOn(localPreviewService, 'stopForThread').mockRejectedValue(new Error('shutdown not confirmed'));
    cliReply = { content: 'ALPHA_ROUTE {"route":"stop_preview"}' };
    const result = await send(chatService, 'stop the preview', { projectId: 'project-1' });
    expect(result.agentMessage.content).toContain('could not be stopped: shutdown not confirmed');
  });
  it('hands runtime evidence and the preview source to a read-only specialist rather than the ordinary checkout', async () => {
    const { chatService } = await specialistFixture();
    const { localPreviewService } = await import('./localPreviewService.js');
    const root = { name: 'site', repo: 'acme/site', dir: path.join(tmp, 'preview-source') };
    vi.spyOn(localPreviewService, 'chatEvidence').mockResolvedValue({ roots: [root], text: 'Preview commit abc: browser runtime error', sourceKey: 'preview:abc' });
    cliReply = { content: 'The preview evidence identifies a browser error.' };
    await send(chatService, 'Check the local website browser error', { projectId: 'project-1', targetAgentId: 'frontend-specialist' });
    expect(turnInputs[0].projectRoots).toEqual([root]);
    expect(turnInputs[0].prompt).toContain('Preview commit abc: browser runtime error');
    expect(turnInputs[0]).toMatchObject({ approvalMode: 'ask', skills: [], priorSession: null });
  });
  it.each(['ask', 'approve', 'full'])('keeps a directly selected specialist read-only with %s access', async approvalMode => {
    const { chatService, sqlite } = await specialistFixture();
    sqlite.createChatThread({ id: 'thread-1', title: 'Specialist', projectId: 'project-1' } as any);
    sqlite.setThreadSession('thread-1', 'backend-specialist', 'old-privileged-session', 'old-persona');
    cliReply = { content: 'The API uses explicit input validation.' };
    await send(chatService, 'Explain the API', { projectId: 'project-1', targetAgentId: 'backend-specialist', approvalMode });
    expect(turnInputs).toHaveLength(1);
    expect(turnInputs[0]).toMatchObject({ mode: 'chat', approvalMode: 'ask', skills: [], priorSession: null,
      autonomyLevel: 'Supervised', mcpServers: ['alpha-project-files', 'alpha-github', 'alpha-board'] });
    // An admin's specialist may read the board, as a developer's may; only the Manager Agent writes.
    expect(turnInputs[0].boardScope).toMatchObject({ access: 'read' });
    expect(turnInputs[0].systemPrompt).toContain('approved scoped build flow');
    // The specialist is told its runtime, so "which model are you" gets a true answer.
    expect(turnInputs[0].systemPrompt).toContain('## Your runtime');
  });

  it('routes a directly selected specialist code request into plan approval', async () => {
    const { chatService } = await specialistFixture();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add API request validation.","repositories":[]}' };
    await send(chatService, 'Add API request validation', { projectId: 'project-1', targetAgentId: 'backend-specialist', approvalMode: 'full' });
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
    expect(turnInputs[0].approvalMode).toBe('ask');
  });
  it('rechecks direct specialist project access before starting its CLI', async () => {
    const { chatService, access } = await specialistFixture();
    access.mockResolvedValue(false);
    cliReply = { content: 'Should not run' };
    const result = await send(chatService, 'Explain the API', { projectId: 'project-1', targetAgentId: 'backend-specialist', approvalMode: 'full' });
    expect(turnInputs).toHaveLength(0);
    expect(result.agentMessage.content).toContain('could not start');
  });
  const assignment = { agentId: 'backend-specialist', kind: 'backend', instruction: 'Inspect the API error handling and report evidence.', reason: 'Server-side expertise.' };
  const route = (assignments = [assignment]) => 'ALPHA_ROUTE ' + JSON.stringify({ route: 'delegate', goal: 'Review the project', assignments });

  it('selects specialists, records their replies, and strips all write grants despite Full access', async () => {
    const { chatService, sqlite } = await specialistFixture();
    cliReply = { content: route([assignment, { ...assignment, agentId: 'frontend-specialist', kind: 'frontend', instruction: 'Inspect UI error states.', reason: 'UI expertise.' }]) };
    cliReplies = [cliReply.content, 'API finding: missing error mapping.', 'UI finding: missing retry state.', 'Both reviews found missing error handling.'];
    const result = await send(chatService, 'Use my agents to review the project', { projectId: 'project-1', approvalMode: 'full', clientMessageId: 'handoff-message' });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    // Alpha's combined answer is the last word.
    expect(result.agentMessages.map((message: any) => message.senderName)).toEqual(['Alpha', 'backend-specialist', 'frontend-specialist', 'Alpha']);
    expect(result.agentMessages[0].content).toContain('Server-side expertise.');
    expect(turnInputs).toHaveLength(4);
    expect(turnInputs[0]).toMatchObject({ mode: 'chat', approvalMode: 'ask', personaChanged: true });
    for (const input of turnInputs.slice(1, 3)) {
      expect(input).toMatchObject({ mode: 'chat', approvalMode: 'ask', priorSession: null, skills: [], autonomyLevel: 'Supervised', mcpServers: ['alpha-project-files', 'alpha-github', 'alpha-board'] });
      expect(input.boardScope).toMatchObject({ access: 'read' });
      expect(input.systemPrompt).toContain('No edits, shell commands');
    }
    expect(turnInputs[0].systemPrompt).toContain('Expert in Backend Agent');
    expect(sqlite.getChatMessages('thread-1').filter((message: any) => message.agentId === 'backend-specialist')).toHaveLength(1);
    await send(chatService, 'Use my agents to review the project', { projectId: 'project-1', clientMessageId: 'handoff-message' });
    expect(turnInputs).toHaveLength(4);
  });

  it('hands off with every project codebase, whatever codebases the model named', async () => {
    const { chatService } = await specialistFixture();
    // The model's list is only a hint now: naming a codebase used to narrow, or here refuse, the handoff.
    cliReply = { content: 'ALPHA_ROUTE ' + JSON.stringify({ route: 'delegate', goal: 'Review the API', repositories: ['org/elsewhere'], assignments: [assignment] }) };
    cliReplies = [cliReply.content, 'API finding: missing error mapping.'];
    const result = await send(chatService, 'Use my agents to review the API', { projectId: 'project-1' });
    expect(result.agentMessages[0].content).toContain('Handing off read-only analysis');
    expect(result.agentMessages.map((message: any) => message.senderName)).toEqual(['Alpha', 'backend-specialist', 'Alpha']);
  });

  it.each(['unknown', 'role-mismatch', 'inaccessible', 'offline', 'stale-model'])('refuses a %s assignment without starting any specialist', async problem => {
    const { chatService, sqlite, access } = await specialistFixture();
    if (problem === 'inaccessible') access.mockResolvedValue(false);
    if (problem === 'offline') sqlite.saveRuntimes([{ id: 'claude', provider: 'Anthropic', name: 'Claude', status: 'offline', type: 'cloud', models: ['claude-sonnet-5'] }] as any);
    if (problem === 'stale-model') sqlite.updateAgent('backend-specialist', { modelName: 'retired-model' });
    cliReply = { content: route([{ ...assignment, agentId: problem === 'unknown' ? 'outside-agent' : assignment.agentId, kind: problem === 'role-mismatch' ? 'frontend' : assignment.kind }]) };
    const result = await send(chatService, 'Review the project', { projectId: 'project-1' });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(turnInputs.length).toBeLessThanOrEqual(1);
    expect(result.agentMessages).toHaveLength(1);
    if (problem !== 'offline') expect(result.agentMessage.content).toContain('could not hand off');
  });

  it('routes an explicitly selected orchestrator through specialist selection', async () => {
    const { chatService, sqlite } = await specialistFixture();
    const coordinator = sqlite.getAgents().find(agent => agent.templateKey === 'orchestrator')!;
    sqlite.updateAgent(coordinator.id, { modelProvider: 'Anthropic', modelName: 'claude-sonnet-5' });
    cliReply = { content: route() };
    cliReplies = [cliReply.content, 'API findings.'];
    const result = await send(chatService, 'Check the API', { projectId: 'project-1', targetAgentId: coordinator.id });
    expect(result.agentMessages.map((message: any) => message.senderName)).toEqual(['Alpha', 'backend-specialist', 'Alpha']);
    expect(turnInputs).toHaveLength(3);
  });

  it('rechecks access before dispatching the next specialist', async () => {
    const { chatService, access } = await specialistFixture();
    cliReply = { content: route([assignment, { ...assignment, agentId: 'frontend-specialist', kind: 'frontend' }]) };
    cliReplies = [cliReply.content, 'API findings.'];
    chatService.on('chat_message', (message: any) => {
      if (message.agentId === 'backend-specialist') access.mockResolvedValue(false);
    });
    const result = await send(chatService, 'Review the project', { projectId: 'project-1' });
    // Alpha, the backend specialist and Alpha's combined answer; the frontend specialist never starts.
    expect(turnInputs).toHaveLength(3);
    expect(result.agentMessages.at(-2).content).toContain('changed after the handoff');
    expect(result.agentMessages.at(-1).content).toContain('**frontend-specialist** did not start');
  });

  it('does not launch remaining specialists after the user stops the turn', async () => {
    const { chatService } = await specialistFixture();
    const { processManager } = await import('./processManager.js');
    vi.spyOn(processManager, 'terminateProcessAndWait').mockResolvedValue(undefined);
    cliReply = { content: route([assignment, { ...assignment, agentId: 'frontend-specialist', kind: 'frontend' }]) };
    cliReplies = [cliReply.content, 'API findings.'];
    let stopping: Promise<unknown> | undefined;
    chatService.on('chat_message', (message: any) => {
      if (message.agentId === 'backend-specialist') stopping = chatService.stopTurn('thread-1', 'stop-handoff');
    });
    await send(chatService, 'Review the project', { projectId: 'project-1', clientMessageId: 'stop-handoff' });
    await stopping;
    expect(turnInputs).toHaveLength(2);
  });

  it('permits analysis for users without build access but honors an explicit answer-only request', async () => {
    const { chatService } = await specialistFixture();
    cliReply = { content: route() };
    cliReplies = [cliReply.content, 'Read-only findings.'];
    await send(chatService, 'Review the API', { projectId: 'project-1', routing: { context, canBuild: false } });
    expect(turnInputs).toHaveLength(3);
    await send(chatService, '/ask explain the result', { routing: { context, canBuild: true, answerOnly: true } });
    expect(turnInputs).toHaveLength(4);
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });
});

describe('Alpha routes unaddressed chat messages', () => {
  it('gives the Orchestrator read-only GitHub tools and tells it changes go to specialist agents', async () => {
    const { chatService } = await load();
    cliReply = { content: 'The dev branch has two open pull requests.' };
    await send(chatService, 'What is open on GitHub for this project?', { projectId: 'project-1' });
    expect(turnInputs[0].mcpServers).toEqual(['alpha-github']);
    expect(systemPrompts[0]).toContain('## GitHub access (read only)');
    expect(systemPrompts[0]).toContain('Do not push, open pull requests, post reviews');
    expect(systemPrompts[0]).toContain('On GitHub you have read access only.');
  });

  it('answers a question without starting a build, even when it begins with "add"', async () => {
    const { chatService } = await load();
    cliReply = { content: 'Login stores a session cookie and refreshes it on each request.' };
    const result = await send(chatService, 'Can you add some context on how login works?', { projectId: 'project-1' });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessage.content).toBe('Login stores a session cookie and refreshes it on each request.');
    expect(systemPrompts[0]).toContain('ALPHA_ROUTE');
  });

  it('starts the Orchestrator with Alpha\'s goal and the user\'s words when Alpha decides to build', async () => {
    const { chatService, sqlite } = await load();
    sqlite.createProject({ id: 'project-1', name: 'Task app', key: 'TASK', resources: twoRepos } as any);
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Fix the login page losing its session on refresh","repositories":["org/fe"]}' };
    const result = await send(chatService, 'The login page breaks when I refresh, please look into it', {
      projectId: 'project-1',
      routing: { context, canBuild: true, repositories: ['org/fe', 'org/be'] }
    });
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
    const input = startProjectBuildBatch.mock.calls[0][0];
    expect(input.content).toContain('Fix the login page losing its session on refresh');
    expect(input.content).toContain('The login page breaks when I refresh');
    // Every codebase stays in scope: the model's "org/fe" is told to the planner as a hint, not a limit.
    expect(input.repositories).toEqual([]);
    expect(input.content).toContain('The Orchestrator expects this to touch: org/fe');
    expect(result.agentMessage.messageType).toBe('build');
    expect(result.agentMessage.orchestrationRunId).toBe('orchestration-1');
    // "Try again" replans this goal, never the user's bare words.
    expect(result.agentMessage.routeProposal).toMatchObject({ goal: 'Fix the login page losing its session on refresh', repositories: [], limitedByPerson: false, status: 'accepted' });
  });

  /** Project A's chat: "do the remaining tasks" was planned with only the backend, again and again. */
  describe('every codebase in a project is in scope', () => {
    async function projectWithTwoRepos() {
      const loaded = await load();
      loaded.sqlite.createProject({ id: 'project-1', name: 'Task app', key: 'TASK', resources: twoRepos } as any);
      return loaded;
    }

    it('plans with every codebase even when the model names only the backend', async () => {
      const { chatService } = await projectWithTwoRepos();
      cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add backend login with a local database","repositories":["org/be"]}' };
      await send(chatService, 'do the remaining tasks', { projectId: 'project-1' });
      expect(startProjectBuildBatch.mock.calls[0][0].repositories).toEqual([]);
    });

    it('keeps a limit the person set with the picker', async () => {
      const { chatService } = await projectWithTwoRepos();
      cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Restyle the header","repositories":["org/fe"]}' };
      const result = await send(chatService, 'restyle the header', { projectId: 'project-1', routing: { context, canBuild: true, repositories: ['org/fe'] } });
      expect(startProjectBuildBatch.mock.calls[0][0].repositories).toEqual(['org/fe']);
      expect(result.agentMessage.routeProposal).toMatchObject({ repositories: ['org/fe'], limitedByPerson: true });
      expect(systemPrompts[0]).toContain('The person limited builds to: org/fe');
    });

    it('re-plans an older answer with every codebase, not the list it saved', async () => {
      const { chatService, sqlite } = await projectWithTwoRepos();
      sqlite.createChatThread({ id: 'thread-1', title: 'Build', projectId: 'project-1', ownerId: 'user-1' } as any);
      sqlite.saveChatMessage({ id: 'asked', threadId: 'thread-1', senderType: 'agent', senderName: 'Alpha Orchestrator', content: 'Which frontend repository?',
        messageType: 'build_decision', timestamp: new Date().toISOString(),
        decision: { question: 'Which frontend repository should the plan use?', options: [], status: 'open', request: 'Expense tracker with login.',
          repositories: ['org/be'], settled: [] } } as any);
      await chatService.answerDecision({ threadId: 'thread-1', messageId: 'asked', answer: 'we already have a frontend repository for this',
        routing: { context, canBuild: true }, senderName: 'You' });
      expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
      expect(startProjectBuildBatch.mock.calls[0][0].repositories).toEqual([]);
    });
  });

  it('asks for a project instead of failing when no project is selected', async () => {
    const { chatService } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"need_project","goal":"Add CSV export"}\nWhich project is this for?' };
    const result = await send(chatService, 'add csv export');
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessage.messageType).toBe('project_needed');
    expect(result.agentMessage.content).toBe('Which project is this for?');
    expect(result.agentMessage.routeProposal).toMatchObject({ goal: 'Add CSV export', status: 'open' });
  });

  it('turns a build decision into a project question when the thread has no project', async () => {
    const { chatService } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add CSV export"}' };
    const result = await send(chatService, 'add csv export');
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessage.messageType).toBe('project_needed');
  });

  it('saves an unclear request as a proposal, then plans its goal when the user accepts', async () => {
    const { chatService, sqlite } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"confirm_build","goal":"Redesign the dashboard summary cards"}\nShould I plan a redesign of the summary cards?' };
    const first = await send(chatService, 'make the dashboard better', { projectId: 'project-1' });
    expect(first.agentMessage.messageType).toBe('build_proposal');
    expect(startProjectBuildBatch).not.toHaveBeenCalled();

    const accepted = await chatService.routeMessage({
      threadId: 'thread-1', messageId: first.userMessage.id, action: 'build', userId: 'user-1',
      routing: { context, canBuild: true }
    });
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
    expect(startProjectBuildBatch.mock.calls[0][0].content).toContain('Redesign the dashboard summary cards');
    expect(accepted.agentMessage.messageType).toBe('build');
    const proposal = sqlite.getChatMessages('thread-1').find((message: any) => message.messageType === 'build_proposal');
    expect(proposal?.routeProposal?.status).toBe('accepted');

    // A second click is the same build, not another one.
    await chatService.routeMessage({
      threadId: 'thread-1', messageId: first.userMessage.id, action: 'build', userId: 'user-1',
      routing: { context, canBuild: true }
    });
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
  });

  describe('a task handed over from the board ("Work on this in chat")', () => {
    const handedOff = { context, canBuild: true, issueId: 'issue-eco-101' };

    it('answers a question about the task without starting a build', async () => {
      const { chatService } = await load();
      cliReply = { content: 'ECO-101 has not been built yet; it is still in Todo.' };
      const result = await send(chatService, 'what is the update on this', { projectId: 'project-1', routing: handedOff });
      expect(startProjectBuildBatch).not.toHaveBeenCalled();
      expect(result.agentMessage.content).toBe('ECO-101 has not been built yet; it is still in Todo.');
    });

    it('builds that task in place when Alpha decides to build', async () => {
      const { chatService } = await load();
      cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Build the ECO-101 landing page"}' };
      await send(chatService, 'go ahead and build it', { projectId: 'project-1', routing: handedOff });
      expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
      expect(startProjectBuildBatch.mock.calls[0][0].issueId).toBe('issue-eco-101');
    });

    it('builds that task, not a new one, when the user accepts Alpha\'s offer', async () => {
      const { chatService } = await load();
      cliReply = { content: 'ALPHA_ROUTE {"route":"confirm_build","goal":"Build the ECO-101 landing page"}\nShould I plan this?' };
      const first = await send(chatService, 'can you do this one', { projectId: 'project-1', routing: handedOff });
      expect(first.agentMessage.routeProposal).toMatchObject({ issueId: 'issue-eco-101', status: 'open' });
      await chatService.routeMessage({
        threadId: 'thread-1', messageId: first.userMessage.id, action: 'build', userId: 'user-1',
        routing: { context, canBuild: true }
      });
      expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
      expect(startProjectBuildBatch.mock.calls[0][0].issueId).toBe('issue-eco-101');
    });
  });

  it('never builds for a user whose role cannot, and hides the decision line', async () => {
    const { chatService } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add search"}' };
    const result = await send(chatService, 'add search', { projectId: 'project-1', routing: { context, canBuild: false } });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessage.content).not.toContain('ALPHA_ROUTE');
    expect(result.agentMessage.content).toMatch(/cannot start builds/);
  });

  it('never builds for /ask, even if Alpha writes a decision line', async () => {
    const { chatService } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add search"}' };
    const result = await send(chatService, '/ask add search?', { projectId: 'project-1', routing: { context, canBuild: true, answerOnly: true } });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(systemPrompts[0]).toMatch(/answer only/);
    expect(result.agentMessage.content).not.toContain('ALPHA_ROUTE');
  });

  it('reports an unreadable response without claiming an action was dispatched', async () => {
    const { chatService } = await load();
    cliReply = { content: 'ALPHA_ROUTE {broken' };
    const result = await send(chatService, 'add search', { projectId: 'project-1' });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    // Nothing acts, and no decision line leaks into the reply.
    expect(result.agentMessage.content).toMatch(/did nothing/);
    expect(result.agentMessage.content).not.toContain('ALPHA_ROUTE');
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });

  it('does not guess a build from wording when Alpha cannot reach its runtime', async () => {
    const { chatService } = await load();
    cliReply = { content: '', failureKind: 'spawn' };
    const result = await send(chatService, 'add a dark mode toggle', { projectId: 'project-1' });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessage.content).toMatch(/could not reach/);
  });

  it('keeps the runtime error for a question when Alpha cannot reach its runtime', async () => {
    const { chatService } = await load();
    cliReply = { content: '', failureKind: 'spawn' };
    const result = await send(chatService, 'how does login work?', { projectId: 'project-1' });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessage.content).toMatch(/could not reach/);
  });

  it('gives a runtime without session resume the earlier messages, so "go ahead" has meaning', async () => {
    const { chatService, sqlite } = await load();
    sqlite.saveRuntimes([
      { id: 'claude', name: 'Claude Code CLI', provider: 'Anthropic', status: 'offline', type: 'cloud', latencyMs: 1, models: [], isDefault: false },
      { id: 'codex', name: 'OpenAI Codex CLI', provider: 'OpenAI', status: 'online', type: 'cloud', latencyMs: 1, models: ['gpt-6-astra'], isDefault: true }
    ] as any);
    cliReply = { content: 'Do you want me to plan search for the expenses list?' };
    await send(chatService, 'can we search expenses?', { projectId: 'project-1' });
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add search to the expenses list"}' };
    await send(chatService, 'yes, go ahead', { projectId: 'project-1' });
    expect(systemPrompts[1]).toContain('Recent conversation');
    expect(systemPrompts[1]).toContain('can we search expenses?');
    expect(systemPrompts[1]).not.toContain('yes, go ahead');
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
  });

  it('withdraws an unstarted plan and answers instead', async () => {
    const { chatService, sqlite } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add search"}' };
    const first = await send(chatService, 'add search', { projectId: 'project-1' });
    (sqlite as any).getOrchestrationSnapshot = () => ({ run: { status: 'awaiting_plan_approval' } });
    cliReply = { content: 'Search would need an index on the title column.' };
    const answered = await chatService.routeMessage({
      threadId: 'thread-1', messageId: first.userMessage.id, action: 'answer', userId: 'user-1',
      routing: { context, canBuild: true }
    });
    expect(cancelRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'orchestration-1' }));
    expect(answered.agentMessage.content).toBe('Search would need an index on the title column.');
  });

  it('never turns an answer into a build plan afterwards', async () => {
    const { chatService } = await load();
    cliReply = { content: 'The board has 10 cards: 6 in Todo and 4 in progress.' };
    const first = await send(chatService, 'check the kanban', { projectId: 'project-1' });
    await expect(chatService.routeMessage({
      threadId: 'thread-1', messageId: first.userMessage.id, action: 'build', userId: 'user-1',
      routing: { context, canBuild: true }
    })).rejects.toMatchObject({ status: 409 });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });

  it('refuses to turn a build that specialists already started back into a question', async () => {
    const { chatService, sqlite } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add search"}' };
    const first = await send(chatService, 'add search', { projectId: 'project-1' });
    (sqlite as any).getOrchestrationSnapshot = () => ({ run: { status: 'executing' } });
    await expect(chatService.routeMessage({
      threadId: 'thread-1', messageId: first.userMessage.id, action: 'answer', userId: 'user-1',
      routing: { context, canBuild: true }
    })).rejects.toMatchObject({ status: 409 });
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it('plans a stopped build\'s own goal again when the user just says continue', async () => {
    const { chatService, sqlite } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Create a redesigned Money Tracker UI with clear navigation"}' };
    await send(chatService, 'redesign the ui', { projectId: 'project-1' });
    (sqlite as any).getOrchestrationSnapshot = () => ({
      run: { status: 'cancelled', plan: { goal: 'Create a redesigned Money Tracker UI with clear navigation' } }
    });
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Continue the redesign from the saved MON-1 plan and preserved work"}' };
    const result = await send(chatService, 'continue', { projectId: 'project-1' });
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(2);
    const input = startProjectBuildBatch.mock.calls[1][0];
    expect(input.content).toContain('Create a redesigned Money Tracker UI with clear navigation');
    expect(input.content).not.toContain('MON-1');
    expect(result.agentMessage.content).toContain('planned its request again from the start');
  });

  it('keeps Alpha\'s goal for continue while the earlier build is still open', async () => {
    const { chatService, sqlite } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add search"}' };
    await send(chatService, 'add search', { projectId: 'project-1' });
    (sqlite as any).getOrchestrationSnapshot = () => ({ run: { status: 'blocked', plan: { goal: 'Add search' } } });
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add search to the header"}' };
    await send(chatService, 'continue', { projectId: 'project-1' });
    expect(startProjectBuildBatch.mock.calls[1][0].content).toContain('Add search to the header');
  });
});



/**
 * A build waiting on the person no longer captures their messages behind a narrow gate.
 * The Orchestrator's own turn reads the message with the build's state and chooses an
 * action; each action checks role, revision, status, and (for anything that changes code
 * or reaches GitHub) that the person's whole message asked for it.
 */
describe('the Orchestrator decides about a build waiting in the chat', () => {
  async function decisionFixture() {
    const loaded = await specialistFixture();
    loaded.sqlite.createChatThread({ id: 'thread-1', title: 'Build', projectId: 'project-1', ownerId: 'user-1' } as any);
    const { workspaceRegistry } = await import('./workspaceRegistry.js');
    vi.spyOn(workspaceRegistry, 'canAccessProjectBuilds').mockReturnValue(true);
    const plan = { schemaVersion: 1, goal: 'Build the expense app with localStorage.', requirements: [], tasks: [] };
    const snapshot = { run: { id: 'run-1', projectId: 'project-1', workspaceId: 'ws-default', originChatThreadId: 'thread-1', revision: 3, planVersion: 2,
      status: 'awaiting_plan_approval', plan, repositoryWorkspaces: [{ repository: 'acme/fe' }, { repository: 'acme/be' }] },
      tasks: [{ title: 'Build the expense UI', kind: 'frontend', repository: 'acme/fe' }], attempts: [], findings: [] } as any;
    const { SQLiteService } = await import('./sqliteService.js');
    vi.spyOn(SQLiteService.prototype, 'getOrchestrationSnapshot').mockReturnValue(snapshot);
    vi.spyOn(SQLiteService.prototype, 'listChatPendingDecisions').mockImplementation(() =>
      ['awaiting_plan_approval', 'awaiting_approval', 'publishing'].includes(snapshot.run.status) ? [snapshot] : []);
    vi.spyOn(SQLiteService.prototype, 'getLatestOrchestrationSnapshot').mockReturnValue(snapshot);
    vi.spyOn(SQLiteService.prototype, 'getOrchestrationPlans').mockReturnValue([{ version: 2, plan: {} as any }]);
    startPlannedWork.mockResolvedValue({ ...snapshot, run: { ...snapshot.run, status: 'executing' } });
    approveAndPublish.mockResolvedValue({ ...snapshot, run: { ...snapshot.run, status: 'completed' } });
    cancelRun.mockImplementation(async () => ({ ...snapshot, run: { ...snapshot.run, status: 'cancelled' } }));
    return { ...loaded, snapshot, plan, decision: { runId: 'run-1', expectedRevision: 3, planVersion: 2, evidenceReady: true } };
  }
  const route = (decision: Record<string, unknown>) => ({ content: `ALPHA_ROUTE ${JSON.stringify(decision)}` });
  // Revising a plan and sending work back need chat.write, which developers hold (as on the HTTP routes).
  const developer = { routing: { context: { ...context, role: 'dev' }, canBuild: true } };

  it('tells the Orchestrator what is waiting and which actions it may take', async () => {
    const { chatService } = await decisionFixture();
    cliReply = { content: 'The plan builds the expense UI in acme/fe; the backend needs no change.' };
    const result = await send(chatService, 'why is it not selected but project-a-be is shown here', { projectId: 'project-1' });
    expect(result.agentMessage.content).toContain('backend needs no change');
    expect(systemPrompts[0]).toContain('Build waiting on you');
    expect(systemPrompts[0]).toContain('"status":"awaiting_plan_approval"');
    expect(systemPrompts[0]).toContain('"allowedRoutes":["start_plan","revise_plan","replace_plan","cancel_plan"]');
    expect(startPlannedWork).not.toHaveBeenCalled(); expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });

  it.each(['yes', 'yes, do it', 'okay start now', 'I approve this plan', 'go ahed with the plan'])('starts the plan when the whole message asks for it: %s', async content => {
    const { chatService, decision } = await decisionFixture();
    cliReply = route({ route: 'start_plan', evidence: content });
    const result = await send(chatService, content, { projectId: 'project-1', buildDecision: decision });
    expect(startPlannedWork).toHaveBeenCalledTimes(1);
    expect(result.agentMessage.content).toContain('Started plan v2');
    expect(approveAndPublish).not.toHaveBeenCalled();
  });

  it('starts nothing when the isolated check disagrees with the main turn', async () => {
    const { chatService, decision } = await decisionFixture();
    consentAnswer = false;
    cliReply = route({ route: 'start_plan', evidence: 'summarize the README' });
    const result = await send(chatService, 'summarize the README', { projectId: 'project-1', buildDecision: decision });
    expect(startPlannedWork).not.toHaveBeenCalled();
    expect(result.agentMessage.content).toContain('The plan is ready');
    // The second look had no tools, repository, attachments or history.
    const check = turnInputs.find(input => input.responseSchema?.properties?.consent);
    expect(check).toMatchObject({ toolFree: true, mcpServers: [], projectRoots: [], skills: [], priorSession: null });
    expect(JSON.parse(check.prompt)).toEqual({ message: 'summarize the README', action: expect.any(String), buildStatus: 'awaiting_plan_approval' });
  });

  it('never acts on an approving fragment lifted out of the message', async () => {
    const { chatService, decision } = await decisionFixture();
    cliReply = route({ route: 'start_plan', evidence: 'start' });
    const result = await send(chatService, 'do not start', { projectId: 'project-1', buildDecision: decision });
    expect(startPlannedWork).not.toHaveBeenCalled();
    // It asks, specifically, instead of repeating a canned refusal.
    expect(result.agentMessage.content).toContain('The plan is ready');
  });

  it.each(['Do not start', 'Should I approve?', 'start if the tests pass', "don't start yet"])('answers instead of acting when the Orchestrator reads no request: %s', async content => {
    const { chatService, decision } = await decisionFixture();
    cliReply = { content: 'Understood. The plan stays as it is until you tell me to start it.' };
    const result = await send(chatService, content, { projectId: 'project-1', buildDecision: decision });
    expect(result.agentMessage.content).toContain('stays as it is');
    expect(startPlannedWork).not.toHaveBeenCalled(); expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });

  it('acts once on a retried message, and a later retry returns the saved outcome', async () => {
    const { chatService, sqlite, decision } = await decisionFixture();
    cliReply = route({ route: 'start_plan', evidence: 'start the plan' });
    const options = { projectId: 'project-1', buildDecision: decision, clientMessageId: 'approval-message' };
    const [first, retry] = await Promise.all([send(chatService, 'start the plan', options), send(chatService, 'start the plan', options)]);
    expect(retry.agentMessage.id).toBe(first.agentMessage.id);
    expect(startPlannedWork).toHaveBeenCalledTimes(1);
    const later = await send(chatService, 'start the plan', options);
    expect(later.agentMessage.id).toBe(first.agentMessage.id);
    expect(startPlannedWork).toHaveBeenCalledTimes(1);
    expect(sqlite.getChatMessages('thread-1').filter((message: any) => message.content.includes('Starting now.'))).toHaveLength(1);
  });

  it('revises the plan in place for the same work organised differently', async () => {
    const { chatService, snapshot } = await decisionFixture();
    reviseBoardPlan.mockResolvedValue({ ...snapshot, run: { ...snapshot.run, planVersion: 3 } });
    cliReply = route({ route: 'revise_plan', instruction: 'Split the UI task into form and list.' });
    const result = await send(chatService, 'split the ui task into the form and the list', { projectId: 'project-1', ...developer });
    expect(reviseBoardPlan).toHaveBeenCalledWith(expect.objectContaining({ role: 'dev' }), 'run-1', 3, 'Split the UI task into form and list.');
    expect(result.agentMessage.content).toContain('plan v3');
    expect(startPlannedWork).not.toHaveBeenCalled();
  });

  it('replaces the plan for extra work, keeping the old one restorable', async () => {
    const { chatService } = await decisionFixture();
    const goal = 'Build the expense app with localStorage, plus a local database and login credentials in the backend.';
    cliReply = route({ route: 'replace_plan', goal });
    const result = await send(chatService, 'I want you to create a backend task for this, a local database and a login credential', { projectId: 'project-1' });
    const { SET_ASIDE_REASON } = await import('./chatActions.js');
    expect(cancelRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', expectedRevision: 3, reason: SET_ASIDE_REASON }));
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
    expect(startProjectBuildBatch.mock.calls[0][0].content).toContain('local database and login credentials');
    expect(result.agentMessage.content).toContain('set aside plan v2');
  });

  it('restores a set-aside plan exactly as it was', async () => {
    const { chatService, sqlite, snapshot, plan } = await decisionFixture();
    const { SET_ASIDE_REASON } = await import('./chatActions.js');
    sqlite.saveChatMessage({ id: 'build-msg', threadId: 'thread-1', senderType: 'agent', senderName: 'Alpha', content: 'Plan ready',
      messageType: 'build', orchestrationRunId: 'run-1', timestamp: new Date().toISOString() } as any);
    snapshot.run.status = 'cancelled'; snapshot.run.stoppedReason = SET_ASIDE_REASON;
    cliReply = route({ route: 'restore_plan' });
    const result = await send(chatService, 'bring the previous plan back', { projectId: 'project-1' });
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
    expect(startProjectBuildBatch.mock.calls[0][0]).toMatchObject({ presetPlan: plan, repositories: ['acme/fe', 'acme/be'] });
    expect(result.agentMessage.content).toContain('restored the plan you set aside');
  });

  it('publishes at final review only on the whole message, and reports a blocked result honestly', async () => {
    const { chatService, snapshot, decision } = await decisionFixture();
    snapshot.run.status = 'awaiting_approval';
    approveAndPublish.mockResolvedValue({ ...snapshot, run: { ...snapshot.run, status: 'blocked' } });
    const content = 'Please send the reviewed changes to GitHub and create the PR.';
    cliReply = route({ route: 'publish', evidence: content });
    const result = await send(chatService, content, { projectId: 'project-1', buildDecision: decision });
    expect(approveAndPublish).toHaveBeenCalledTimes(1);
    expect(result.agentMessage.content).toContain('blocked'); expect(result.agentMessage.content).not.toContain('in progress');
    expect(startPlannedWork).not.toHaveBeenCalled();
  });

  it('sends finished work back with the requested change', async () => {
    const { chatService, snapshot } = await decisionFixture();
    snapshot.run.status = 'awaiting_approval';
    requestReviewChanges.mockResolvedValue({ ...snapshot, run: { ...snapshot.run, status: 'executing' } });
    const content = 'make the header sticky before you publish';
    cliReply = route({ route: 'request_changes', evidence: content, instruction: 'Make the header sticky.' });
    const result = await send(chatService, content, { projectId: 'project-1', ...developer });
    expect(requestReviewChanges).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', expectedRunRevision: 3, feedback: 'Make the header sticky.' }));
    expect(result.agentMessage.content).toContain('sent the work back');
    expect(approveAndPublish).not.toHaveBeenCalled();
  });

  it('says what is possible when the build is not in the state the action needs', async () => {
    const { chatService, snapshot } = await decisionFixture();
    snapshot.run.status = 'awaiting_approval';
    cliReply = route({ route: 'start_plan', evidence: 'start it' });
    const result = await send(chatService, 'start it', { projectId: 'project-1' });
    expect(result.agentMessage.content).toContain('no plan waiting');
    expect(startPlannedWork).not.toHaveBeenCalled();
  });

  it('asks which build when more than one is waiting', async () => {
    const { chatService, snapshot, decision } = await decisionFixture();
    const { SQLiteService } = await import('./sqliteService.js');
    vi.spyOn(SQLiteService.prototype, 'listChatPendingDecisions').mockReturnValue([snapshot, { ...snapshot, run: { ...snapshot.run, id: 'run-2' } }]);
    cliReply = route({ route: 'start_plan', evidence: 'start the plan' });
    const result = await send(chatService, 'start the plan', { projectId: 'project-1', buildDecision: decision });
    expect(result.agentMessage.content).toContain('More than one'); expect(startPlannedWork).not.toHaveBeenCalled();
  });

  it('refuses a stale or still-loading review with a reason, and starts nothing', async () => {
    const { chatService, decision } = await decisionFixture();
    cliReply = route({ route: 'start_plan', evidence: 'start the plan' });
    const stale = await send(chatService, 'start the plan', { projectId: 'project-1', buildDecision: { ...decision, expectedRevision: 1 } });
    expect(stale.agentMessage.content).toContain('changed');
    const unloaded = await send(chatService, 'start the plan', { projectId: 'project-1', buildDecision: { ...decision, evidenceReady: false } });
    expect(unloaded.agentMessage.content).toContain('still loading');
    expect(startPlannedWork).not.toHaveBeenCalled(); expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });

  it('rejects an action after permission is revoked', async () => {
    const { chatService, decision } = await decisionFixture();
    const { workspaceRegistry } = await import('./workspaceRegistry.js');
    vi.spyOn(workspaceRegistry, 'can').mockReturnValue(false);
    cliReply = route({ route: 'start_plan', evidence: 'yes' });
    const result = await send(chatService, 'yes', { projectId: 'project-1', buildDecision: decision });
    expect(result.agentMessage.content).toContain('role'); expect(startPlannedWork).not.toHaveBeenCalled();
  });

  it('takes no action when the runtime is down, and says so', async () => {
    const { chatService, decision } = await decisionFixture();
    cliReply = { content: '', failureKind: 'spawn' };
    const result = await send(chatService, 'yes', { projectId: 'project-1', buildDecision: decision });
    expect(result.agentMessage.content).toMatch(/could not reach/);
    expect(startPlannedWork).not.toHaveBeenCalled(); expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });

  it('offers, then sets aside, a plan from another conversation that blocks this request', async () => {
    const { chatService, sqlite, snapshot } = await decisionFixture();
    sqlite.createChatThread({ id: 'thread-other', title: 'can you see this project', projectId: 'project-1', ownerId: 'user-1' } as any);
    snapshot.run.originChatThreadId = 'thread-other'; snapshot.run.createdBy = 'user-1';
    const { SQLiteService } = await import('./sqliteService.js');
    vi.spyOn(SQLiteService.prototype, 'listChatPendingDecisions').mockReturnValue([]);
    startProjectBuildBatch.mockResolvedValueOnce([{ status: 'blocked', projectId: 'project-1', reason: 'Waiting for the existing awaiting plan approval build using acme/be.',
      blockingBuild: { runId: 'run-1', projectId: 'project-1', status: 'awaiting_plan_approval', repository: 'acme/be' } }]);
    cliReply = route({ route: 'build', goal: 'Add backend login with a local database.' });
    const blocked = await send(chatService, 'add a backend login with a local database', { projectId: 'project-1' });
    expect(blocked.agentMessage.content).toContain('waiting for your approval in "can you see this project"');
    expect(blocked.agentMessage.content).toContain('set it aside and plan this request');

    cliReply = route({ route: 'set_aside_blocking_plan' });
    const result = await send(chatService, 'yes, set that plan aside and plan this', { projectId: 'project-1' });
    expect(systemPrompts.at(-2)).toContain('"blockedBy"');
    expect(cancelRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(2);
    expect(startProjectBuildBatch.mock.calls[1][0].content).toContain('Add backend login with a local database.');
    expect(result.agentMessage.content).toContain('set aside plan v2 from your conversation "can you see this project"');
  });

  it('keeps a teammate\'s blocking plan and conversation private', async () => {
    const { chatService, sqlite, snapshot } = await decisionFixture();
    sqlite.createChatThread({ id: 'thread-other', title: 'teammate private chat', projectId: 'project-1', ownerId: 'user-2' } as any);
    snapshot.run.originChatThreadId = 'thread-other'; snapshot.run.createdBy = 'user-2';
    const { SQLiteService } = await import('./sqliteService.js');
    vi.spyOn(SQLiteService.prototype, 'listChatPendingDecisions').mockReturnValue([]);
    startProjectBuildBatch.mockResolvedValueOnce([{ status: 'blocked', projectId: 'project-1', reason: 'Waiting for the existing awaiting plan approval build using acme/be.',
      blockingBuild: { runId: 'run-1', projectId: 'project-1', status: 'awaiting_plan_approval', repository: 'acme/be' } }]);
    cliReply = route({ route: 'build', goal: 'Add backend login.' });
    const blocked = await send(chatService, 'add a backend login', { projectId: 'project-1' });
    expect(blocked.agentMessage.content).not.toContain('teammate private chat');
    cliReply = { content: 'It is waiting on another build.' };
    await send(chatService, 'what is blocking it?', { projectId: 'project-1' });
    expect(systemPrompts.at(-1)).not.toContain('teammate private chat');
    expect(systemPrompts.at(-1)).not.toContain('"blockedBy"');
  });

  it('merges into dev only on the whole message', async () => {
    const { chatService, snapshot } = await decisionFixture();
    snapshot.run.status = 'completed'; snapshot.run.publications = [{ pullRequestUrl: 'https://github.com/acme/fe/pull/1' }];
    const merge = vi.fn(async () => 'Merged acme/fe pull request #1 into dev.');
    vi.doMock('./orchestrationChatMerge.js', () => ({ mergeFromChat: merge, defaultChatMergeDeps: async () => ({}) }));
    cliReply = route({ route: 'merge_dev', evidence: 'merge' });
    const refused = await send(chatService, 'merge it please', { projectId: 'project-1' });
    expect(merge).not.toHaveBeenCalled(); expect(refused.agentMessage.content).toContain('Tell me to merge');
    cliReply = route({ route: 'merge_dev', evidence: 'merge it please' });
    const merged = await send(chatService, 'merge it please', { projectId: 'project-1' });
    expect(merge).toHaveBeenCalledTimes(1); expect(merged.agentMessage.content).toContain('Merged acme/fe');
  });
});

describe('The Manager Agent keeps the board for a developer', () => {
  const developer = { ...context, userId: 'lloyd', role: 'dev' };
  async function askFixture() {
    const loaded = await specialistFixture();
    const { workspaceRegistry } = await import('./workspaceRegistry.js');
    vi.spyOn(workspaceRegistry, 'canAccessProjectBuilds').mockReturnValue(true);
    loaded.sqlite.ensureOfficialAgents('ws-default');
    const manager = loaded.sqlite.getAgents().find((agent: any) => agent.templateKey === 'manager') as any;
    loaded.sqlite.updateAgent(manager.id, { modelProvider: 'Anthropic', modelName: 'claude-sonnet-5' });
    const issue = loaded.sqlite.createIssue({ id: 'issue-101', title: 'Create a polished landing page', projectId: 'project-1', status: 'todo', priority: 'medium' } as any);
    // A build started from the old project chat: matched by task, never by the Ask thread.
    // Assigned through the service proxy, which forwards writes to the open instance.
    (loaded.sqlite as any).listLatestIssueBuilds = vi.fn(() => [
      { issueId: issue.id, projectId: 'project-1', runId: 'run-101', status: 'cancelled', updatedAt: '2026-11-01T10:36:16.419Z' }
    ]);
    (loaded.sqlite as any).getOrchestrationSnapshot = vi.fn(() => ({
      run: { plan: { goal: 'Create a polished landing page' }, status: 'cancelled', stoppedReason: 'Build cancelled by an authorized project member.',
        updatedAt: '2026-11-01T10:36:16.419Z', originChatThreadId: 'th-old-project-chat' },
      tasks: [], attempts: [], findings: []
    }));
    const { projectAskThreadId } = await import('./boardThreads.js');
    const threadId = projectAskThreadId('ws-default', 'lloyd', 'project-1');
    const ask = (content: string, over: Record<string, unknown> = {}) => send(loaded.chatService, content, {
      threadId, projectId: 'project-1', routing: { context: developer, canBuild: true, answerOnly: true, scopeIssueIds: [issue.id] }, ...over
    });
    return { ...loaded, manager, issue, ask, workspaceRegistry };
  }

  it('answers the board panel as the Manager Agent, with the board tools acting as the developer', async () => {
    const { ask, manager, issue } = await askFixture();
    cliReply = { content: 'The build for this task was cancelled on Nov 1.' };
    const result = await ask('What is the update on this?');
    expect(turnInputs).toHaveLength(1);
    expect(turnInputs[0]).toMatchObject({ provider: 'Anthropic', modelName: 'claude-sonnet-5', mcpServers: ['alpha-project-files', 'alpha-github', 'alpha-board'] });
    expect(turnInputs[0].boardScope).toMatchObject({ access: 'write', actorLogin: 'lloyd', projectId: 'project-1', agentId: manager.id });
    expect(turnInputs[0].systemPrompt).toContain('You are the Manager Agent');
    expect(turnInputs[0].systemPrompt).toContain('You keep this project\'s board for the developer');
    expect(turnInputs[0].systemPrompt).not.toContain('## You are Alpha');
    expect(turnInputs[0].prompt).toContain(issue.identifier);
    expect(turnInputs[0].prompt).toContain('Status: cancelled');
    expect(turnInputs[0].prompt).toContain('Build cancelled by an authorized project member.');
    expect(result.agentMessage).toMatchObject({ agentId: manager.id, senderName: manager.name });
  });

  it('summarizes the most recently updated tasks when none are selected', async () => {
    const { ask, issue } = await askFixture();
    cliReply = { content: 'One task, cancelled.' };
    await ask('How is the board?', { routing: { context: developer, canBuild: true, answerOnly: true } });
    expect(turnInputs[0].prompt).toContain('most recently updated tasks');
    expect(turnInputs[0].prompt).toContain(issue.identifier);
  });

  it('never starts a build, even if the Manager writes a decision line', async () => {
    const { ask } = await askFixture();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add search"}' };
    const result = await ask('add search');
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessage.content).not.toContain('ALPHA_ROUTE');
  });

  it('reports the usage limit instead of answering from another runtime', async () => {
    const { ask, sqlite } = await askFixture();
    sqlite.saveRuntimes([
      { id: 'claude', name: 'Claude Code CLI', provider: 'Anthropic', status: 'online', type: 'cloud', latencyMs: 1, models: ['claude-sonnet-5'], isDefault: true },
      { id: 'codex', name: 'OpenAI Codex CLI', provider: 'OpenAI', status: 'online', type: 'cloud', latencyMs: 1, models: ['gpt-6-luna'], isDefault: false }
    ] as any);
    cliReply = { content: '', failureKind: 'limit' };
    const result = await ask('status?');
    expect(turnInputs).toHaveLength(1);
    expect(result.agentMessage.content).toMatch(/usage limit/);
  });

  it('refuses without a model call when the developer cannot run the Manager', async () => {
    const { ask, access } = await askFixture();
    access.mockResolvedValue(false);
    const result = await ask('status?');
    expect(turnInputs).toHaveLength(0);
    expect(result.agentMessage).toMatchObject({ senderType: 'system' });
    expect(result.agentMessage.content).toMatch(/do not have access to run the Manager Agent/);
  });

  it('is not for a client: refused before any agent or model call', async () => {
    const { ask, issue } = await askFixture();
    await expect(ask('Move this to Todo', { routing: { context: { ...context, role: 'client' }, canBuild: true, answerOnly: true, scopeIssueIds: [issue.id] } }))
      .rejects.toThrow(/internal project team/);
    expect(turnInputs).toHaveLength(0);
  });

  it('answers without board tools, and says why, when the assistant is turned off', async () => {
    const { ask, sqlite } = await askFixture();
    sqlite.setBoardAssistantEnabled('ws-default', 'project-1', false, 'admin');
    cliReply = { content: 'I cannot change the board right now.' };
    await ask('Archive the old cards');
    expect(turnInputs[0].mcpServers).toEqual(['alpha-project-files', 'alpha-github']);
    expect(turnInputs[0].boardScope).toBeUndefined();
    expect(turnInputs[0].systemPrompt).toContain('You cannot change the board in this conversation: The board assistant is turned off');
  });

  it('restores an archived Manager, and an update can never archive an official agent', async () => {
    const { ask, manager, sqlite } = await askFixture();
    sqlite.updateAgent(manager.id, { isArchived: true });
    expect(sqlite.getAgents().find((agent: any) => agent.id === manager.id)?.isArchived).toBe(false);

    // Archived by a release before the rule existed.
    (sqlite as any).db.prepare('UPDATE agents SET is_archived = 1 WHERE id = ?').run(manager.id);
    cliReply = { content: 'Answered.' };
    const result = await ask('status?');
    expect(result.agentMessage.agentId).toBe(manager.id);
    expect(sqlite.getAgents().find((agent: any) => agent.id === manager.id)?.isArchived).toBe(false);
  });

  it('hands a board request in a project chat to the Manager Agent', async () => {
    const { chatService, manager, workspaceRegistry } = await askFixture();
    vi.spyOn(workspaceRegistry, 'canAccessProjectBuilds').mockReturnValue(true);
    cliReplies = [
      'ALPHA_ROUTE ' + JSON.stringify({ route: 'board', goal: 'Move TASK-1 to Todo', repositories: [], assignments: [] }),
      'Moved TASK-1 to Todo.'
    ];
    const result = await send(chatService, 'put the landing page card in todo', { projectId: 'project-1', routing: { context: developer, canBuild: true } });
    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[0].systemPrompt).toContain('route":"board"');
    // Board questions go to the Manager too, never answered from what the chat said earlier.
    expect(turnInputs[0].systemPrompt).toContain('Always route these to the Manager, even when earlier messages already discussed the board');
    expect(turnInputs[0].systemPrompt).toContain('the Gantt schedule (planned start, planned end and dependencies');
    expect(turnInputs[1].boardScope).toMatchObject({ access: 'write', actorLogin: 'lloyd' });
    expect(turnInputs[1].prompt).toContain('Alpha\'s reading of the board request: Move TASK-1 to Todo');
    expect(result.agentMessages.map((message: any) => message.senderName)).toEqual(['Alpha', manager.name]);
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });

  it('gives other agents in a developer\'s project chat read-only board tools', async () => {
    const { chatService } = await askFixture();
    cliReply = { content: 'The API validates input.' };
    await send(chatService, 'Explain the API', { projectId: 'project-1', targetAgentId: 'backend-specialist', routing: { context: developer, canBuild: true } });
    expect(turnInputs[0].mcpServers).toEqual(['alpha-project-files', 'alpha-github', 'alpha-board']);
    expect(turnInputs[0].boardScope).toMatchObject({ access: 'read' });
    expect(turnInputs[0].systemPrompt).toContain('Only the Manager Agent changes cards');
  });
});

describe('Orchestrator questions before planning', () => {
  const question = 'Keep Project A informational, or add the expense workflow?';

  it('saves the question with its options, then plans the original request with the answer as settled', async () => {
    const { chatService, sqlite } = await load();
    startProjectBuildBatch.mockResolvedValueOnce([{ status: 'blocked', reason: question,
      decision: { question, options: [{ label: 'Add the expense workflow' }, { label: 'Keep it informational' }] } }]);
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Build the remaining expense tasks"}' };
    const first = await send(chatService, 'do all remaining tasks', { projectId: 'project-1' });
    expect(first.agentMessage.messageType).toBe('build_decision');
    expect(first.agentMessage.decision).toMatchObject({ question, status: 'open', request: 'Build the remaining expense tasks', settled: [] });

    const answer = { threadId: 'thread-1', messageId: first.agentMessage.id, answer: 'Add the expense workflow', senderName: 'Lloyd', routing: { context, canBuild: true } };
    const answered = await chatService.answerDecision(answer);
    expect(answered.userMessage.content).toBe('Add the expense workflow');
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(2);
    const replanned = startProjectBuildBatch.mock.calls[1][0];
    expect(replanned.content).toContain('Build the remaining expense tasks');
    expect(replanned.settledDecisions).toEqual([{ question, answer: 'Add the expense workflow' }]);
    expect(sqlite.getChatMessages('thread-1').find((message: any) => message.id === first.agentMessage.id)?.decision)
      .toMatchObject({ status: 'answered', answer: 'Add the expense workflow' });

    // A second click returns the same answer instead of planning again.
    await chatService.answerDecision(answer);
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(2);
  });

  it('retires an open question when the person starts something else', async () => {
    const { chatService, sqlite } = await load();
    startProjectBuildBatch.mockResolvedValueOnce([{ status: 'blocked', reason: question, decision: { question, options: [] } }]);
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Build the remaining expense tasks"}' };
    const first = await send(chatService, 'do all remaining tasks', { projectId: 'project-1' });
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Add a dark mode toggle"}' };
    await send(chatService, 'add dark mode', { projectId: 'project-1' });
    expect(sqlite.getChatMessages('thread-1').find((message: any) => message.id === first.agentMessage.id)?.decision?.status).toBe('superseded');
    await expect(chatService.answerDecision({ threadId: 'thread-1', messageId: first.agentMessage.id, answer: 'Add it', senderName: 'Lloyd', routing: { context, canBuild: true } }))
      .rejects.toThrow('already answered or replaced');
  });

  it('names the build in the way so the chat can offer to stop it', async () => {
    const { chatService } = await load();
    startProjectBuildBatch.mockResolvedValueOnce([{ status: 'blocked', reason: 'Waiting for the existing blocked build using org/app-be.',
      blockingBuild: { runId: 'run-old', status: 'blocked', repository: 'org/app-be' } }]);
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Build the remaining expense tasks"}' };
    const result = await send(chatService, 'do all remaining tasks', { projectId: 'project-1' });
    expect(result.agentMessage.messageType).toBe('build');
    expect(result.agentMessage.buildBlocker).toEqual({ runId: 'run-old', status: 'blocked', repository: 'org/app-be' });
  });
});

