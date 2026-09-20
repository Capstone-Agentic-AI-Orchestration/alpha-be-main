import { AsyncLocalStorage } from 'node:async_hooks';

/** The workspace that owns legacy rows and requests without an explicit header. */
export const DEFAULT_WORKSPACE_ID = 'ws-default';

const storage = new AsyncLocalStorage<string>();

export function currentWorkspaceId(): string {
  return storage.getStore() ?? DEFAULT_WORKSPACE_ID;
}

/** Keep the workspace selection attached to the complete Express async chain. */
export function runWithWorkspace<T>(workspaceId: string, callback: () => T): T {
  return storage.run(workspaceId, callback);
}
