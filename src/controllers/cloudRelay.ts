import { Request, Response } from 'express';

import { cloudRequest, usesCloudDirectory } from '../services/cloudWorkspaces.js';

export interface RelayOptions {
  /**
   * The cloud route to call, without `/api`. Defaults to this request's own
   * path -- right for a route that exists under the same name in the cloud.
   * A route whose local shape means nothing there (a desktop's project id,
   * for one) names the cloud route it stands for instead.
   */
  path?: string;
  /** Defaults to this request's body on a write, and none on a GET or DELETE. */
  body?: unknown;
  /** Raw bytes are reserved for the bounded, authenticated ticket-document upload path. */
  rawBody?: Uint8Array;
  /** Binary responses are reserved for authenticated ticket-document downloads. */
  responseType?: 'json' | 'bytes';
  /** Runs after a success, for the routes whose result this machine keeps a copy of. */
  mirror?: (body: any) => unknown;
  timeoutMs?: number;
  /** The workspace to act in, when it is not this request's own (an agent's run names its own). */
  workspaceId?: string;
  /** The cloud route's method, when it is not this request's own. */
  method?: string;
  /** Extra headers for the cloud, e.g. who a change is recorded as. */
  headers?: Record<string, string>;
}

/**
 * On a team's desktop, answer with the cloud's answer.
 *
 * Returns false when this is not a team desktop, and the route carries on
 * with its local answer. Otherwise the request goes to the cloud, signed in
 * as this desktop's GitHub account and in this request's workspace, and the
 * cloud's status and body come back unchanged -- so its permission checks
 * are the ones that count.
 *
 * The one way a desktop reaches a cloud-only capability. Every such route
 * goes through here, so how a forward is signed, scoped and reported when the
 * cloud cannot be reached is decided once.
 */
export async function relayToCloud(req: Request, res: Response, options: RelayOptions = {}): Promise<boolean> {
  if (!usesCloudDirectory()) return false;
  try {
    const method = options.method ?? req.method;
    const answer = await cloudRequest(options.path ?? req.originalUrl.replace(/^\/api(?=\/)/, ''), {
      method,
      body:
        options.body !== undefined
          ? options.body
          : options.rawBody !== undefined || method === 'GET' || method === 'DELETE'
            ? undefined
            : req.body,
      ...(options.rawBody !== undefined ? { rawBody: options.rawBody } : {}),
      ...(options.responseType ? { responseType: options.responseType } : {}),
      workspaceId: options.workspaceId ?? req.workspace?.workspaceId,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.headers ? { headers: options.headers } : {})
    });
    if (answer.status < 300 && options.mirror) await options.mirror(answer.body);
    if (options.responseType === 'bytes' && answer.status < 300) {
      if (!(answer.body instanceof Uint8Array)) {
        res.status(502).json({ error: 'The Alpha cloud returned an invalid document.' });
        return true;
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', answer.body.byteLength);
      res.setHeader('Content-Disposition', 'attachment; filename="ticket-document"');
      res.status(answer.status).end(Buffer.from(answer.body));
      return true;
    }
    res.status(answer.status).json(answer.body);
  } catch (err: any) {
    res.status(502).json({ error: `Could not reach the Alpha cloud: ${err?.message ?? err}` });
  }
  return true;
}
