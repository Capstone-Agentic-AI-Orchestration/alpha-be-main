import { Request, Response, Router } from 'express';
import { chatService } from '../services/chatService.js';
import { sqliteService } from '../services/sqliteService.js';

export const chatRouter = Router();

chatRouter.get('/chat/threads', (req: Request, res: Response) => {
  res.json(sqliteService.getChatThreads());
});

chatRouter.post('/chat/threads', (req: Request, res: Response) => {
  const thread = sqliteService.createChatThread(req.body);
  res.status(201).json(thread);
});

chatRouter.get('/chat/threads/:id/messages', (req: Request, res: Response) => {
  res.json(sqliteService.getChatMessages(req.params.id));
});

chatRouter.post('/chat/messages', async (req: Request, res: Response) => {
  try {
    const { threadId, content, senderName } = req.body;
    if (!threadId || !content) {
      return res.status(400).json({ error: 'threadId and content are required' });
    }
    const result = await chatService.sendMessage({ threadId, content, senderName });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to process chat message' });
  }
});
