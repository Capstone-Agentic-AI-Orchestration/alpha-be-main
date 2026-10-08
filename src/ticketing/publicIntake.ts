/** Public intake failures carry no provider/driver/request contents. */
export type PublicTicketIntakeFailure = 'entry_unavailable' | 'writes_disabled' | 'not_verified'
  | 'rate_limited' | 'operation_conflict' | 'outcome_unknown' | 'unavailable';
const failures = {
  entry_unavailable: { status: 404, error: 'This inquiry entry is unavailable.' },
  writes_disabled: { status: 503, error: 'Inquiry submission is unavailable right now.' },
  not_verified: { status: 403, error: 'Please verify this submission and try again.' },
  rate_limited: { status: 429, error: 'Too many submissions. Please try again later.' },
  operation_conflict: { status: 409, error: 'This submission ID was already used for different content. Start a new submission for different work.' },
  outcome_unknown: { status: 409, error: 'The submission outcome is uncertain. Retry using the same submission ID.' },
  unavailable: { status: 503, error: 'Inquiry submission is unavailable right now.' },
} as const;
export class PublicTicketIntakeError extends Error {
  constructor(readonly code: PublicTicketIntakeFailure, readonly retryAfterSeconds?: number) {
    super(failures[code].error); this.name = 'PublicTicketIntakeError';
  }
}

/** Server-observed request facts supplied by the future HTTP adapter, never
 * copied from JSON/body fields. The guard validates origin and HMACs the
 * address before producing a proof/rate key; it must not persist or log either.
 */
export interface PublicTicketIntakeRequestContext {
  origin: string | null;
  /** Resolved from the socket/trusted-proxy configuration, never raw X-Forwarded-For. */
  remoteAddress: string | null;
}

export function publicTicketIntakeErrorResponse(error: PublicTicketIntakeError) {
  // Do not reflect a runtime-mutated/untrusted code into the response body.
  const code = Object.prototype.hasOwnProperty.call(failures, error.code) ? error.code : 'unavailable';
  const failure = failures[code];
  const retry = code === 'rate_limited' && Number.isSafeInteger(error.retryAfterSeconds)
    && error.retryAfterSeconds! > 0 && error.retryAfterSeconds! <= 86400 ? error.retryAfterSeconds : null;
  return { status: failure.status, body: { error: failure.error, code: `ticket_intake_${code}` }, retryAfterSeconds: retry };
}
export interface PublicTicketInquiryAcknowledgement { received: true }
