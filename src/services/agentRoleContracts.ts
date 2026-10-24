import type { OrchestrationTaskKind } from './orchestrationContract.js';

/** The product role contract. Persona text and approval choices cannot grant a capability. */
export const AGENT_ROLE_CONTRACTS = {
  research: { roles: ['researcher', 'research agent', 'triager'], tasks: ['requirements'], planner: true,
    trigger: 'Assign when repository or domain evidence is missing.',
    owns: 'Source-backed findings, facts versus assumptions, unknowns and risks.',
    excludes: 'Product decisions, architecture decisions, code edits and delegation.' },
  architecture: { roles: ['architect', 'architecture agent'], tasks: ['architecture'], planner: true,
    trigger: 'Assign when module boundaries, interfaces or data/API contracts need a design decision.',
    owns: 'Concrete designs and contracts grounded in approved requirements and repository evidence.',
    excludes: 'Inventing requirements, implementation, approvals and delegation.' },
  manager: { roles: ['manager agent'], tasks: ['requirements'], planner: true,
    trigger: 'Assign once when material requirements ambiguity needs a bounded brief, or requirements work is explicitly requested/configured.',
    owns: 'Observable product behavior, acceptance criteria, edge cases, constraints and explicit exclusions.',
    excludes: 'Architecture, implementation, agent selection, scheduling and delegation. Unresolved user decisions are blockers.' },
  orchestrator: { roles: ['orchestrator agent'], tasks: [], planner: true,
    trigger: 'Use as the preferred planning identity for initial builds and later milestones.',
    owns: 'The task graph, one specialist per task, dependency inputs, acceptance criteria and selection reasons. Alpha validates and dispatches.',
    excludes: 'Specialist implementation, direct dispatch, self-approval, publication and widening permissions.' },
  database: { roles: ['database agent'], tasks: ['database'], planner: false,
    trigger: 'Assign for schema, migrations, indexes, constraints, ORM mappings and data-access queries.',
    owns: 'The assigned data-layer files, compatibility and focused data-layer tests.',
    excludes: 'Server/API behavior, web/mobile UI, shared/production database access and unapproved destructive data changes.' },
  backend: { roles: ['backend agent'], tasks: ['backend'], planner: false,
    trigger: 'Assign for server logic, APIs, integrations and backend tests.',
    owns: 'The assigned server behavior and tests using supplied or accepted contracts.',
    excludes: 'Schema/migrations owned by Database, client UI, invented contracts and work outside assigned paths.' },
  frontend: { roles: ['frontend agent'], tasks: ['frontend'], planner: false,
    trigger: 'Assign for browser UI, web routes, accessibility, client integration and web tests.',
    owns: 'The assigned web client and its loading, empty, error and keyboard states.',
    excludes: 'Native mobile, backend/schema changes, invented API endpoints and unapproved dependencies.' },
  mobile: { roles: ['mobile agent'], tasks: ['mobile'], planner: false,
    trigger: 'Assign only when a React Native/Expo mobile client is part of the requested project scope.',
    owns: 'Assigned mobile screens, navigation, device states and mobile tests.',
    excludes: 'Web/server/data-layer changes and creating a mobile client absent from the approved scope.' },
  security: { roles: ['reviewer', 'security / code quality agent'], tasks: ['audit', 'review'], planner: false,
    trigger: 'Lead security/dependency audits before fixes when evidence is missing; independently review accepted changes and re-audit remediation.',
    owns: 'Independent task/security/code-quality assessment, real audit evidence, findings and remediation assessment. Specialists may self-audit within scope; the Orchestrator decides follow-up.',
    excludes: 'Editing code, reviewing its own implementation as independent, unsupported findings and style-only blockers.' },
  validation: { roles: ['qa tester', 'validation / checking agent'], tasks: ['validation'], planner: false,
    trigger: 'Assign when acceptance criteria need independent execution or observation beyond required automated checks.',
    owns: 'Criterion-by-criterion evidence, exact check results and reproducible failures.',
    excludes: 'Product fixes, changing/weakening tests, unrun pass claims and delegation.' },
  'github-finalization': { roles: ['devops', 'devops engineer', 'github finalization agent'], tasks: ['delivery'], planner: false,
    trigger: 'Assign for an explicitly useful, read-only delivery-readiness assessment.',
    owns: 'Branch, PR and CI readiness evidence and remaining blockers.',
    excludes: 'Push, PR mutation, merge, release, deployment and product-code edits. Alpha publishes only after human approval.' }
} as const;

export function agentRoleContract(role: string) {
  const normalized = role.trim().toLowerCase();
  return Object.values(AGENT_ROLE_CONTRACTS).find(contract => (contract.roles as readonly string[]).includes(normalized));
}

export function roleCanPlan(role: string): boolean {
  return agentRoleContract(role)?.planner === true;
}

export function roleCanOwnTask(kind: OrchestrationTaskKind, role: string): boolean {
  // Preserve the legacy generic implementation role without treating it as a planner.
  if (role.trim().toLowerCase() === 'coder') return isImplementationTask(kind);
  return (agentRoleContract(role)?.tasks as readonly string[] | undefined)?.includes(kind) ?? false;
}

export function isImplementationTask(kind: OrchestrationTaskKind): boolean {
  return ['database', 'backend', 'frontend', 'mobile'].includes(kind);
}
