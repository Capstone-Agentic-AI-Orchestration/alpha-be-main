import { describe, expect, it } from 'vitest';
import { AGENT_ROLE_CONTRACTS, agentRoleContract, roleCanOwnTask, roleCanPlan } from './agentRoleContracts.js';
import { LOOK_FIRST, OFFICIAL_AGENT_TEMPLATES, PREVIOUS_TEMPLATE_PROMPTS } from './officialAgentTemplates.js';
import { orchestrationTaskKindSchema, roleCanOwnSavedTask } from './orchestrationContract.js';

describe('official role boundaries', () => {
  it('covers all 11 roles and rejects every mismatched role/task pair', () => {
    expect(OFFICIAL_AGENT_TEMPLATES).toHaveLength(11);
    for (const template of OFFICIAL_AGENT_TEMPLATES) {
      const contract = AGENT_ROLE_CONTRACTS[template.key];
      expect(agentRoleContract(template.role)).toBe(contract);
      for (const kind of orchestrationTaskKindSchema.options) expect(roleCanOwnTask(kind, template.role), `${template.key}/${kind}`).toBe((contract.tasks as readonly string[]).includes(kind));
      for (const part of ['Trigger:', 'You own:', 'Outside your role:', 'Scope and tools:', 'When blocked:']) expect(template.systemPrompt).toContain(part);
      expect(template.systemPrompt).not.toContain('undefined');
      // The Manager moved to v6 when it began writing feature specs.
      // Manager v7 adds board management for developers.
      // Every role moved up one when blockers became look-first (Manager v8, the rest v6).
      expect(template.version).toBe(template.key === 'manager' ? 9 : 7);
      expect(template.systemPrompt).toContain('When blocked: ' + LOOK_FIRST);
      expect(template.systemPrompt).toContain('say in your summary what you searched');
      expect(PREVIOUS_TEMPLATE_PROMPTS[template.key].length).toBeGreaterThanOrEqual(3);
    }
  });
  it('separates Manager requirements and planner identity from Orchestrator task ownership', () => {
    expect(roleCanPlan('Architecture Agent')).toBe(true);
    expect(roleCanOwnTask('requirements', 'Architecture Agent')).toBe(false);
    expect(roleCanPlan('Orchestrator Agent')).toBe(true);
    expect(roleCanOwnTask('requirements', 'Orchestrator Agent')).toBe(false);
    expect(roleCanOwnTask('requirements', 'Manager Agent')).toBe(true);
    expect(roleCanPlan('Coder')).toBe(false);
    expect(roleCanOwnTask('backend', 'Coder')).toBe(true);
  });
  it('grants capabilities only from a defined role, regardless of case, and nothing to an unknown one', () => {
    expect(roleCanOwnTask('backend', '  backend AGENT ')).toBe(true);
    expect(roleCanOwnTask('backend', 'Backend Specialist')).toBe(false);
    expect(roleCanPlan('orchestrator')).toBe(false);
    expect(agentRoleContract('Coder')).toBeUndefined();
  });
  it('retains compatibility only for saved plans that predate the role contract', () => {
    expect(roleCanOwnSavedTask('requirements', 'Orchestrator Agent')).toBe(true);
    expect(roleCanOwnSavedTask('requirements', 'Orchestrator Agent', 1)).toBe(false);
  });
});
