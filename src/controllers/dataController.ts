import { Request, Response, Router } from 'express';
import { sqliteService } from '../services/sqliteService.js';

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
  const agent = sqliteService.createAgent(req.body);
  res.status(201).json(agent);
});

dataRouter.put('/agents/:id', (req: Request, res: Response) => {
  const updated = sqliteService.updateAgent(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Agent not found' });
  res.json(updated);
});

dataRouter.delete('/agents/:id', (req: Request, res: Response) => {
  const deleted = sqliteService.deleteAgent(req.params.id);
  res.json({ success: deleted });
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
