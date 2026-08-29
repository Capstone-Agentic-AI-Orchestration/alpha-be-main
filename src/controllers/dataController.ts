import { Request, Response, Router } from 'express';
import { sqliteService } from '../services/sqliteService.js';
import { agentValidationError } from './agentValidation.js';
import { AgentBuilderError, sendBuilderMessage } from '../services/agentBuilderService.js';
import {
  AGENT_FILE_MAX_BYTES,
  agentFilePath,
  parseAgentFileContent,
  readAgentFileRaw,
  writeAgentFileRaw
} from '../services/agentFileService.js';
import { resolveAgent } from '../services/personaService.js';
import { Agent } from '../models/index.js';
import { logError } from '../utils/logger.js';

export const dataRouter = Router();

// --- Projects ---
dataRouter.get('/projects', (req: Request, res: Response) => {
  res.json(sqliteService.getProjects());
});

dataRouter.post('/projects', (req: Request, res: Response) => {
  const project = sqliteService.createProject(req.body);
  res.status(201).json(project);
});

dataRouter.put('/projects/:id', (req: Request, res: Response) => {
  const updated = sqliteService.updateProject(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Project not found' });
  res.json(updated);
});

dataRouter.delete('/projects/:id', (req: Request, res: Response) => {
  const deleted = sqliteService.deleteProject(req.params.id);
  res.json({ success: deleted });
});

// --- Agents ---
dataRouter.get('/agents', (req: Request, res: Response) => {
  res.json(sqliteService.getAgents());
});

dataRouter.post('/agents', (req: Request, res: Response) => {
  const error = agentValidationError(req.body, { partial: false });
  if (error) return res.status(400).json({ error });

  const agent = sqliteService.createAgent(req.body);
  res.status(201).json(agent);
});

dataRouter.put('/agents/:id', (req: Request, res: Response) => {
  // A PUT here carries only the fields being changed, so absent ones are not
  // cleared — and must not be validated as if they had been sent empty.
  const error = agentValidationError(req.body, { partial: true });
  if (error) return res.status(400).json({ error });

  const updated = sqliteService.updateAgent(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Agent not found' });
  res.json(updated);
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
dataRouter.get('/issues', (req: Request, res: Response) => {
  res.json(sqliteService.getIssues());
});

dataRouter.post('/issues', (req: Request, res: Response) => {
  const issue = sqliteService.createIssue(req.body);
  res.status(201).json(issue);
});

dataRouter.put('/issues/:id', (req: Request, res: Response) => {
  const updated = sqliteService.updateIssue(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Issue not found' });
  res.json(updated);
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

// --- Skills ---
dataRouter.get('/skills', (req: Request, res: Response) => {
  res.json(sqliteService.getSkills());
});

dataRouter.put('/skills/:id', (req: Request, res: Response) => {
  const { isEnabled } = req.body;
  sqliteService.setSkillEnabled(req.params.id, Boolean(isEnabled));
  res.json({ success: true });
});
