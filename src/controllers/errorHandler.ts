import { Request, Response, NextFunction } from 'express';
import { DatabaseError } from '../store/database.js';
import { WorkspaceRequestError } from '../store/workspaceDirectory.js';
import { logError } from '../utils/logger.js';

/**
 * Turn a thrown error into the JSON shape the rest of the API already answers with.
 *
 * There was no error handler at all, so anything a route threw reached Express's
 * default: an HTML page carrying a stack trace with absolute file paths. Only
 * one of the eighteen write routes had its own try/catch.
 *
 * The frontend's `fetchJson` unwraps `{ "error": "..." }` and falls back to the
 * raw body when it is not JSON — so a duplicate project key put an entire HTML
 * document, stack trace included, into a toast that should have read
 * "That project key is already taken."
 *
 * Registered once after the routers rather than as a try/catch per handler,
 * because the routes that lacked one are exactly the routes nobody thought
 * could throw.
 */

/** better-sqlite3 reports constraint failures through `code`, not the message. */
interface SqliteError extends Error {
  code?: string;
}

/**
 * Which column collided, when SQLite says so.
 *
 * Messages look like `UNIQUE constraint failed: projects.key`. Naming the field
 * is the difference between a message someone can act on and one they can only
 * report.
 */
function uniqueFieldFrom(message: string): string | null {
  const match = /UNIQUE constraint failed: \w+\.(\w+)/.exec(message);
  return match ? match[1] : null;
}

export function jsonErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) {
  // Express requires the four-argument shape to recognise this as an error
  // handler, and delegates to its own if the response has already started.
  if (res.headersSent) return next(err);

  const error = err as SqliteError;
  const message = error?.message ?? String(err);
  const code = error?.code ?? '';

  if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || message.includes('UNIQUE constraint failed')) {
    const field = uniqueFieldFrom(message);
    logError(`Rejected a duplicate value: ${message}`);
    return res.status(409).json({
      error: field
        ? `That ${field} is already taken. Choose a different one.`
        : 'Something with those details already exists.'
    });
  }

  if (code.startsWith('SQLITE_CONSTRAINT_FOREIGNKEY') || message.includes('FOREIGN KEY constraint failed')) {
    logError(`Rejected a dangling reference: ${message}`);
    return res.status(409).json({
      error: 'That refers to something which no longer exists. Reload and try again.'
    });
  }

  /**
   * A workspace request refused for a reason the caller can act on: an invite
   * code that matches nothing, a slug already taken, access an admin removed.
   * The store raises these, and the message is written to be read.
   */
  if (err instanceof WorkspaceRequestError) {
    return res.status(err.status).json({ error: err.message });
  }

  /**
   * Postgres, answered in words rather than in the driver's.
   *
   * A driver error names the pooler's host and the database user, which is
   * the shape of the infrastructure and no use to the person who hit it. The
   * detail goes to the log; they get a sentence, and a 503 when the database
   * could not be reached, since that is worth retrying.
   */
  if (err instanceof DatabaseError) {
    logError('Database error:', err.cause);
    return err.unavailable
      ? res.status(503).json({ error: 'The database is unreachable right now. Try again in a moment.' })
      : res.status(500).json({ error: err.message });
  }

  /**
   * Anything else is a bug, and is logged in full here but not returned.
   *
   * The stack belongs in the daemon's log, where the person debugging can read
   * it. Putting it in the response only ever showed it to someone who cannot
   * act on it, in a toast, with the useful sentence buried in markup.
   */
  logError('Unhandled API error:', err);
  return res.status(500).json({ error: message || 'The daemon failed to handle that request.' });
}
