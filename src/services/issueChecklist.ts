import { createHash } from 'node:crypto';
import type { IssueSubtask } from '../models/index.js';
import type { OrchestrationPlan } from './orchestrationContract.js';

/** Stable linkage without another shared-board write or a schema migration.
 * Editing the wording changes the ID, so an older build cannot tick new work.
 */
export function checklistRequirementId(item: Pick<IssueSubtask, 'id' | 'title'>): string {
  return 'CHECK-' + createHash('sha256').update(JSON.stringify([item.id, item.title])).digest('hex').slice(0, 24);
}

export function manualChecklistRequirements(items: readonly IssueSubtask[]): OrchestrationPlan['requirements'] {
  return items.filter(item => item.source !== 'spec' && !item.completed && item.title.trim())
    .map(item => ({ id: checklistRequirementId(item), description: item.title }));
}
