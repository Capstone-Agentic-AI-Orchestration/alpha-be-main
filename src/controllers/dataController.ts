import { Request, Response, Router } from 'express';
import { currentIdentity } from '../services/identityService.js';
import { syncBoardFromGitHub } from '../services/githubBoardSync.js';
import { pushIssue, needsPush } from '../services/githubBoardWrite.js';
import { sqliteService } from '../services/sqliteService.js';
import { agentValidationError } from './agentValidation.js';
import { checkWorkspace } from './workspaceValidation.js';
import { AgentBuilderError, sendBuilderMessage } from '../services/agentBuilderService.js';
import {
  AGENT_FILE_MAX_BYTES,
  agentFilePath,
  agentFromFileContent,
  parseAgentFileContent,
  readAgentFile,
  readAgentFileRaw,
  writeAgentFileRaw
} from '../services/agentFileService.js';
import { resolveAgent } from '../services/personaService.js';
import { agentReadiness } from '../services/agentReadiness.js';
import { Agent, Issue, IssueStatus } from '../models/index.js';
import { logError, logInfo } from '../utils/logger.js';
import { SKILL_TOOLS } from '../services/toolPolicy.js';

export const dataRouter = Router();

/**
 * Who Alpha thinks you are.
 *
 * The browser had no way to ask: `currentUser` was picked from a mock array by
 * whichever role the switcher was on. This is the GitHub login the org, the
 * teams and every pull request already use, or the OS username when GitHub is
 * not signed in — `source` says which, so the UI can be honest about it.
 */
dataRouter.get('/me', async (_req: Request, res: Response) => {
  res.json(await currentIdentity());
});

/**
 * Read the shared board down from GitHub.
 *
 * Explicit rather than automatic: a sync spawns `gh` once per project and
 * rewrites cards, and doing that on a timer nobody asked for would make the
 * board move under someone mid-sentence. The UI calls this on demand.
 */
dataRouter.post('/board/sync', async (_req: Request, res: Response) => {
  const report = await syncBoardFromGitHub();
  // 200 even with per-project errors: a workspace where one repository is
  // unreachable still synced the others, and the report says which failed.
  res.json(report);
});

// --- Projects ---
dataRouter.get('/projects', (req: Request, res: Response) => {
  res.json(sqliteService.getProjects());
});

dataRouter.post('/projects', (req: Request, res: Response) => {
  const project = sqliteService.createProject(req.body);
  res.status(201).json(project);
});

/**
 * Check a folder before it becomes a project's working copy.
 *
 * Separate from the update so the panel can tell someone their path is wrong
 * while they are still typing it, rather than at the start of an agent run.
 */
dataRouter.post('/projects/check-workspace', (req: Request, res: Response) => {
  res.json(checkWorkspace(req.body?.path));
});

