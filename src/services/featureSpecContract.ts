import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Issue, IssueSubtask } from '../models/index.js';
import type { OrchestrationPlan } from './orchestrationContract.js';

/**
 * A feature spec: who a change is for, how they will use it, and the checklist
 * that says when it is done.
 *
 * The Manager Agent drafts it on a task card, a person edits and approves it,
 * and an approved spec's requirements reach the planner fixed, so every
 * specialist works toward the same goal and the Validation agent checks the
 * same list. Stored locally on the desktop that builds the task; the card's
 * checklist items are the only part shared with the team.
 */
const shortText = z.string().trim().min(1).max(240);
const detailText = z.string().trim().min(1).max(2_000);
const specId = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Use letters, numbers, dots, dashes or colons for IDs.');

export const MAX_SPEC_REQUIREMENTS = 20;
export const MAX_SPEC_REQUEST_CHARS = 4_000;
export const MAX_SPEC_REVISION_CHARS = 2_000;

export const featureSpecSchema = z.object({
  schemaVersion: z.literal(1),
  epicTitle: shortText,
  summary: detailText,
  personas: z.array(z.object({ id: specId, name: shortText, goal: detailText }).strict()).min(1).max(6),
  journeys: z.array(z.object({
    id: specId,
    personaId: specId,
    title: shortText,
    steps: z.array(shortText).min(1).max(12)
  }).strict()).min(1).max(10),
  requirements: z.array(z.object({
    id: specId,
    behavior: detailText,
    acceptanceCriteria: z.array(detailText).min(1).max(8),
    journeyIds: z.array(specId).max(10)
  }).strict()).min(1).max(MAX_SPEC_REQUIREMENTS),
  exclusions: z.array(shortText).max(20),
  openQuestions: z.array(shortText).max(10)
}).strict().superRefine((spec, ctx) => {
  const unique = (label: string, ids: string[]) => {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} IDs must be unique.` });
  };
  unique('Persona', spec.personas.map(item => item.id));
  unique('Journey', spec.journeys.map(item => item.id));
  unique('Requirement', spec.requirements.map(item => item.id));
  const personas = new Set(spec.personas.map(item => item.id));
  const journeys = new Set(spec.journeys.map(item => item.id));
  for (const journey of spec.journeys) {
    if (!personas.has(journey.personaId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Journey ${journey.id} names an unknown persona.` });
  }
  for (const requirement of spec.requirements) {
    if (requirement.journeyIds.some(id => !journeys.has(id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Requirement ${requirement.id} names an unknown journey.` });
    }
  }
});
export type FeatureSpec = z.infer<typeof featureSpecSchema>;

export const systemProposalSchema = z.object({
  schemaVersion: z.literal(1),
  epics: z.array(z.object({
    title: shortText,
    outcome: detailText,
    personas: z.array(shortText).min(1).max(6)
  }).strict()).min(1).max(8)
}).strict();
export type SystemProposal = z.infer<typeof systemProposalSchema>;

const stringArray = (maxItems: number) => ({ type: 'array', maxItems, items: { type: 'string' } });
const object = (properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties
});

/** Structured-output schema for the spec turn. Every field is required, as strict structured output demands. */
export const featureSpecJsonSchema = object({
  schemaVersion: { type: 'integer', enum: [1] },
  epicTitle: { type: 'string' },
  summary: { type: 'string' },
  personas: { type: 'array', minItems: 1, maxItems: 6, items: object({ id: { type: 'string' }, name: { type: 'string' }, goal: { type: 'string' } }) },
  journeys: { type: 'array', minItems: 1, maxItems: 10, items: object({ id: { type: 'string' }, personaId: { type: 'string' }, title: { type: 'string' }, steps: stringArray(12) }) },
  requirements: { type: 'array', minItems: 1, maxItems: MAX_SPEC_REQUIREMENTS, items: object({ id: { type: 'string' }, behavior: { type: 'string' }, acceptanceCriteria: stringArray(8), journeyIds: stringArray(10) }) },
  exclusions: stringArray(20),
  openQuestions: stringArray(10)
});

export const systemProposalJsonSchema = object({
  schemaVersion: { type: 'integer', enum: [1] },
  epics: { type: 'array', minItems: 1, maxItems: 8, items: object({ title: { type: 'string' }, outcome: { type: 'string' }, personas: stringArray(6) }) }
});

/** A task's saved spec. Local to the desktop that drafts and builds it. */
export interface FeatureSpecRecord {
  issueId: string;
  /** Increments on every save; callers send the version they read. */
  version: number;
  status: 'draft' | 'approved';
  spec: FeatureSpec;
  /** featureSpecSourceHash of the task when the spec was approved. */
  sourceHash: string;
  updatedBy: string;
  approvedBy?: string;
  approvedAt?: string;
  updatedAt: string;
}


export class FeatureSpecError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = 'FeatureSpecError';
  }
}

/** Parse a spec from a person or a model, with one readable reason when it is invalid. */
export function parseFeatureSpec(value: unknown): FeatureSpec {
  const parsed = featureSpecSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` (${first.path.join('.')})` : '';
    throw new FeatureSpecError(`The feature spec is not valid${where}: ${first?.message ?? 'unknown problem'}`, 400);
  }
  return parsed.data;
}

/** What the spec was approved against. Editing the task's title or description makes it stale. */
export function featureSpecSourceHash(issue: Pick<Issue, 'title' | 'description'>): string {
  return createHash('sha256').update(`${issue.title.trim()}\u0000${(issue.description ?? '').trim()}`).digest('hex');
}

/** The approved requirements, in the planner's shape, with their acceptance criteria written in. */
export function plannerRequirementsFromSpec(spec: FeatureSpec): OrchestrationPlan['requirements'] {
  return spec.requirements.map(requirement => ({
    id: requirement.id,
    description: `${requirement.behavior} Acceptance: ${requirement.acceptanceCriteria.map((item, index) => `(${index + 1}) ${item}`).join(' ')}`.slice(0, 4_000)
  }));
}

/** Who the build serves and how they will use it, for the planner's goal. */
export function specPlanningBrief(spec: FeatureSpec): string {
  const personas = new Map(spec.personas.map(persona => [persona.id, persona]));
  const lines = [
    `Approved feature spec: ${spec.epicTitle}`,
    spec.summary,
    'Personas:',
    ...spec.personas.map(persona => `- ${persona.name}: ${persona.goal}`),
    'User journeys:',
    ...spec.journeys.map(journey => `- ${journey.title} (${personas.get(journey.personaId)?.name ?? journey.personaId}): ${journey.steps.join(' -> ')}`)
  ];
  return lines.join('\n').slice(0, 3_000);
}

/**
 * The task's checklist after approval: one item per approved requirement,
 * followed by every item a person added. Earlier spec items are replaced, so
 * re-approving a revised spec does not leave stale requirements behind.
 */
export function checklistFromSpec(spec: FeatureSpec, current: readonly IssueSubtask[]): IssueSubtask[] {
  const human = current.filter(item => item.source !== 'spec');
  const previous = new Map(current.filter(item => item.source === 'spec' && item.requirementId).map(item => [item.requirementId!, item]));
  const fromSpec = spec.requirements.map(requirement => {
    const title = `${requirement.id}: ${requirement.behavior}`;
    return {
      id: `spec-${requirement.id}`,
      title: title.length > 140 ? `${title.slice(0, 137)}...` : title,
      completed: previous.get(requirement.id)?.completed ?? false,
      source: 'spec' as const,
      requirementId: requirement.id
    };
  });
  return [...fromSpec, ...human];
}

