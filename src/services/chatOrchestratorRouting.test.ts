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
const startProjectBuildBatch = vi.fn();
const cancelRun = vi.fn();

const context = { workspaceId: 'ws-default', userId: 'user-1', role: 'admin', access: {} } as any;

async function load() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  vi.doMock('./cliRunner.js', () => ({
    providerResumesSessions: (provider: string) => provider !== 'OpenAI',
    runCliTurn: vi.fn(async (input: { systemPrompt?: string; mcpServers?: string[] }) => {
      systemPrompts.push(input.systemPrompt ?? '');
      turnInputs.push(input);
      return {
        content: cliReplies.shift() ?? cliReply.content,
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
  vi.doMock('./orchestrationRuntime.js', () => ({ orchestrationService: { cancelRun } }));
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-chat-routing-'));
  opened = [];
  systemPrompts = [];
  turnInputs = [];
  cliReplies = [];
  startProjectBuildBatch.mockReset();
  cancelRun.mockReset();
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
  const assignment = { agentId: 'backend-specialist', kind: 'backend', instruction: 'Inspect the API error handling and report evidence.', reason: 'Server-side expertise.' };
  const route = (assignments = [assignment]) => 'ALPHA_ROUTE ' + JSON.stringify({ route: 'delegate', goal: 'Review the project', assignments });

  it('selects specialists, records their replies, and strips all write grants despite Full access', async () => {
    const { chatService, sqlite } = await specialistFixture();
    cliReply = { content: route([assignment, { ...assignment, agentId: 'frontend-specialist', kind: 'frontend', instruction: 'Inspect UI error states.', reason: 'UI expertise.' }]) };
    cliReplies = [cliReply.content, 'API finding: missing error mapping.', 'UI finding: missing retry state.'];
    const result = await send(chatService, 'Use my agents to review the project', { projectId: 'project-1', approvalMode: 'full', clientMessageId: 'handoff-message' });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessages.map((message: any) => message.senderName)).toEqual(['Alpha', 'backend-specialist', 'frontend-specialist']);
    expect(result.agentMessages[0].content).toContain('Server-side expertise.');
    expect(turnInputs).toHaveLength(3);
    expect(turnInputs[0]).toMatchObject({ mode: 'chat', approvalMode: 'ask', personaChanged: true });
    for (const input of turnInputs.slice(1)) {
      expect(input).toMatchObject({ mode: 'chat', approvalMode: 'ask', priorSession: null, skills: [], autonomyLevel: 'Supervised', mcpServers: ['alpha-project-files', 'alpha-github'] });
      expect(input.systemPrompt).toContain('No edits, shell commands');
    }
    expect(turnInputs[0].systemPrompt).toContain('Expert in Backend Agent');
    expect(sqlite.getChatMessages('thread-1').filter((message: any) => message.agentId === 'backend-specialist')).toHaveLength(1);
    await send(chatService, 'Use my agents to review the project', { projectId: 'project-1', clientMessageId: 'handoff-message' });
    expect(turnInputs).toHaveLength(3);
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
    expect(result.agentMessages.map((message: any) => message.senderName)).toEqual(['Alpha', 'backend-specialist']);
    expect(turnInputs).toHaveLength(2);
  });

  it('rechecks access before dispatching the next specialist', async () => {
    const { chatService, access } = await specialistFixture();
    cliReply = { content: route([assignment, { ...assignment, agentId: 'frontend-specialist', kind: 'frontend' }]) };
    cliReplies = [cliReply.content, 'API findings.'];
    chatService.on('chat_message', (message: any) => {
      if (message.agentId === 'backend-specialist') access.mockResolvedValue(false);
    });
    const result = await send(chatService, 'Review the project', { projectId: 'project-1' });
    expect(turnInputs).toHaveLength(2);
    expect(result.agentMessages.at(-1).content).toContain('changed after the handoff');
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
    expect(turnInputs).toHaveLength(2);
    await send(chatService, '/ask explain the result', { routing: { context, canBuild: true, answerOnly: true } });
    expect(turnInputs).toHaveLength(3);
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
    const { chatService } = await load();
    cliReply = { content: 'ALPHA_ROUTE {"route":"build","goal":"Fix the login page losing its session on refresh","repositories":["org/fe"]}' };
    const result = await send(chatService, 'The login page breaks when I refresh, please look into it', {
      projectId: 'project-1',
      routing: { context, canBuild: true, repositories: ['org/fe', 'org/be'] }
    });
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
    const input = startProjectBuildBatch.mock.calls[0][0];
    expect(input.content).toContain('Fix the login page losing its session on refresh');
    expect(input.content).toContain('The login page breaks when I refresh');
    expect(input.repositories).toEqual(['org/fe']);
    expect(result.agentMessage.messageType).toBe('build');
    expect(result.agentMessage.orchestrationRunId).toBe('orchestration-1');
    // "Try again" replans this goal, never the user's bare words.
    expect(result.agentMessage.routeProposal).toMatchObject({ goal: 'Fix the login page losing its session on refresh', repositories: ['org/fe'], status: 'accepted' });
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

  it('treats an unreadable decision as a question to the user', async () => {
    const { chatService } = await load();
    cliReply = { content: 'ALPHA_ROUTE {broken' };
    const result = await send(chatService, 'add search', { projectId: 'project-1' });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessage.messageType).toBe('build_proposal');
    expect(result.agentMessage.routeProposal.goal).toBe('add search');
  });

  it('falls back to wording when Alpha cannot reach its runtime', async () => {
    const { chatService } = await load();
    cliReply = { content: '', failureKind: 'spawn' };
    const result = await send(chatService, 'add a dark mode toggle', { projectId: 'project-1' });
    expect(startProjectBuildBatch).toHaveBeenCalledTimes(1);
    expect(result.agentMessage.content).toMatch(/routed by its wording/);
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