dataRouter.put('/projects/:id', (req: Request, res: Response) => {
  /**
   * A folder that cannot hold a branch is refused here.
   *
   * `resolveProjectWorkspace` prefers a managed checkout and falls back to an
   * attached folder, so a bad `local_path` only bites once a run reaches the
   * workspace stage — where the failure is caught, logged as a notice, and the
   * run continues without a branch. Rejecting the attachment is the only point
   * at which the person can still see which field was wrong.
   */
  const attached = (req.body?.resources ?? []).find(
    (r: any) => r?.type === 'local_path' || r?.type === 'local_dir'
  );

  if (attached) {
    const check = checkWorkspace(attached.pathOrUrl);
    if (!check.ok) return res.status(400).json({ error: check.detail });
  }

  const updated = sqliteService.updateProject(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Project not found' });
  res.json(updated);
});

dataRouter.delete('/projects/:id', (req: Request, res: Response) => {
  const deleted = sqliteService.deleteProject(req.params.id);
  res.json({ success: deleted });
});

// --- Project Build Room ---
dataRouter.get('/projects/:id/build-steps', (req: Request, res: Response) => {
  try {
    res.json(sqliteService.getProjectBuildSteps(req.params.id));
  } catch (error: any) {
    const message = error?.message ?? 'Could not load project build steps';
    res.status(message === 'Project not found' ? 404 : 400).json({ error: message });
  }
});

dataRouter.put('/projects/:id/build-steps', (req: Request, res: Response) => {
  try {
    if (!Array.isArray(req.body?.steps)) {
      return res.status(400).json({ error: 'steps must be an array' });
    }
    res.json(sqliteService.saveProjectBuildSteps(req.params.id, req.body.steps));
  } catch (error: any) {
    const message = error?.message ?? 'Could not save project build steps';
    res.status(message === 'Project not found' ? 404 : 400).json({ error: message });
  }
});

// --- Agents ---

/**
 * The agent as it will actually behave, plus which fields the file decides.
 *
 * The list previously returned raw database rows while runs resolved the
 * persona file over the top, so a card could read `claude-sonnet-5` for an
 * agent running on something else entirely. Merging here makes the card honest.
 *
 * `managedByFile` is what stops the merge becoming a new lie: without it the UI
 * would offer an editable input holding a value it cannot change, and the next
 * save would appear to work and then revert on reload. The client uses it to
 * mark those fields read-only and point at the persona file instead.
 */
function withFileOverlay(agent: Agent, runtimes = sqliteService.getRuntimes()) {
  let overlay: ReturnType<typeof readAgentFile> = null;
  try {
    overlay = readAgentFile(agent.id);
  } catch {
    // An unreadable or badly-named persona file must not take the roster down.
  }

  const merged = overlay
    ? { ...agent, ...overlay, managedByFile: Object.keys(overlay) }
    : { ...agent, managedByFile: [] as string[] };

  /**
   * Whether the CLI behind this agent is actually usable on this machine.
   *
   * Alpha holds no credentials, so an agent is only as available as the binary
   * it spawns — and that differs per machine and per person. Attached here
   * because the roster is where someone looks before sending a message, rather
   * than after one has already failed.
   */
  return { ...merged, readiness: agentReadiness(merged, runtimes) };
}

dataRouter.get('/agents', (req: Request, res: Response) => {
  // Runtimes read once for the whole roster, not once per agent.
  const runtimes = sqliteService.getRuntimes();
  res.json(sqliteService.getAgents().map(a => withFileOverlay(a, runtimes)));
});

dataRouter.post('/agents', (req: Request, res: Response) => {
  const error = agentValidationError(req.body, { partial: false });
  if (error) return res.status(400).json({ error });

  const agent = sqliteService.createAgent(req.body);
  res.status(201).json(withFileOverlay(agent));
});

dataRouter.put('/agents/:id', (req: Request, res: Response) => {
  // A PUT here carries only the fields being changed, so absent ones are not
  // cleared — and must not be validated as if they had been sent empty.
  const error = agentValidationError(req.body, { partial: true });
  if (error) return res.status(400).json({ error });

  const updated = sqliteService.updateAgent(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Agent not found' });
  // Merged, like the list: a field the file owns must not appear to have taken
  // the value that was just written to the database.
  res.json(withFileOverlay(updated));
});

dataRouter.delete('/agents/:id', (req: Request, res: Response) => {
  const deleted = sqliteService.deleteAgent(req.params.id);
  res.json({ success: deleted });
});

/**
 * The agent's persona file — `~/.alpha/agents/{id}.md` — as text.
 *
 * Exposed so the file can be edited in the app rather than only in an editor on
 * the machine running the daemon. That matters for the same reason the file
 * exists at all: the persona is prose, and prose is written where the person
 * is, not where the process is.
 *
 * `effective` is what the agent actually resolves to once the file is merged
 * over the database row — the honest answer to "what will this agent be", which
 * neither source gives on its own.
 */
function personaPayload(id: string, agent: Agent) {
  const content = readAgentFileRaw(id);
  const { warnings } = parseAgentFileContent(content ?? '');
  const effective = resolveAgent(agent, { includeMemory: false });

  return {
    agentId: id,
    path: agentFilePath(id),
    exists: content !== null,
    content: content ?? '',
    warnings,
    effective: {
      name: effective.name,
      role: effective.role,
      modelProvider: effective.modelProvider,
      modelName: effective.modelName,
      reasoningEffort: effective.reasoningEffort,
      autonomyLevel: effective.autonomyLevel,
      skills: effective.skills,
      mcpServers: effective.mcpServers,
      systemPromptChars: effective.systemPrompt.length,
      /** 'agents/{id}.md' when the file supplied the persona, else 'alpha.db'. */
      promptSource: effective.sources[0]
    }
  };
}

dataRouter.get('/agents/:id/persona', (req: Request, res: Response) => {
  const agent = sqliteService.getAgents().find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  try {
    res.json(personaPayload(req.params.id, agent));
  } catch (err: any) {
    // agentFilePath throws on an id that would escape the agents directory.
    res.status(400).json({ error: err?.message ?? 'Could not read the persona file' });
  }
});

dataRouter.put('/agents/:id/persona', (req: Request, res: Response) => {
  const agent = sqliteService.getAgents().find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { content } = req.body ?? {};
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  if (Buffer.byteLength(content, 'utf8') > AGENT_FILE_MAX_BYTES) {
    return res.status(413).json({
      error: `Persona file exceeds ${AGENT_FILE_MAX_BYTES} bytes.`
    });
  }

  try {
    writeAgentFileRaw(req.params.id, content);
    // Read back rather than echo, so the response reflects what is on disk —
    // including the warnings the saved text produces.
    res.json(personaPayload(req.params.id, agent));
  } catch (err: any) {
    logError('Could not save persona file', err?.message ?? String(err));
    res.status(400).json({ error: err?.message ?? 'Could not save the persona file' });
  }
});

/**
 * Import an agent from a persona file someone shared.
 *
 * The counterpart to downloading `GET /agents/:id/persona`, and the reason the
 * file carries a complete definition rather than only prose: a teammate should
 * be able to receive an agent and run it, without the sender's machine, keys or
 * subscription being involved.
 *
 * A new id is minted here rather than trusting the file's, so importing the
 * same agent twice produces two agents instead of silently overwriting one —
 * and so an id from elsewhere never becomes a path segment.
 */
dataRouter.post('/agents/import', (req: Request, res: Response) => {
  const { content } = req.body ?? {};

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content must be the text of a persona file' });
  }
  if (Buffer.byteLength(content, 'utf8') > AGENT_FILE_MAX_BYTES) {
    return res.status(413).json({ error: `Persona file exceeds ${AGENT_FILE_MAX_BYTES} bytes.` });
  }

  try {
    const existingIds = sqliteService.getAgents().map(a => a.id);
    const { agent, warnings } = agentFromFileContent(content, existingIds);

    // createAgent writes the persona file too, so the body arrives on disk
    // without a second round trip.
    const created = sqliteService.createAgent(agent);

    logInfo(`Imported agent ${created.id} (${created.name})`);
    res.status(201).json({ agent: withFileOverlay(created), warnings });
  } catch (err: any) {
    logError('Agent import failed', err?.message ?? String(err));
    res.status(400).json({ error: err?.message ?? 'Could not import this persona file' });
  }
});

/**
 * One turn of the conversational agent builder.
 *
 * Declared before no route that could shadow it — `/agents/:id` is a GET-less
 * PUT/DELETE pair, so `/agents/builder/message` cannot be captured by it.
 */
dataRouter.post('/agents/builder/message', async (req: Request, res: Response) => {
  try {
    const result = await sendBuilderMessage({
      sessionId: String(req.body?.sessionId ?? ''),
      runtimeId: String(req.body?.runtimeId ?? ''),
      message: String(req.body?.message ?? '')
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AgentBuilderError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
});

// --- Issues ---

const ISSUE_STATUSES: readonly IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'agent_running',
  'review',
  'done'
];

const ACTIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'awaiting_approval',
  'validating'
]);

function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === 'string' && ISSUE_STATUSES.includes(value as IssueStatus);
}

