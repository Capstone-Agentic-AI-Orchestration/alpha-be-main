import { availableTemplates, productTemplateFor } from './ciWorkflows.js';
import {
  BACKEND_STACKS,
  FRONTEND_STACKS,
  MONOREPO_BACKEND_STACKS,
  MONOREPO_FRONTEND_STACKS,
  STACK_LABELS,
  SUPPORTED_STACKS,
  type CanonicalStack
} from './scaffoldBuilder.js';

/**
 * What the create-repository form may offer, per repository shape.
 *
 * A stack is offered when Alpha can scaffold it, host it, and the configured
 * workflow library has the CI caller that shape writes for it. The library is
 * asked rather than assumed, so a server pinned to a library ref without
 * monorepo callers does not offer a monorepo that would then fail to create.
 */
export interface StackOption {
  id: CanonicalStack;
  label: string;
  role: 'frontend' | 'backend';
}

export interface ScaffoldOptions {
  /** `owner/repo@ref` of the workflow library asked, or null when none is configured. */
  source: string | null;
  standalone: StackOption[];
  paired: { frontend: StackOption[]; backend: StackOption[] };
  monorepo: { frontend: StackOption[]; backend: StackOption[] };
  /** Why nothing (or less than usual) is offered. */
  error?: string;
}

const CACHE_MS = 5 * 60_000;
let cached: { at: number; value: ScaffoldOptions } | null = null;

function option(id: CanonicalStack): StackOption {
  return { id, label: STACK_LABELS[id], role: FRONTEND_STACKS.includes(id) ? 'frontend' : 'backend' };
}

/** Why less than usual is offered: no templates read at all, or none for a monorepo. */
function optionsError(source: string, found: number, monorepo: ScaffoldOptions['monorepo']): string | undefined {
  if (found === 0) return `Could not read the CI templates from ${source}.`;
  if (!monorepo.frontend.length || !monorepo.backend.length) {
    return `${source} has no monorepo CI templates yet, so monorepos cannot be created.`;
  }
  return undefined;
}

export async function getScaffoldOptions(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<ScaffoldOptions> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;

  const single = new Map(SUPPORTED_STACKS.map(stack => [stack, productTemplateFor(stack, 'single')]));
  const mono = new Map(
    [...MONOREPO_FRONTEND_STACKS, ...MONOREPO_BACKEND_STACKS].map(stack => [stack, productTemplateFor(stack, 'monorepo')])
  );
  let value: ScaffoldOptions;
  try {
    const { source, found } = await availableTemplates([...single.values(), ...mono.values()], fetchImpl);
    const has = (templates: Map<CanonicalStack, string>, stacks: CanonicalStack[]) =>
      stacks.filter(stack => found.has(templates.get(stack)!)).map(option);
    const monorepo = { frontend: has(mono, MONOREPO_FRONTEND_STACKS), backend: has(mono, MONOREPO_BACKEND_STACKS) };
    const error = optionsError(source, found.size, monorepo);
    value = {
      source,
      standalone: has(single, SUPPORTED_STACKS),
      paired: { frontend: has(single, FRONTEND_STACKS), backend: has(single, BACKEND_STACKS) },
      monorepo,
      ...(error ? { error } : {})
    };
  } catch (err) {
    value = {
      source: null,
      standalone: [],
      paired: { frontend: [], backend: [] },
      monorepo: { frontend: [], backend: [] },
      error: (err as Error).message
    };
  }
  // A failed read is retried on the next request instead of being remembered.
  if (!value.error || value.standalone.length) cached = { at: now, value };
  return value;
}

/** For tests. */
export function clearScaffoldOptionsCache(): void {
  cached = null;
}
