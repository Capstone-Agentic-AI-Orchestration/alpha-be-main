import type { WorkspaceContext } from '../services/workspaceRegistry.js';

declare global {
  namespace Express {
    interface Request {
      workspace?: WorkspaceContext;
    }
  }
}

export {};