function activeRunForIssue(issueId: string) {
  return sqliteService.getPrototypeRuns().find(run =>
    run.issueId === issueId && ACTIVE_RUN_STATUSES.has(run.status)
  );
}

/**
 * Status is writable through the generic issue endpoint only for ordinary
 * planning moves. Starting an agent and completing reviewed work are commands
 * with their own endpoints; otherwise a caller could skip the preparation or
 * review gate by sending { status: 'agent_running' } or { status: 'done' } to
 * PUT /issues/:id.
 */
function statusTransitionError(issue: Issue, requestedStatus: unknown): string | null {
  if (requestedStatus === undefined || requestedStatus === issue.status) return null;

  if (!isIssueStatus(requestedStatus)) {
    return 'status must be one of: ' + ISSUE_STATUSES.join(', ') + '.';
  }

  const activeRun = activeRunForIssue(issue.id);

  if (requestedStatus === 'agent_running') {
    return 'Start an agent run through POST /api/runs/start; direct status changes to Agent Running are not allowed.';
  }

  if (requestedStatus === 'done') {
    if (activeRun?.status === 'awaiting_approval') {
      return 'Run ' + activeRun.id + ' is awaiting approval; approve it through POST /api/runs/' + activeRun.id + '/approve.';
    }
    if (activeRun) {
      return 'Run ' + activeRun.id + ' is still ' + activeRun.status + '; wait for it to reach review before completing the issue.';
    }
    if (issue.status === 'agent_running') {
      return 'An Agent Running issue must reach review before it can be completed.';
    }
    return 'Complete the issue through POST /api/issues/:id/complete with { reviewed: true }; direct Done transitions are not allowed.';
  }

  if (activeRun) {
    return 'This issue has an active agent run (' + activeRun.id + ') still ' + activeRun.status + '; use the run controls before changing this issue.';
  }

  return null;
}

