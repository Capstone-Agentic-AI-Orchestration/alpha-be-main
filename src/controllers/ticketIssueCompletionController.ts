import { Router } from 'express';
import type { TicketLifecycleRuntime } from '../services/ticketLifecycleRuntime.js';
import { issueStore } from '../store/stores.js';
import { supabaseService } from '../services/supabaseService.js';
import { needsPush, pushIssue } from '../services/githubBoardWrite.js';
import { relayToCloud } from './cloudRelay.js';
import { route } from './asyncRoute.js';
import { assignedWorkTicketSubject } from './ticketRequestAuth.js';
import { requireEntityWorkspace, requireProjectWorkspace, requireWorkspaceCapability } from './workspaceContext.js';
import { IS_CLOUD } from '../config/env.js';

/** Preserve the ordinary Issue completion endpoint, but put ticket-linked work
 * through the trusted review checkpoint before it can become client-ready. */
export function createTicketIssueCompletionRouter(runtime: TicketLifecycleRuntime | null): Router {
  const router = Router({ caseSensitive: true, strict: true });
  router.post('/issues/:id/complete', route(async (req, res, next) => {
    if (!requireWorkspaceCapability(req, res, 'issue.manage')) return;
    const workspaceId = req.workspace?.workspaceId ?? '';
    const issueId = req.params.id ?? '';
    if (!requireEntityWorkspace(req, res, 'issues', issueId)) return;
    const localIssue = await issueStore().get(workspaceId, issueId);
    if (!localIssue) return res.status(404).json({ error: 'Issue not found' });
    if (!requireProjectWorkspace(req, res, localIssue.projectId)) return;

    if (!IS_CLOUD) {
      const relayed = await relayToCloud(req, res, {
        path: `/issues/${encodeURIComponent(issueId)}/complete`,
        mirror: async (value: unknown) => {
          if (value && typeof value === 'object' && 'id' in value && (value as { id?: unknown }).id === issueId
            && 'status' in value && (value as { status?: unknown }).status === 'done') {
            await issueStore().update(workspaceId, issueId, { status: 'done' });
          }
        },
      });
      if (relayed) return;
      return next();
    }

    if (!runtime?.enabled) return next();
    const subject = assignedWorkTicketSubject(req, res);
    if (!subject) return;
    if (req.body?.reviewed !== true) return res.status(400).json({ error: 'reviewed must be true to complete an issue.' });
    const runId = req.body?.runId;
    if (runId !== undefined && (typeof runId !== 'string' || !runId.trim() || runId.trim() !== runId || runId.length > 200)) {
      return res.status(400).json({ error: 'Invalid review evidence.' });
    }
    const result = await runtime.completeReviewedIssue({ workspaceId, issueId }, subject, runId);
    if (result.kind === 'unlinked') return next();

    const after = await issueStore().get(workspaceId, issueId);
    if (!after) return res.status(404).json({ error: 'Issue not found' });
    if (!needsPush(localIssue, after)) {
      void supabaseService.shareIssue(after);
      return res.json(after);
    }
    const push = await pushIssue(after, workspaceId);
    if (push.patch) await issueStore().update(workspaceId, after.id, push.patch);
    const saved = await issueStore().get(workspaceId, issueId) ?? after;
    void supabaseService.shareIssue(saved);
    return res.json(push.error ? { ...saved, syncWarning: push.error } : saved);
  }));
  return router;
}
