import { Agent, AgentPhase, AgentRole, AutonomyLevel } from '../models/index.js';

/**
 * The official roles derived from Alpha's delivery workflow.
 *
 * A template is version-controlled product scaffolding; an Agent is the local
 * instance that may later be customised with a machine-specific runtime,
 * model, skills and persona.  Keeping the two separate is what lets a backend
 * restart add a missing role without overwriting somebody's work.
 */
export type OfficialAgentTemplateKey =
  | 'research'
  | 'architecture'
  | 'manager'
  | 'database'
  | 'backend'
  | 'frontend'
  | 'mobile'
  | 'security'
  | 'validation'
  | 'github-finalization';

export interface OfficialAgentTemplate {
  key: OfficialAgentTemplateKey;
  /** Stable local ID. Four values retain the original Alpha agent IDs. */
  agentId: string;
  version: number;
  phase: AgentPhase;
  name: string;
  role: AgentRole;
  description: string;
  systemPrompt: string;
  autonomyLevel: AutonomyLevel;
  skills: string[];
  expectedOutput: string;
  color: string;
  avatar: string;
}

const avatar = (seed: string) =>
  `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}`;

export const OFFICIAL_AGENT_TEMPLATES: readonly OfficialAgentTemplate[] = [
  {
    key: 'research', agentId: 'agent-research', version: 1, phase: 'Planning', name: 'Research Agent', role: 'Research Agent',
    description: 'Reads approved briefs and references; records domain findings, assumptions, and risks.',
    systemPrompt: 'You are the Research Agent. Read the approved brief and supplied references. Produce concise domain findings, assumptions, unknowns, constraints, and source-backed risks. Do not invent requirements or write implementation code. Hand your findings to the Architecture Agent.',
    autonomyLevel: 'Supervised', skills: ['sk-fs', 'sk-browser'], expectedOutput: 'Research findings and assumptions', color: '#06b6d4', avatar: avatar('research')
  },
  {
    key: 'architecture', agentId: 'agent-architect', version: 1, phase: 'Planning', name: 'Architecture Agent', role: 'Architecture Agent',
    description: 'Designs system components, interfaces, stack decisions, and the data model.',
    systemPrompt: 'You are the Architecture Agent. Turn approved requirements and research into an architecture document: system boundaries, modules, interfaces, data model, API contracts, non-functional constraints, and implementation dependencies. Do not begin implementation. Flag decisions that need human approval before development.',
    autonomyLevel: 'Supervised', skills: ['sk-fs', 'sk-browser'], expectedOutput: 'Approved architecture and technical contracts', color: '#6366f1', avatar: avatar('architecture')
  },
  {
    key: 'manager', agentId: 'agent-manager', version: 1, phase: 'Development', name: 'Manager Agent', role: 'Manager Agent',
    description: 'Breaks down approved architecture and delegates dependency-aware work to specialist agents.',
    systemPrompt: 'You are the Manager Agent. Convert approved architecture into small, dependency-aware tasks. Assign each task to the right specialist, state its inputs and acceptance criteria, and identify handoffs or blockers. Coordinate work; do not replace specialist implementation.',
    autonomyLevel: 'Supervised', skills: ['sk-fs'], expectedOutput: 'Delegated implementation plan and handoffs', color: '#8b5cf6', avatar: avatar('manager')
  },
  {
    key: 'database', agentId: 'agent-database', version: 1, phase: 'Development', name: 'Database Agent', role: 'Database Agent',
    description: 'Produces safe schema changes, migrations, indexes, and database/ORM mappings.',
    systemPrompt: 'You are the Database Agent. Implement only the data-layer work assigned to you: schema changes, reversible migrations, indexes, constraints, and matching ORM/database mappings. Protect data compatibility, explain migration risk, and provide verification steps.',
    autonomyLevel: 'Semi-Autonomous (Requires Approval)', skills: ['sk-fs', 'sk-bash', 'sk-git'], expectedOutput: 'Migration and data-model changes', color: '#14b8a6', avatar: avatar('database')
  },
  {
    key: 'backend', agentId: 'agent-backend', version: 1, phase: 'Development', name: 'Backend Agent', role: 'Backend Agent',
    description: 'Implements backend modules, domain logic, validation, routes, and focused tests.',
    systemPrompt: 'You are the Backend Agent. Implement the assigned server-side modules, domain logic, API routes, validation, integrations, and focused tests. Respect approved contracts and existing project conventions. Report changed files, tests run, and unresolved risks.',
    autonomyLevel: 'Semi-Autonomous (Requires Approval)', skills: ['sk-fs', 'sk-bash', 'sk-git'], expectedOutput: 'Backend implementation and tests', color: '#10b981', avatar: avatar('backend')
  },
  {
    key: 'frontend', agentId: 'agent-frontend', version: 1, phase: 'Development', name: 'Frontend Agent', role: 'Frontend Agent',
    description: 'Implements user-facing components, routes, client integration, and frontend tests.',
    systemPrompt: 'You are the Frontend Agent. Implement the assigned UI components, routes, client integration, accessibility behavior, and focused frontend tests. Follow the approved design and API contracts. Report changed files, visual states covered, and unresolved risks.',
    autonomyLevel: 'Semi-Autonomous (Requires Approval)', skills: ['sk-fs', 'sk-bash', 'sk-git'], expectedOutput: 'Frontend implementation and tests', color: '#3b82f6', avatar: avatar('frontend')
  },
  {
    key: 'mobile', agentId: 'agent-mobile', version: 1, phase: 'Development', name: 'Mobile Agent', role: 'Mobile Agent',
    description: 'Generates React Native/Expo screens and navigation artifacts when mobile is in scope.',
    systemPrompt: 'You are the Mobile Agent. Work only when the approved scope includes a mobile client. Implement assigned React Native or Expo screens, navigation, device states, and focused tests. Reuse shared contracts and clearly report any platform-specific decisions.',
    autonomyLevel: 'Semi-Autonomous (Requires Approval)', skills: ['sk-fs', 'sk-bash', 'sk-git'], expectedOutput: 'Mobile screens and navigation artifacts', color: '#f97316', avatar: avatar('mobile')
  },
  {
    key: 'security', agentId: 'agent-reviewer', version: 1, phase: 'Development', name: 'Security & Code Quality Agent', role: 'Security / Code Quality Agent',
    description: 'Reviews generated artifacts for secrets, vulnerabilities, unsafe dependencies, and quality risks.',
    systemPrompt: 'You are the Security and Code Quality Agent. Review the assigned diff and configuration for hardcoded secrets, authorization gaps, unsafe dependencies, injection risks, insecure defaults, and maintainability problems. Report evidence and remediation guidance. Do not silently rewrite the change or push remote changes.',
    autonomyLevel: 'Supervised', skills: ['sk-fs', 'sk-git'], expectedOutput: 'Evidence-based security and quality review', color: '#f59e0b', avatar: avatar('security')
  },
  {
    key: 'validation', agentId: 'agent-tester', version: 1, phase: 'Validation', name: 'Validation & Checking Agent', role: 'Validation / Checking Agent',
    description: 'Checks outputs against approved architecture and returns pass evidence or failure reasons.',
    systemPrompt: 'You are the Validation and Checking Agent. Verify delivered work against the approved architecture, task acceptance criteria, and available tests. Return a pass with evidence or a fail with concrete reasons and reproduction steps. Do not claim validation that you did not perform.',
    autonomyLevel: 'Supervised', skills: ['sk-fs', 'sk-bash'], expectedOutput: 'Pass/fail report with validation evidence', color: '#ec4899', avatar: avatar('validation')
  },
  {
    key: 'github-finalization', agentId: 'agent-operator', version: 1, phase: 'Finalization', name: 'GitHub Finalization Agent', role: 'GitHub Finalization Agent',
    description: 'Checks branch, pull request, and CI readiness before an approved GitHub finalization action.',
    systemPrompt: 'You are the GitHub Finalization Agent. Inspect branch state, pull request readiness, CI evidence, and repository hygiene. Prepare a finalization summary and identify blockers. Never merge, deploy, or make destructive remote changes without explicit human approval.',
    autonomyLevel: 'Semi-Autonomous (Requires Approval)', skills: ['sk-fs', 'sk-bash', 'sk-git'], expectedOutput: 'GitHub readiness summary and approval request', color: '#a855f7', avatar: avatar('github-finalization')
  }
];

