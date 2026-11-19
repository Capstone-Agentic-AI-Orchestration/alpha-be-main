import { z } from 'zod';
import type { Project } from '../models/index.js';
import type { TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import { TicketWorkflowError } from '../ticketing/workflow.js';

/**
 * Start a project from an inquiry, in one PM action.
 *
 * Before this, accepting an inquiry only opened a request; the PM then created the
 * project on another screen and linked it on a third, and the client saw nothing
 * until the last step. This runs the same three steps the PM did by hand:
 *
 * 1. accept the inquiry, which opens the request and gives a verified client access;
 * 2. create the project (or use an existing one the PM picked);
 * 3. link the request to the project, visible to the client if asked.
 *
 * Every step is safe to repeat with the same operation ID, so a retry after a
 * dropped response finishes the job instead of doing any of it twice:
 * accepting is idempotent per operation, a new project has a fixed id per inquiry,
 * and the link is saved against the same operation.
 */

export interface IntakeProjectStartDeps {
  accept(intakeId: string, workspaceId: string, subject: TicketSubject, raw: unknown): Promise<{ ticketId: string; workspaceId: string; reference: string }>;
  link: {
    linkProjectAtCurrentVersion(target: TicketTarget, subject: TicketSubject,
      input: { operationId: string; projectId: string; clientVisible: boolean }): Promise<{ projectId: string | null; projectName: string | null; clientVisible: boolean }>;
  };
  projects: {
    get(workspaceId: string, id: string): Promise<Project | null>;
    create(workspaceId: string, input: Partial<Project>): Promise<Project>;
  };
  /** Record a new project in this workspace (a no-op in the cloud, where the row carries it). */
  bindProject(projectId: string, workspaceId: string): void | Promise<void>;
}

export interface IntakeProjectStartReceipt {
  ticketId: string; reference: string; projectId: string; projectName: string; projectKey: string;
  /** False when a retry found the project this inquiry already started, or the PM picked an existing one. */
  created: boolean; clientVisible: boolean;
}

const date = /^\d{4}-\d{2}-\d{2}$/;
const schema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  clientVisible: z.boolean(),
  project: z.union([
    z.object({ existingProjectId: z.string().min(1).max(200).refine(value => value.trim() === value) }).strict(),
    z.object({
      name: z.string().trim().min(1).max(120),
      key: z.string().regex(/^[A-Z0-9]{1,5}$/).optional(),
      description: z.string().max(8000).optional(),
      targetDate: z.string().regex(date).optional(),
    }).strict(),
  ]),
}).strict();

/** The project an inquiry starts always gets this id, which is what makes a retry find it. */
export const intakeProjectId = (intakeId: string) => `proj-intake-${intakeId}`;

/** The same rule as the project form: the first three letters, then a number when taken. */
export function projectKeyCandidates(name: string, preferred?: string): string[] {
  const base = preferred ?? (name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'PRJ');
  const stem = base.slice(0, 3);
  return [base, ...Array.from({ length: 98 }, (_, index) => `${stem}${index + 2}`)].filter((key, index, all) => all.indexOf(key) === index);
}

function uniqueViolation(error: unknown): 'key' | 'id' | null {
  // The database layer wraps driver errors; the duplicate-key code is on the original.
  const raw = error as { code?: unknown; cause?: unknown; pgError?: unknown } | null;
  const value = (raw && raw.code === '23505' ? raw : (raw?.cause ?? raw?.pgError)) as
    { code?: unknown; constraint?: unknown; detail?: unknown; message?: unknown } | null | undefined;
  if (!value || value.code !== '23505') return null;
  const where = `${String(value.constraint ?? '')} ${String(value.detail ?? '')} ${String(value.message ?? '')}`;
  if (/\bkey\b|_key_key|\(key\)/.test(where)) return 'key';
  return 'id';
}

export function createIntakeProjectStarter(deps: IntakeProjectStartDeps) {
  async function createProject(workspaceId: string, subject: TicketSubject, intakeId: string,
    input: { name: string; key?: string; description?: string; targetDate?: string }): Promise<{ project: Project; created: boolean }> {
    const id = intakeProjectId(intakeId);
    const existing = await deps.projects.get(workspaceId, id);
    if (existing) return { project: existing, created: false };
    for (const key of projectKeyCandidates(input.name, input.key)) {
      const outcome = await tryCreate(workspaceId, id, key, subject, input);
      if (outcome !== 'key_taken') return outcome;
    }
    throw new TicketWorkflowError(409, 'project_key_taken', 'Every project key for that name is taken. Choose a different project name.');
  }

  /** One attempt with one key: the project, or that the key is taken. */
  async function tryCreate(workspaceId: string, id: string, key: string, subject: TicketSubject,
    input: { name: string; description?: string; targetDate?: string }): Promise<{ project: Project; created: boolean } | 'key_taken'> {
    try {
      const project = await deps.projects.create(workspaceId, {
        id, name: input.name, key, description: input.description ?? '', targetDate: input.targetDate ?? '',
        status: 'planned', priority: 'medium', leadType: 'agent', leadName: 'Orchestrator', resources: [],
        createdBy: subject.kind === 'internal' ? subject.userId : undefined,
      });
      await deps.bindProject(project.id, workspaceId);
      return { project, created: true };
    } catch (error) {
      const clash = uniqueViolation(error);
      if (clash === 'key') return 'key_taken';
      // Another attempt with this operation got there first: use its project.
      const raced = clash === 'id' ? await deps.projects.get(workspaceId, id) : null;
      if (raced) return { project: raced, created: false };
      throw error;
    }
  }

  return {
    async startProject(intakeId: string, workspaceId: string, subject: TicketSubject, raw: unknown): Promise<IntakeProjectStartReceipt> {
      if (subject.kind !== 'internal') throw new TicketWorkflowError(403, 'ticket_action_forbidden', 'Only a project manager can start a project from an inquiry.');
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new TicketWorkflowError(400, 'intake_project_invalid', 'Give the project a name, or choose an existing project.');
      const { operationId, clientVisible, project: requested } = parsed.data;

      // A wrong existing project is refused before anything changes: the inquiry stays open.
      const existing = 'existingProjectId' in requested ? await deps.projects.get(workspaceId, requested.existingProjectId) : null;
      if ('existingProjectId' in requested && !existing) {
        throw new TicketWorkflowError(404, 'ticket_project_not_found', 'Project not found in this workspace.');
      }

      const accepted = await deps.accept(intakeId, workspaceId, subject, { schemaVersion: 1, operationId });
      if (accepted.workspaceId !== workspaceId) throw new TicketWorkflowError(409, 'central_intake_already_handled', 'This inquiry was accepted into a different workspace.');

      let project: Project; let created = false;
      if (existing) project = existing;
      else if ('name' in requested) ({ project, created } = await createProject(workspaceId, subject, intakeId, requested));
      else throw new TicketWorkflowError(400, 'intake_project_invalid', 'Give the project a name, or choose an existing project.');

      const link = await deps.link.linkProjectAtCurrentVersion({ workspaceId, ticketId: accepted.ticketId }, subject,
        { operationId, projectId: project.id, clientVisible });
      return { ticketId: accepted.ticketId, reference: accepted.reference, projectId: project.id,
        projectName: link.projectName ?? project.name, projectKey: project.key, created, clientVisible: link.clientVisible };
    },
  };
}
