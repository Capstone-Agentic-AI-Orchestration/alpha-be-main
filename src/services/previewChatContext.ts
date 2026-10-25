import { IS_CLOUD } from '../config/env.js';
import { isPreviewInvestigationRequest } from './chatRouter.js';
import { localPreviewService } from './localPreviewService.js';
import type { ProjectRoot } from './projectFiles.js';
import type { WorkspaceContext } from './workspaceRegistry.js';

/** Evidence is refreshed per turn; scoped analysis cannot silently inspect the wrong checkout. */
export async function previewChatContext(context: WorkspaceContext | undefined, threadId: string, request: string, ordinaryRoots: ProjectRoot[], repositories?: string[]) {
  if (!context || IS_CLOUD) return { roots: ordinaryRoots, text: '', sourceKey: '' };
  const investigating = isPreviewInvestigationRequest(request);
  try {
    const evidence = await localPreviewService.chatEvidence(context, threadId, repositories);
    // A browser question with no preview history still concerns the ordinary repository.
    const usePreview = investigating && Boolean(evidence.sourceKey);
    return { ...evidence, roots: usePreview ? evidence.roots : ordinaryRoots, sourceKey: usePreview ? evidence.sourceKey : '' };
  } catch {
    return { roots: investigating ? [] : ordinaryRoots, text: 'Local preview evidence is unavailable for this authorized conversation. Do not claim to have inspected its runtime or substitute an unrelated checkout.', sourceKey: '' };
  }
}
