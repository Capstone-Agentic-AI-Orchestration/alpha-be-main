import type { Project } from '../models/index.js';
import { productPictureFor, productPictureRoom, type ProductPictureSource } from './productPicture.js';
import { sqliteService, type SQLiteService } from './sqliteService.js';
import { logInfo } from '../utils/logger.js';

/** How many recent builds the product picture reads. */
const PRODUCT_PICTURE_BUILDS = 10;

/**
 * The product picture's data in one desktop store: the project's board cards, its recent builds and
 * the approved feature specs. Builds are desktop-only, like orchestration itself. Callers run inside
 * the request's workspace (runWithWorkspace), so every read is scoped to it.
 */
export function storeProductPictureSource(
  store: Pick<SQLiteService, 'getIssues' | 'listProjectOrchestrationSnapshots' | 'getFeatureSpec'>
): ProductPictureSource {
  return {
    issues: projectId => store.getIssues().filter(issue => issue.projectId === projectId),
    snapshots: projectId => store.listProjectOrchestrationSnapshots(projectId, PRODUCT_PICTURE_BUILDS),
    approvedSpec: issueId => {
      const spec = store.getFeatureSpec(issueId);
      return spec?.status === 'approved' ? spec : null;
    }
  };
}

/** This desktop's store. */
export const desktopProductPictureSource: ProductPictureSource = storeProductPictureSource(sqliteService);

/** Said instead of the picture when it cannot be read, so an agent does not plan or build as if nothing were recorded. */
export const AGENT_PRODUCT_PICTURE_UNAVAILABLE = [
  '## Product picture',
  'Alpha could not read this project\'s records (brief, board, requests, decisions) for this turn. Do not assume none exist: work from the request and the project context, and say in your report or plan decisions that the product records were unavailable.'
].join('\n');

/**
 * The team product picture for the planner and the specialists, read fresh each time and sized to
 * fit beside the project context they already get (productPictureRoom). Internal only: it carries
 * builds, decisions and open questions, so it must never reach a client prompt. A read that fails
 * is logged and said plainly, never silently dropped.
 */
export function agentProductPicture(
  project: Pick<Project, 'id' | 'name' | 'description'>,
  projectContext: string | undefined,
  source: ProductPictureSource = desktopProductPictureSource
): string {
  const room = productPictureRoom(projectContext);
  if (!room) return '';
  try {
    return productPictureFor(project, 'team', source, room);
  } catch (error) {
    logInfo(`Product picture for ${project.name} could not be read for an agent: ${error instanceof Error ? error.message : String(error)}`);
    return AGENT_PRODUCT_PICTURE_UNAVAILABLE;
  }
}
