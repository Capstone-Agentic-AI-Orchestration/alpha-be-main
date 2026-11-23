import type { ProductPictureSource } from './productPicture.js';
import { sqliteService } from './sqliteService.js';

/** How many recent builds the product picture reads. */
const PRODUCT_PICTURE_BUILDS = 10;

/**
 * The product picture's data on this desktop: the project's board cards, its recent builds and the
 * approved feature specs. Builds are desktop-only, like orchestration itself. Callers run inside
 * the request's workspace (runWithWorkspace), so every read is scoped to it.
 */
export const desktopProductPictureSource: ProductPictureSource = {
  issues: projectId => sqliteService.getIssues().filter(issue => issue.projectId === projectId),
  snapshots: projectId => sqliteService.listProjectOrchestrationSnapshots(projectId, PRODUCT_PICTURE_BUILDS),
  approvedSpec: issueId => {
    const spec = sqliteService.getFeatureSpec(issueId);
    return spec?.status === 'approved' ? spec : null;
  }
};
