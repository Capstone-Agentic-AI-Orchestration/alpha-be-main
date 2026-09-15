/**
 * Agent payload validation.
 *
 * Kept out of `dataController` so it can be exercised without loading it: the
 * controller pulls in `sqliteService`, which opens the database at import time
 * and needs the native `better-sqlite3` binding. A pure check should not need
 * either to be tested.
 */

/**
 * Mirrors AGENT_DESCRIPTION_MAX_LENGTH in the client's `agentDraft.ts`. The two
 * apps share no package, so the constant is duplicated — but it is enforced on
 * both sides on purpose: the client counter is for the person typing, and this
 * is what stops a seeded or scripted description from landing in the database
 * at whatever length it happens to be.
 */
export const AGENT_DESCRIPTION_MAX_LENGTH = 255;

const REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]);

/** The reason this agent payload is invalid, or null when it is fine. */
export function agentValidationError(
  body: any,
  { partial }: { partial: boolean }
): string | null {
  const hasName = body?.name !== undefined;
  if ((!partial || hasName) && !String(body?.name ?? '').trim()) {
    return 'name is required';
  }
  if (body?.description !== undefined) {
    // Spread, not `.length` — a description of emoji costs the user what it
    // costs the database, not twice that.
    if ([...String(body.description)].length > AGENT_DESCRIPTION_MAX_LENGTH) {
      return `description exceeds ${AGENT_DESCRIPTION_MAX_LENGTH} characters`;
    }
  }
  if (body?.reasoningEffort !== undefined && body.reasoningEffort !== null) {
    if (typeof body.reasoningEffort !== 'string' || !REASONING_EFFORTS.has(body.reasoningEffort)) {
      return 'reasoningEffort must be one of: none, minimal, low, medium, high, xhigh, max, ultra';
    }
  }
  return null;
}
