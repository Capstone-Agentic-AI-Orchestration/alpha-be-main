import type { Project } from '../models/index.js';
import { logInfo } from '../utils/logger.js';
import { productPictureFor, type ProductAudience, type ProductPictureSource } from './productPicture.js';
import { desktopProductPictureSource } from './productPictureSource.js';
import { runWithWorkspace } from './workspaceContext.js';
import type { WorkspaceContext, WorkspaceRole } from './workspaceRegistry.js';

/**
 * Who reads one of Alpha's chat answers. The audience decides what Alpha is given for the turn:
 * the team sees the whole product picture and how the work is going; a client sees the brief only.
 */
export interface ChatViewer {
  audience: ProductAudience;
  role?: WorkspaceRole;
  /** The request's workspace context, for features scoped to the person (the local preview). */
  context?: WorkspaceContext;
}

const TEAM_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>(['dev', 'pm', 'admin']);

/**
 * The audience for a workspace role. Only a known team role gets the team picture: a client, a
 * missing role or a role added later gets the client one, which shows the least.
 */
export function chatAudience(role: WorkspaceRole | undefined): ProductAudience {
  return role && TEAM_ROLES.has(role) ? 'team' : 'client';
}

export function chatViewer(role: WorkspaceRole | undefined, context?: WorkspaceContext): ChatViewer {
  return { audience: chatAudience(role), ...(role ? { role } : {}), ...(context ? { context } : {}) };
}

/** Said instead of the picture when it cannot be read, so Alpha does not answer as if nothing were recorded. */
export const PRODUCT_PICTURE_UNAVAILABLE = [
  '## Product picture',
  'Alpha could not read this project\'s records for this answer. If asked what the project is, say you cannot see its records right now; do not guess.'
].join('\n');

/**
 * The product picture block for Alpha's chat prompt, read inside the request's workspace. A read
 * that fails is logged and said plainly, never dropped: without it Alpha would answer as if the
 * project had no brief.
 */
export function chatProductPicture(
  project: Pick<Project, 'id' | 'name' | 'description'>,
  audience: ProductAudience,
  workspaceId?: string,
  source: ProductPictureSource = desktopProductPictureSource
): string {
  const read = () => productPictureFor(project, audience, source);
  try {
    return workspaceId ? runWithWorkspace(workspaceId, read) : read();
  } catch (error) {
    logInfo(`Product picture for ${project.name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return PRODUCT_PICTURE_UNAVAILABLE;
  }
}
