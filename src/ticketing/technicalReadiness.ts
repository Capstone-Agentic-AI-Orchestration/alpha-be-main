import { createHash } from 'node:crypto';

import type { TicketReadyManifest } from '../store/ticketTechnicalReadinessStore.js';
import { assertCompletedTicketWork, type TicketFacts, type TicketWorkflow } from './workflow.js';

/** Server-derived immutable manifest identity, shared by readiness and artifact
 * registration. This is private evidence, never a client capability or URL.
 */
export function ticketReadyManifest(state: TicketWorkflow, facts: TicketFacts): TicketReadyManifest {
  const work = assertCompletedTicketWork(state, facts);
  const issueRevisions = work.map(issue => ({ issueId: issue.id, revisionId: issue.revisionId }))
    .sort((a, b) => a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0);
  const owner = { workspaceId: state.workspaceId, ticketId: state.id,
    projectId: state.projectId!, scopeVersionId: state.scopeVersionId!, issueRevisions };
  const id = createHash('sha256').update(JSON.stringify(['ticket_ready_manifest_v1', owner])).digest('hex');
  return { ...owner, id };
}

export function sameTicketReadyManifest(a: TicketReadyManifest, b: TicketReadyManifest): boolean {
  if (!a || !b || a.id !== b.id || a.workspaceId !== b.workspaceId || a.ticketId !== b.ticketId
    || a.projectId !== b.projectId || a.scopeVersionId !== b.scopeVersionId
    || !Array.isArray(a.issueRevisions) || !Array.isArray(b.issueRevisions)
    || a.issueRevisions.length !== b.issueRevisions.length) return false;
  // Canonical order is part of persisted evidence; do not trust the hash alone.
  return a.issueRevisions.every((row, index) => row.issueId === b.issueRevisions[index]?.issueId
    && row.revisionId === b.issueRevisions[index]?.revisionId);
}
