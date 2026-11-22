/**
 * An expected refusal: the request was understood and Alpha decided not to do it, for a reason
 * the person can act on. The API answers it with 409 and a structured body (what went wrong and
 * which next steps fit), so the app can show a reason with buttons instead of a raw error.
 * Anything that is not a DomainRefusal (and matches no older message rule) is an unexpected
 * failure: a 500, logged as a bug.
 */
export type RefusalAction = 'ask_orchestrator' | 'stop_plan' | 'open_plan' | 'retry';

export interface RefusalIssue { code: string; detail: string }

export class DomainRefusal extends Error {
  constructor(message: string, readonly code: string, readonly actions: RefusalAction[] = [], readonly issues: RefusalIssue[] = []) {
    super(message);
    this.name = 'DomainRefusal';
  }

  toBody() {
    return { error: this.message, code: this.code, actions: this.actions, ...(this.issues.length ? { issues: this.issues } : {}) };
  }
}

/** A plan that could not start or change even after the Orchestrator's one correction: the person decides. */
export class PlanNeedsYouError extends DomainRefusal {
  constructor(message: string, issues: RefusalIssue[] = [], actions: RefusalAction[] = ['ask_orchestrator', 'open_plan', 'stop_plan']) {
    super(message, 'plan_needs_you', actions, issues);
    this.name = 'PlanNeedsYouError';
  }
}

/**
 * What to tell a person about a failed action. A refusal, or an error written as a sentence for
 * people, is shown as it is. A programming or system error (a TypeError, a SQLite or Node error
 * code, an "undefined") is not: the person gets a plain sentence and the detail is logged, since
 * they cannot act on it and it reads as a dead end.
 */
export function reasonForPerson(error: unknown, fallback = 'Something went wrong on Alpha\'s side. It was logged; try again, or tell the Orchestrator what to do.'): { text: string; unexpected: boolean } {
  if (error instanceof DomainRefusal) return { text: error.message, unexpected: false };
  const message = error instanceof Error ? error.message.trim() : '';
  const technical = !message || (error instanceof Error && ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error.name)) ||
    /\bundefined\b|is not a function|cannot read propert/i.test(message) || message.includes('\n    at ') ||
    /\bSQLITE_[A-Z]+\b|\bE(?:NOENT|ACCES|PERM|BUSY|EXIST|NOTDIR|ISDIR|CONNREFUSED|CONNRESET|TIMEDOUT|PIPE|NOSPC)\b/.test(message);
  return technical ? { text: fallback, unexpected: true } : { text: message, unexpected: false };
}
