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
const startPlannedWork = vi.fn();
const approveAndPublish = vi.fn();

const context = { workspaceId: 'ws-default', userId: 'user-1', role: 'admin', access: {} } as any;

async function load() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  vi.doMock('./cliRunner.js', () => ({
    providerResumesSessions: (provider: string) => provider !== 'OpenAI',
    runCliTurn: vi.fn(async (input: { systemPrompt?: string; mcpServers?: string[]; responseSchema?: any }) => {
      systemPrompts.push(input.systemPrompt ?? '');
      turnInputs.push(input);
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
  vi.doMock('./orchestrationRuntime.js', () => ({ orchestrationService: { cancelRun, startPlannedWork, approveAndPublish } }));
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
  it('stops the preview directly without calling a model or changing the build, and is idempotent', async () => {
    const { chatService } = await specialistFixture();
    const { localPreviewService } = await import('./localPreviewService.js');
    const stop = vi.spyOn(localPreviewService, 'stopForThread').mockResolvedValue(1);
    const result = await send(chatService, 'now stop the local run', { projectId: 'project-1', clientMessageId: 'stop-preview-message' });
    expect(result.agentMessage.content).toContain('preview has stopped');
    expect(stop).toHaveBeenCalledWith(context, 'thread-1');
    await send(chatService, 'now stop the local run', { projectId: 'project-1', clientMessageId: 'stop-preview-message' });
    expect(stop).toHaveBeenCalledTimes(1); expect(turnInputs).toHaveLength(0);
    expect(startProjectBuildBatch).not.toHaveBeenCalled(); expect(cancelRun).not.toHaveBeenCalled();
  });
  it('reports a preview shutdown failure instead of claiming success', async () => {
    const { chatService } = await specialistFixture();
    const { localPreviewService } = await import('./localPreviewService.js');
    vi.spyOn(localPreviewService, 'stopForThread').mockRejectedValue(new Error('shutdown not confirmed'));
    const result = await send(chatService, 'stop the preview', { projectId: 'project-1' });
    expect(result.agentMessage.content).toContain('could not be stopped: shutdown not confirmed'); expect(turnInputs).toHaveLength(0);
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
      autonomyLevel: 'Supervised', mcpServers: ['alpha-project-files', 'alpha-github'] });
    expect(turnInputs[0].systemPrompt).toContain('approved scoped build flow');
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

  it('reports an unreadable response without claiming an action was dispatched', async () => {
    const { chatService } = await load();
    cliReply = { content: 'ALPHA_ROUTE {broken' };
    const result = await send(chatService, 'add search', { projectId: 'project-1' });
    expect(startProjectBuildBatch).not.toHaveBeenCalled();
    expect(result.agentMessage.content).toContain('No action was dispatched');
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



describe('durable main-chat approvals', () => {
  async function decisionFixture() {
    const loaded = await specialistFixture();
    loaded.sqlite.createChatThread({ id: 'thread-1', title: 'Build', projectId: 'project-1', ownerId: 'user-1' } as any);
    const { workspaceRegistry } = await import('./workspaceRegistry.js');
    vi.spyOn(workspaceRegistry, 'canAccessProjectBuilds').mockReturnValue(true);
    const snapshot = { run: { id: 'run-1', projectId: 'project-1', workspaceId: 'ws-default', originChatThreadId: 'thread-1', revision: 3, planVersion: 2, status: 'awaiting_plan_approval' }, tasks: [] } as any;
    const { SQLiteService } = await import('./sqliteService.js');
    vi.spyOn(SQLiteService.prototype, 'getOrchestrationSnapshot').mockReturnValue(snapshot);
    vi.spyOn(SQLiteService.prototype, 'listChatPendingDecisions').mockImplementation(() =>
      ['awaiting_plan_approval', 'awaiting_approval', 'publishing'].includes(snapshot.run.status) ? [snapshot] : []);
    vi.spyOn(SQLiteService.prototype, 'getOrchestrationPlans').mockReturnValue([{ version: 2, plan: {} as any }]);
    startPlannedWork.mockResolvedValue({ ...snapshot, run: { ...snapshot.run, status: 'executing' } });
    approveAndPublish.mockResolvedValue({ ...snapshot, run: { ...snapshot.run, status: 'completed' } });
    return { ...loaded, snapshot, decision: { action: 'start', runId: 'run-1', expectedRevision: 3, planVersion: 2, evidenceReady: true } };
  }
  it('saves explicit plan consent and its real outcome without calling a model, including concurrent transport retry', async () => {
    const { chatService, sqlite, decision } = await decisionFixture();
    const options = { buildDecision: decision, clientMessageId: 'approval-message' };
    const [first, retry] = await Promise.all([send(chatService, 'start the plan', options), send(chatService, 'start the plan', options)]);
    expect(first.agentMessage.content).toContain('Plan v2 started'); expect(retry.agentMessage.id).toBe(first.agentMessage.id);
    expect(startPlannedWork).toHaveBeenCalledTimes(1); expect(turnInputs).toHaveLength(0);
    expect(sqlite.getChatMessages('thread-1').map(message => message.content)).toEqual(['start the plan', first.agentMessage.content]);
    await send(chatService, 'start the plan', options); expect(startPlannedWork).toHaveBeenCalledTimes(1);
  });
  it('keeps stale and unloaded-review refusals in history and never starts a new build', async () => {
    const { chatService, sqlite, decision } = await decisionFixture();
    const stale = await send(chatService, 'start the plan', { buildDecision: { ...decision, expectedRevision: 1 } });
    expect(stale.agentMessage.content).toContain('changed');
    const unloaded = await send(chatService, 'start the plan', { buildDecision: { ...decision, evidenceReady: false } });
    expect(unloaded.agentMessage.content).toContain('not loaded');
    expect(sqlite.getChatMessages('thread-1')).toHaveLength(4);
    expect(startPlannedWork).not.toHaveBeenCalled(); expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });
  it('requires separate publication words and forwards failures without claiming success', async () => {
    const { chatService, snapshot, decision } = await decisionFixture();
    snapshot.run.status = 'awaiting_approval';
    cliReply = { content: JSON.stringify({ intent: 'clarify', target: 'none', evidence: '' }) };
    const mismatch = await send(chatService, 'continue', { buildDecision: { ...decision, action: 'approve' } });
    expect(mismatch.agentMessage.content).toContain('No publication'); expect(approveAndPublish).not.toHaveBeenCalled();
    approveAndPublish.mockRejectedValueOnce(new Error('Blocking findings must be resolved'));
    const refused = await send(chatService, 'approve publication', { buildDecision: { ...decision, action: 'approve' } });
    expect(refused.agentMessage.content).toContain('Blocking findings');
    expect(refused.agentMessage.content).not.toContain('completed');
  });
  it.each(['yes', 'yes, do it', 'okay start now', 'I approve this plan', 'go ahed with the plan'])('dispatches interpreted plan consent without a frontend action: %s', async content => {
    const { chatService, sqlite, decision } = await decisionFixture();
    cliReply = { content: JSON.stringify({ intent: 'consent', target: 'plan', evidence: content }) };
    const result = await send(chatService, content, { buildDecision: { ...decision, action: undefined } });
    expect(startPlannedWork).toHaveBeenCalledTimes(1);
    expect(result.agentMessage.content).toContain('started');
    expect(sqlite.getChatMessages('thread-1')[0].content).toBe(content);
    expect(turnInputs[0]).toMatchObject({ priorSession: null, skills: [], projectRoots: [], mcpServers: [], timeoutMs: 60000 });
    expect(turnInputs[0].responseSchema.required).toContain('evidence');
    expect(approveAndPublish).not.toHaveBeenCalled();
  });
  it.each(['Do not start', 'Should I approve?', '"start the plan"', 'start if the tests pass', 'start and delete the database'])('does not dispatch when interpretation withholds consent: %s', async content => {
    const { chatService, decision } = await decisionFixture();
    cliReply = { content: JSON.stringify({ intent: 'clarify', target: 'none', evidence: '' }) };
    const result = await send(chatService, content, { buildDecision: { ...decision, action: undefined } });
    expect(result.agentMessage.content).toContain('No build action');
    expect(startPlannedWork).not.toHaveBeenCalled(); expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });
  it('answers a question with action routing disabled while a review is pending', async () => {
    const { chatService, decision } = await decisionFixture();
    cliReplies = [JSON.stringify({ intent: 'none', target: 'none', evidence: '' }), 'The plan adds search to the header.'];
    const result = await send(chatService, 'What will this plan change?', { buildDecision: { ...decision, action: undefined } });
    expect(result.agentMessage.content).toBe('The plan adds search to the header.');
    expect(systemPrompts[1]).toContain('answer only');
    expect(startPlannedWork).not.toHaveBeenCalled(); expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });
  it('rejects a model that quotes only an approving fragment', async () => {
    const { chatService, decision } = await decisionFixture();
    cliReply = { content: JSON.stringify({ intent: 'consent', target: 'plan', evidence: 'start' }) };
    await send(chatService, 'do not start', { buildDecision: { ...decision, action: undefined } });
    expect(startPlannedWork).not.toHaveBeenCalled();
  });
  it.each(['{broken', 'I have started it.', 'ALPHA_ROUTE {"route":"build","goal":"start"}'])('fails closed for a missing structured intent: %s', async content => {
    const { chatService, decision } = await decisionFixture(); cliReply = { content };
    const result = await send(chatService, 'yes, do it', { buildDecision: { ...decision, action: undefined } });
    expect(result.agentMessage.content).toContain('No build action'); expect(startPlannedWork).not.toHaveBeenCalled();
  });
  it('revalidates a revision changed during interpretation', async () => {
    const { chatService, snapshot, decision } = await decisionFixture();
    cliReply = { content: JSON.stringify({ intent: 'consent', target: 'plan', evidence: 'yes' }) };
    const { runCliTurn } = await import('./cliRunner.js');
    vi.mocked(runCliTurn).mockImplementationOnce(async () => { snapshot.run.revision = 4; return { ...cliReply, tools: [] } as any; });
    const result = await send(chatService, 'yes', { buildDecision: { ...decision, action: undefined } });
    expect(result.agentMessage.content).toContain('changed'); expect(startPlannedWork).not.toHaveBeenCalled();
  });
  it('refuses ambiguous multiple pending decisions even for an explicit command', async () => {
    const { chatService, snapshot, decision, sqlite } = await decisionFixture();
    const { SQLiteService } = await import('./sqliteService.js');
    vi.spyOn(SQLiteService.prototype, 'listChatPendingDecisions').mockReturnValue([snapshot, { ...snapshot, run: { ...snapshot.run, id: 'run-2' } }]);
    const result = await send(chatService, 'start the plan', { buildDecision: decision });
    expect(result.agentMessage.content).toContain('More than one'); expect(startPlannedWork).not.toHaveBeenCalled();
  });
  it('does not execute a contextual yes without a displayed revision', async () => {
    const { chatService } = await decisionFixture();
    cliReply = { content: JSON.stringify({ intent: 'consent', target: 'plan', evidence: 'yes' }) };
    const result = await send(chatService, 'yes');
    expect(result.agentMessage.content).toContain('not loaded'); expect(startPlannedWork).not.toHaveBeenCalled();
  });
  it('keeps publication consent separate and dispatches an explicit paraphrase', async () => {
    const { chatService, snapshot, decision } = await decisionFixture(); snapshot.run.status = 'awaiting_approval';
    const content = 'Please send the reviewed changes to GitHub and create the PR.';
    cliReply = { content: JSON.stringify({ intent: 'consent', target: 'publication', evidence: content }) };
    const result = await send(chatService, content, { buildDecision: { ...decision, action: undefined } });
    expect(result.agentMessage.content).toContain('Publication completed'); expect(approveAndPublish).toHaveBeenCalledTimes(1);
    expect(startPlannedWork).not.toHaveBeenCalled();
  });
  it('returns the durable semantic outcome on concurrent and later transport retries', async () => {
    const { chatService, snapshot, decision } = await decisionFixture();
    cliReply = { content: JSON.stringify({ intent: 'consent', target: 'plan', evidence: 'yes' }) };
    const options = { buildDecision: { ...decision, action: undefined }, clientMessageId: 'semantic-approval' };
    await Promise.all([send(chatService, 'yes', options), send(chatService, 'yes', options)]);
    snapshot.run.status = 'executing';
    await send(chatService, 'yes', { clientMessageId: 'semantic-approval' });
    expect(startPlannedWork).toHaveBeenCalledTimes(1); expect(turnInputs).toHaveLength(1);
  });
  it('allows stopping an interpretation before dispatch', async () => {
    const { chatService, decision } = await decisionFixture();
    const { runCliTurn } = await import('./cliRunner.js');
    vi.mocked(runCliTurn).mockImplementationOnce(async () => {
      await chatService.stopTurn('thread-1', 'stop-consent');
      return { content: JSON.stringify({ intent: 'consent', target: 'plan', evidence: 'yes' }), tools: [] } as any;
    });
    const result = await send(chatService, 'yes', { clientMessageId: 'stop-consent', buildDecision: { ...decision, action: undefined } });
    expect(result.agentMessage.content).toContain('stopped'); expect(startPlannedWork).not.toHaveBeenCalled();
  });
  it('rejects semantic consent after permission revocation', async () => {
    const { chatService, decision } = await decisionFixture();
    const { workspaceRegistry } = await import('./workspaceRegistry.js');
    const { runCliTurn } = await import('./cliRunner.js');
    vi.mocked(runCliTurn).mockImplementationOnce(async () => {
      vi.spyOn(workspaceRegistry, 'can').mockReturnValue(false);
      return { content: JSON.stringify({ intent: 'consent', target: 'plan', evidence: 'yes' }), tools: [] } as any;
    });
    const result = await send(chatService, 'yes', { buildDecision: { ...decision, action: undefined } });
    expect(result.agentMessage.content).toContain('role'); expect(startPlannedWork).not.toHaveBeenCalled();
  });
  it('never turns a model plan classification into publication', async () => {
    const { chatService, snapshot, decision } = await decisionFixture(); snapshot.run.status = 'awaiting_approval';
    cliReply = { content: JSON.stringify({ intent: 'consent', target: 'plan', evidence: 'yes' }) };
    await send(chatService, 'yes', { buildDecision: { ...decision, action: undefined } });
    expect(approveAndPublish).not.toHaveBeenCalled(); expect(startPlannedWork).not.toHaveBeenCalled();
  });
  it('fails closed on runtime outage instead of sending the message to ordinary action routing', async () => {
    const { chatService, decision } = await decisionFixture();
    cliReply = { content: '', failureKind: 'spawn' };
    const result = await send(chatService, 'yes', { buildDecision: { ...decision, action: undefined } });
    expect(result.agentMessage.content).toContain('Nothing was authorized'); expect(turnInputs).toHaveLength(1);
    expect(startPlannedWork).not.toHaveBeenCalled(); expect(startProjectBuildBatch).not.toHaveBeenCalled();
  });
  it('reports a blocked publication result without claiming it is in progress', async () => {
    const { chatService, snapshot, decision } = await decisionFixture(); snapshot.run.status = 'awaiting_approval';
    approveAndPublish.mockResolvedValue({ ...snapshot, run: { ...snapshot.run, status: 'blocked' } });
    const result = await send(chatService, 'publish this build', { buildDecision: { ...decision, action: undefined } });
    expect(result.agentMessage.content).toContain('blocked'); expect(result.agentMessage.content).not.toContain('in progress');
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

  it.each(['admin', 'pm'])('is for developers only: a %s gets no agent and no model call', async role => {
    const { ask, issue } = await askFixture();
    const result = await ask('Move this to Todo', { routing: { context: { ...context, role }, canBuild: true, answerOnly: true, scopeIssueIds: [issue.id] } });
    expect(turnInputs).toHaveLength(0);
    expect(result.agentMessage.content).toMatch(/only for developers/);
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
