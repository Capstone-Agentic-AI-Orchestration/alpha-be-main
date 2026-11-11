import { Request, Response, Router } from 'express';
import { requireWorkspaceCapability } from './workspaceContext.js';
import { desktopOnly } from './desktopOnly.js';
import { runWithWorkspace } from '../services/workspaceContext.js';
import { aiUsageSummary, type AiUsageProvider } from '../services/aiUsageService.js';
import { USAGE_PRICE_TABLE_VERSION } from '../services/usagePricing.js';
import { getProviderLimits } from '../services/providerLimits.js';

export const aiUsageRouter = Router();

const providers: AiUsageProvider[] = ['claude', 'codex', 'antigravity'];

function dateBoundary(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== `${value}T00:00:00.000Z`
    ? null
    : parsed.toISOString();
}

aiUsageRouter.get('/ai-usage/summary', desktopOnly, (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  const from = dateBoundary(req.query.from);
  const to = dateBoundary(req.query.to);
  const provider = req.query.provider === 'all' || req.query.provider === undefined
    ? undefined
    : String(req.query.provider);
  if (!from || !to || Date.parse(from) >= Date.parse(to)) {
    return res.status(400).json({ error: 'from and to must be valid UTC dates, with to after from.' });
  }
  if (Date.parse(to) - Date.parse(from) > 366 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'AI usage date ranges are limited to 366 days.' });
  }
  if (provider && !providers.includes(provider as AiUsageProvider)) {
    return res.status(400).json({ error: 'Unsupported provider filter.' });
  }
  try {
    const result = runWithWorkspace(req.workspace!.workspaceId, () => aiUsageSummary({
      ownerId: req.workspace!.userId,
      from,
      to,
      provider: provider as AiUsageProvider | undefined
    }, USAGE_PRICE_TABLE_VERSION));
    return res.json(result);
  } catch {
    return res.status(500).json({ error: 'Could not read local AI usage.' });
  }
});

aiUsageRouter.get('/ai-usage/limits', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  try {
    return res.json(await getProviderLimits());
  } catch {
    return res.status(500).json({ error: 'Could not read provider limits.' });
  }
});

aiUsageRouter.post('/ai-usage/limits/refresh', desktopOnly, async (req: Request, res: Response) => {
  if (!requireWorkspaceCapability(req, res, 'agent.read')) return;
  try {
    return res.json(await getProviderLimits(true));
  } catch {
    return res.status(500).json({ error: 'Could not refresh provider limits.' });
  }
});