dataRouter.get('/issues', (req: Request, res: Response) => {
  res.json(sqliteService.getIssues());
});

/**
 * Create an issue. The daemon owns the identifier and the author.
 *
 * The browser used to send both: an identifier built as `issues.length + 101`
 * — a count of every issue in every project — and a system comment quoting it.
 * `createIssue` honours a supplied identifier, so `nextIssueIdentifier`, which
 * numbers per project correctly, never ran for anything made in the UI. The
 * first issue of a new project came out as TES-107 because six issues happened
 * to exist elsewhere, and two creates at the same count would collide against
 * a UNIQUE column.
 *
 * Dropping both here rather than trusting the client keeps one authority for
 * each, and the numbering stays right no matter who is calling.
 */
dataRouter.post('/issues', async (req: Request, res: Response) => {
  const { identifier: _ignored, comments: _alsoIgnored, ...rest } = req.body ?? {};

  if (rest.assignedAgentId && rest.assignedSquadId) {
    return res.status(400).json({ error: 'Choose either an agent or a squad as the issue owner, not both.' });
  }

  const identity = await currentIdentity();
  const issue = sqliteService.createIssue({ ...rest, createdBy: rest.createdBy || identity.login });

  /**
   * The opening comment, written where the real identifier is known.
   *
   * Composed by the browser before, against the identifier it had guessed — so
   * it named an issue that did not exist under that name.
   */
  sqliteService.addIssueComment({
    id: `comm-${issue.id}-created`,
    issueId: issue.id,
    authorType: 'system',
    authorName: 'Alpha',
    content: `${issue.identifier} created by ${identity.login}.`,
    createdAt: issue.createdAt
  });

  // Re-read so the response carries the comment rather than making the client
  // guess at one.
  let saved = sqliteService.getIssues().find(i => i.id === issue.id) ?? issue;

  /**
   * Publish it, so it is a card everyone can see rather than a row on one
   * laptop.
   *
   * Awaited rather than fired and forgotten: the response carries the issue
   * number, and a card that does not know which GitHub issue it is cannot be
   * updated later. A project with no repository pushes nothing and is fine.
   */
  const push = await pushIssue(saved);
  if (push.patch) {
    sqliteService.updateIssue(saved.id, push.patch);
    saved = sqliteService.getIssues().find(i => i.id === saved.id) ?? saved;
  }

  // 201 with a warning rather than an error: the issue exists locally and
  // refusing it now would lose work the person already did.
  res.status(201).json(push.error ? { ...saved, syncWarning: push.error } : saved);
});

