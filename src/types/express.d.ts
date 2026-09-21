import type { WorkspaceContext } from '../services/workspaceRegistry.js';
import type { Session } from '../services/sessionService.js';

declare global {
  namespace Express {
    interface Request {
      workspace?: WorkspaceContext;
      /**
       * The signed-in browser session, in cloud mode only.
       *
       * Absent on the desktop, where identity comes from the local `gh` CLI
       * rather than a cookie, and absent in the cloud for an unauthenticated
       * caller. `workspaceContext` is what turns that absence into a 401.
       */
      session?: Session;
    }
  }
}

export {};
