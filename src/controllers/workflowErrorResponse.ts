import type { Response } from 'express';

import { DomainRefusal } from '../services/domainRefusal.js';

/**
 * The HTTP answer for a failed task-workflow action. An expected refusal says so itself:
 * 409 with its reason and the next steps that fit. Older refusals are still recognised by
 * their wording until each becomes a DomainRefusal. Anything left is an unexpected failure:
 * a 500, logged as one, so it is found and fixed instead of shown as a dead end.
 */
export function workflowErrorAnswer(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof DomainRefusal) return { status: 409, body: error.toBody() };
  const message = error instanceof Error ? error.message : 'The task workflow action failed.';
  if (/not found|unavailable/i.test(message)) return { status: 404, body: { error: message } };
  if (/cannot|only |already|changed|retry|stale|no longer|disabled|validation|review|action key|refresh|under \d+ characters|add the direction/i.test(message)) return { status: 409, body: { error: message } };
  return { status: 500, body: { error: message } };
}

export function errorResponse(res: Response, error: unknown): void {
  const answer = workflowErrorAnswer(error);
  if (answer.status === 500) {
    // Loaded when needed: the logger reads config that route tests replace.
    void import('../utils/logger.js').then(({ logError }) => logError('Unexpected task workflow failure (reported to the person as an error):',
      error instanceof Error ? error.stack ?? error.message : String(error))).catch(() => undefined);
  }
  res.status(answer.status).json(answer.body);
}