dataRouter.put('/issues/:id', async (req: Request, res: Response) => {
  const before = sqliteService.getIssues().find(i => i.id === req.params.id);
  if (!before) return res.status(404).json({ error: 'Issue not found' });

  const transitionError = statusTransitionError(before, req.body?.status);
  if (transitionError) {
    const status = isIssueStatus(req.body?.status) ? 409 : 400;
    return res.status(status).json({ error: transitionError });
  }

  const updated = sqliteService.updateIssue(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Issue not found' });

  /**
   * Only when a field GitHub owns actually moved.
   *
   * Assigning an agent or attaching a branch is Alpha's own business, and
   * calling GitHub for it would spend a request to change nothing.
   */
  if (!needsPush(before, updated)) return res.json(updated);

  const push = await pushIssue(updated);
  if (push.patch) sqliteService.updateIssue(updated.id, push.patch);

  const saved = sqliteService.getIssues().find(i => i.id === updated.id) ?? updated;
  /**
   * A failed push is reported, never swallowed.
   *
   * The local write already happened, so this is not a 4xx — but the browser
   * has to know, or the board shows a state GitHub never accepted and the next
   * sync silently reverts it.
   */
  res.json(push.error ? { ...saved, syncWarning: push.error } : saved);
});

/**
 * Complete an issue after a human review checkpoint.
 *
 * This is deliberately a command rather than another status-shaped PUT. The
 * explicit reviewed flag gives clients a narrow, auditable write path, while
 * active runs remain owned by the runner or the run approval endpoint.
 */
dataRouter.post('/issues/:id/complete', async (req: Request, res: Response) => {
  const before = sqliteService.getIssues().find(i => i.id === req.params.id);
  if (!before) return res.status(404).json({ error: 'Issue not found' });

  if (req.body?.reviewed !== true) {
    return res.status(400).json({ error: 'reviewed must be true to complete an issue.' });
  }

  if (before.status === 'done') return res.json(before);

  const activeRun = activeRunForIssue(before.id);
  if (activeRun) {
    if (activeRun.status === 'awaiting_approval') {
      return res.status(409).json({
        error: 'This issue has a run awaiting approval; approve the run before completing the issue.'
      });
    }
    return res.status(409).json({
      error: 'This issue has an active agent run; wait for it to reach review before completing the issue.'
    });
  }

  if (before.status === 'agent_running') {
    return res.status(409).json({
      error: 'An Agent Running issue must reach review before it can be completed.'
    });
  }

  const updated = sqliteService.updateIssue(before.id, { status: 'done' });
  if (!updated) return res.status(404).json({ error: 'Issue not found' });

  if (!needsPush(before, updated)) return res.json(updated);

  const push = await pushIssue(updated);
  if (push.patch) sqliteService.updateIssue(updated.id, push.patch);

  const saved = sqliteService.getIssues().find(i => i.id === updated.id) ?? updated;
  res.json(push.error ? { ...saved, syncWarning: push.error } : saved);
});

dataRouter.delete('/issues/:id', (req: Request, res: Response) => {
  const deleted = sqliteService.deleteIssue(req.params.id);
  res.json({ success: deleted });
});

dataRouter.post('/issues/:id/comments', (req: Request, res: Response) => {
  const comment = sqliteService.addIssueComment({
    ...req.body,
    issueId: req.params.id
  });
  res.status(201).json(comment);
});

// --- Squads ---
dataRouter.get('/squads', (req: Request, res: Response) => {
  res.json(sqliteService.getSquads());
});

dataRouter.post('/squads', (req: Request, res: Response) => {
  const squad = sqliteService.createSquad(req.body);
  res.status(201).json(squad);
});

/**
 * Edit and delete, which squads did not have.
 *
 * An agent is created, edited, archived and deleted; a squad could only be
 * created and run. Same kind of object to the person using it, so a typo in a
 * squad name or a wrong member list was permanent.
 *
 * A PUT carries only the fields being changed, like the agent and project
 * routes above — absent ones are left as they are rather than cleared.
 */
dataRouter.put('/squads/:id', (req: Request, res: Response) => {
  if (req.body?.name !== undefined && !String(req.body.name).trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }

  const updated = sqliteService.updateSquad(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Squad not found' });
  res.json(updated);
});

dataRouter.delete('/squads/:id', (req: Request, res: Response) => {
  const deleted = sqliteService.deleteSquad(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Squad not found' });
  res.json({ success: true });
});

// --- Skills ---
/*
 * Each skill carries the tools it actually grants a chat turn.
 *
 * Served rather than mirrored in the frontend. The bug this closes was a panel
 * describing capability the runner never handed over; hard-coding the same map
 * on the other side of the wire rebuilds that the first time one copy is edited
 * and the other is not. SKILL_TOOLS stays the only place it is written down.
 *
 * Empty for a skill that grants no CLI tool — `sk-git` grants MCP write access,
 * which is resolved per agent from its autonomy level and cannot be read off
 * the skill alone.
 */
dataRouter.get('/skills', (req: Request, res: Response) => {
  res.json(
    sqliteService.scanSkills().map(skill => ({
      ...skill,
      grantedTools: SKILL_TOOLS[skill.id] ?? []
    }))
  );
});

/** Force a fresh filesystem scan after a skill is installed or removed. */
dataRouter.post('/skills/scan', (_req: Request, res: Response) => {
  res.json(
    sqliteService.scanSkills().map(skill => ({
      ...skill,
      grantedTools: SKILL_TOOLS[skill.id] ?? []
    }))
  );
});

dataRouter.put('/skills/:id', (req: Request, res: Response) => {
  const { isEnabled } = req.body;
  sqliteService.setSkillEnabled(req.params.id, Boolean(isEnabled));
  res.json({ success: true });
});
