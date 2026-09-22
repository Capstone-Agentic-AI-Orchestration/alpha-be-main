import { randomUUID } from 'node:crypto';

import type { BuildStepPhase, ProjectBuildStep } from '../models/index.js';

/** A build step list that cannot be saved, for a reason the caller can fix. */
export class BuildStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildStepError';
  }
}

const PHASES = new Set<BuildStepPhase>([
  'requirements', 'architecture', 'implementation', 'database',
  'validation', 'review', 'delivery'
]);

/**
 * A project's build steps as they will be stored, or the reason they cannot be.
 *
 * One definition for both stores, so a list the desktop accepts is a list the
 * cloud accepts. Positions come from the order sent; an id repeated in one list
 * is replaced rather than letting the second step overwrite the first.
 *
 * `agentIds` and `squadIds` are this workspace's: a step may name only an agent
 * or squad the workspace has.
 */
export function normalizeBuildSteps(
  projectId: string,
  input: unknown,
  agentIds: ReadonlySet<string>,
  squadIds: ReadonlySet<string>,
  now = new Date().toISOString()
): ProjectBuildStep[] {
  if (!Array.isArray(input)) throw new BuildStepError('steps must be an array');

  const seenIds = new Set<string>();
  return input.map((raw: Partial<ProjectBuildStep>, index) => {
    const label = String(raw?.label ?? '').trim();
    if (!label) throw new BuildStepError(`Build step ${index + 1} needs a label`);

    const phase = String(raw.phase ?? 'implementation') as BuildStepPhase;
    if (!PHASES.has(phase)) throw new BuildStepError(`Unsupported build step phase: ${phase}`);

    const agentId = typeof raw.agentId === 'string' && raw.agentId ? raw.agentId : undefined;
    const squadId = typeof raw.squadId === 'string' && raw.squadId ? raw.squadId : undefined;
    if (agentId && squadId) throw new BuildStepError(`Build step ${index + 1} cannot target both an agent and a squad`);
    if (agentId && !agentIds.has(agentId)) throw new BuildStepError(`Agent not found for build step ${index + 1}`);
    if (squadId && !squadIds.has(squadId)) throw new BuildStepError(`Squad not found for build step ${index + 1}`);

    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `build-step-${randomUUID()}`;
    if (seenIds.has(id)) id = `build-step-${randomUUID()}`;
    seenIds.add(id);

    const dependsOn = Array.isArray(raw.dependsOn)
      ? raw.dependsOn.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];

    return {
      id,
      projectId,
      label,
      phase,
      agentId,
      squadId,
      position: index,
      enabled: raw.enabled !== false,
      required: raw.required !== false,
      approvalGate: raw.approvalGate === true,
      dependsOn,
      createdAt: now,
      updatedAt: now
    } satisfies ProjectBuildStep;
  });
}
