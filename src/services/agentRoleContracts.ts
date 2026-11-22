import type { AgentRole } from '../models/index.js';
import type { OrchestrationTaskKind } from './orchestrationContract.js';

/**
 * The product role contract. Persona text and approval choices cannot grant a capability.
 *
 * A contract describes what a role may own. Which contract an agent gets is decided by
 * ROLE_CAPABILITIES below, from the agent's typed role, never from its name, description
 * or anything a model writes.
 */
export const AGENT_ROLE_CONTRACTS = {
  research: { tasks: ['requirements'], planner: true,
    trigger: 'Assign when repository or domain evidence is missing.',
    owns: 'Source-backed findings, facts versus assumptions, unknowns and risks.',
    excludes: 'Product decisions, architecture decisions, code edits and delegation.' },
  architecture: { tasks: ['architecture'], planner: true,
    trigger: 'Assign when module boundaries, interfaces or data/API contracts need a design decision.',
    owns: 'Concrete designs and contracts grounded in approved requirements and repository evidence.',
    excludes: 'Inventing requirements, implementation, approvals and delegation.' },
  manager: { tasks: ['requirements'], planner: true,
    trigger: 'Assign once when material requirements ambiguity needs a bounded brief, or requirements work is explicitly requested/configured.',
    owns: 'Observable product behavior, acceptance criteria, edge cases, constraints and explicit exclusions.',
    excludes: 'Architecture, implementation, agent selection, scheduling and delegation. Unresolved user decisions are blockers.' },
  orchestrator: { tasks: [], planner: true,
    trigger: 'Use as the preferred planning identity for initial builds and later milestones.',
    owns: 'The task graph, one specialist per task, dependency inputs, acceptance criteria and selection reasons. Alpha validates and dispatches.',
    excludes: 'Specialist implementation, direct dispatch, self-approval, publication and widening permissions.' },
  database: { tasks: ['database'], planner: false,
    trigger: 'Assign for schema, migrations, indexes, constraints, ORM mappings and data-access queries.',
    owns: 'The assigned data-layer files, compatibility and focused data-layer tests.',
    excludes: 'Server/API behavior, web/mobile UI, shared/production database access and unapproved destructive data changes.' },
  backend: { tasks: ['backend'], planner: false,
    trigger: 'Assign for server logic, APIs, integrations and backend tests.',
    owns: 'The assigned server behavior and tests using supplied or accepted contracts.',
    excludes: 'Schema/migrations owned by Database, client UI, invented contracts and work outside assigned paths.' },
  frontend: { tasks: ['frontend'], planner: false,
    trigger: 'Assign for browser UI, web routes, accessibility, client integration and web tests.',
    owns: 'The assigned web client and its loading, empty, error and keyboard states.',
    excludes: 'Native mobile, backend/schema changes, invented API endpoints and unapproved dependencies.' },
  mobile: { tasks: ['mobile'], planner: false,
    trigger: 'Assign only when a React Native/Expo mobile client is part of the requested project scope.',
    owns: 'Assigned mobile screens, navigation, device states and mobile tests.',
    excludes: 'Web/server/data-layer changes and creating a mobile client absent from the approved scope.' },
  security: { tasks: ['audit', 'review'], planner: false,
    trigger: 'Lead security/dependency audits before fixes when evidence is missing; independently review accepted changes and re-audit remediation.',
    owns: 'Independent task/security/code-quality assessment, real audit evidence, findings and remediation assessment. Specialists may self-audit within scope; the Orchestrator decides follow-up.',
    excludes: 'Editing code, reviewing its own implementation as independent, unsupported findings and style-only blockers.' },
  validation: { tasks: ['validation'], planner: false,
    trigger: 'Assign when acceptance criteria need independent execution or observation beyond required automated checks.',
    owns: 'Criterion-by-criterion evidence, exact check results and reproducible failures.',
    excludes: 'Product fixes, changing/weakening tests, unrun pass claims and delegation.' },
  'github-finalization': { tasks: ['delivery'], planner: false,
    trigger: 'Assign for an explicitly useful, read-only delivery-readiness assessment.',
    owns: 'Branch, PR and CI readiness evidence and remaining blockers.',
    excludes: 'Push, PR mutation, merge, release, deployment and product-code edits. Alpha publishes only after human approval.' }
} as const;

export type RoleContractKey = keyof typeof AGENT_ROLE_CONTRACTS;

/**
 * Every selectable role and the one capability set it receives.
 *
 * Exhaustive over AgentRole, so adding a role without deciding its capabilities fails
 * to compile. `coder` is the legacy generic implementer: it may own implementation
 * tasks but has no contract, so it never plans and gets no contract-gated file access.
 */
export const ROLE_CAPABILITIES: Readonly<Record<AgentRole, RoleContractKey | 'coder'>> = {
  'Architect': 'architecture',
  'Coder': 'coder',
  'Reviewer': 'security',
  'QA Tester': 'validation',
  'DevOps': 'github-finalization',
  'DevOps Engineer': 'github-finalization',
  'Triager': 'research',
  'Researcher': 'research',
  'Research Agent': 'research',
  'Architecture Agent': 'architecture',
  'Manager Agent': 'manager',
  'Orchestrator Agent': 'orchestrator',
  'Database Agent': 'database',
  'Backend Agent': 'backend',
  'Frontend Agent': 'frontend',
  'Mobile Agent': 'mobile',
  'Security / Code Quality Agent': 'security',
  'Validation / Checking Agent': 'validation',
  'GitHub Finalization Agent': 'github-finalization'
};

// Stored rows predate strict casing, so the lookup ignores case and surrounding space.
const capabilityByRole = new Map(
  Object.entries(ROLE_CAPABILITIES).map(([role, capability]) => [role.toLowerCase(), capability])
);

function roleCapability(role: string): RoleContractKey | 'coder' | undefined {
  return capabilityByRole.get(role.trim().toLowerCase());
}

/** The contract for a role, or undefined for the legacy Coder and for any role Alpha does not define. */
export function agentRoleContract(role: string) {
  const capability = roleCapability(role);
  return capability && capability !== 'coder' ? AGENT_ROLE_CONTRACTS[capability] : undefined;
}

export function roleCanPlan(role: string): boolean {
  return agentRoleContract(role)?.planner === true;
}

export function roleCanOwnTask(kind: OrchestrationTaskKind, role: string): boolean {
  if (roleCapability(role) === 'coder') return isImplementationTask(kind);
  return (agentRoleContract(role)?.tasks as readonly string[] | undefined)?.includes(kind) ?? false;
}

/** The task kinds that change code. Use isImplementationTask, never a local copy of this list. */
const IMPLEMENTATION_TASK_KINDS: ReadonlySet<string> = new Set(['database', 'backend', 'frontend', 'mobile']);

export function isImplementationTask(kind: string): boolean {
  return IMPLEMENTATION_TASK_KINDS.has(kind);
}