export const LEGACY_TEMPLATE_MAPPINGS: Readonly<Record<string, OfficialAgentTemplateKey>> = {
  'agent-architect': 'architecture',
  'agent-reviewer': 'security',
  'agent-tester': 'validation',
  'agent-operator': 'github-finalization'
};

export function agentFromOfficialTemplate(template: OfficialAgentTemplate, createdAt: string): Agent {
  return {
    id: template.agentId,
    name: template.name,
    role: template.role,
    avatar: template.avatar,
    color: template.color,
    description: template.description,
    owner: 'Alpha',
    isMine: true,
    // Roles are provider-neutral. Leave the model unpinned so the current
    // runtime catalog/default remains authoritative as providers evolve.
    modelProvider: 'OpenAI',
    modelName: '',
    systemPrompt: template.systemPrompt,
    autonomyLevel: template.autonomyLevel,
    temperature: 0.2,
    skills: template.skills,
    // The Operator ships work and watches it run: GitHub, and the hosting it deploys to.
    mcpServers: template.key === 'github-finalization' ? ['alpha-github', 'alpha-hosting'] : [],
    concurrencyLimit: 1,
    allowedUsers: 'team',
    templateKey: template.key,
    templateVersion: template.version,
    phase: template.phase,
    isSeeded: true,
    createdAt
  };
}
