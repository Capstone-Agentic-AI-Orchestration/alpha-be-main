import type { NextFunction, Request, Response } from 'express';

import { IS_CLOUD } from '../config/env.js';

/**
 * A route that only means something on a developer's machine.
 *
 * The cloud never runs an agent: there are no agent CLIs on Render, no working
 * copy, and nothing on its disk survives a deploy. These routes spawn an agent,
 * read a local checkout, or keep machine facts -- runtimes, MCP servers, chat
 * sessions tied to a CLI -- and in the cloud they used to fall through to the
 * desktop's SQLite file on Render's disk, or to a `gh` that is not installed.
 *
 * Answered here instead, with what to do about it, so the web app can say
 * "open this in the desktop app" rather than showing a server error.
 *
 * Applied route by route rather than with `router.use()`: every router is
 * mounted at `/api`, so a router-level middleware would also catch requests
 * meant for routes the router does not own.
 */
export function desktopOnly(_req: Request, res: Response, next: NextFunction): void {
  if (!IS_CLOUD) return next();
  res.status(409).json({
    error: 'This runs in the Alpha desktop app, on the machine with the code and the agents. The web app cannot do it.',
    code: 'desktop_only'
  });
}
