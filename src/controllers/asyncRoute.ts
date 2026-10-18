import type { NextFunction, Request, Response } from 'express';

/**
 * An async route handler, with its failures sent to the error handler.
 *
 * Express 4 does not await what a handler returns, so a rejected promise
 * reaches no error handler at all: the request hangs until it times out, and
 * Node reports an unhandled rejection — which, depending on flags, ends the
 * process. Handlers that touch the database are all async now, so this is
 * what makes their failures answer 500 (or 503) like every other error.
 */
export const route =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
