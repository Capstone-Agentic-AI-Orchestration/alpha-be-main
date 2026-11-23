/**
 * Scripted planner output for tests: a plan as a planner that did its required fit check returns
 * it (planFitCheck.ts), with every task, and each card named, marked as fitting the product. Tests
 * about the fit check itself build their fitCheck by hand instead.
 */
export function fitted<P>(plan: P, cards: readonly string[] = []): P {
  const tasks = (plan as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return plan;
  const taskEntries = tasks
    .map(task => (task as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string')
    .map(id => ({ subject: id, subjectType: 'task', verdict: 'fits', reason: 'Serves the requested goal; nothing recorded conflicts.' }));
  const cardEntries = cards.map(key => ({ subject: key, subjectType: 'card', verdict: 'fits', reason: 'The card asks for work the brief supports.' }));
  return { ...plan, fitCheck: [...taskEntries, ...cardEntries] };
}

/** The JSON a scripted planner turn returns for `fitted(plan)`. */
export function plannedJson(plan: unknown, cards: readonly string[] = []): string {
  return JSON.stringify(fitted(plan, cards));
}
