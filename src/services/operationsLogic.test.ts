import { describe, expect, it } from 'vitest';
import { workspaceRegistry } from './workspaceRegistry.js';
import { availabilityPercent, availabilityPercentFromCounts, incidentTransition, isDeploymentInImportWindow } from './operationsLogic.js';

describe('Operations Center access and probe calculations', () => {
  it('grants operations read and write only to workspace admins', () => {
    expect(workspaceRegistry.can('admin', 'operations.read')).toBe(true);
    expect(workspaceRegistry.can('admin', 'operations.manage')).toBe(true);
    for (const role of ['client', 'dev', 'pm'] as const) {
      expect(workspaceRegistry.can(role, 'operations.read')).toBe(false);
      expect(workspaceRegistry.can(role, 'operations.manage')).toBe(false);
    }
  });

  it('keeps incomplete uptime history numeric only after at least one sample', () => {
    expect(availabilityPercent([])).toBeNull();
    expect(availabilityPercent([{ ok: true }])).toBe(100);
    expect(availabilityPercentFromCounts(999, 1000)).toBe(99.9);
    expect(availabilityPercentFromCounts(0, 0)).toBeNull();
  });

  it('opens an incident after two failures and resolves it after two successes', () => {
    expect(incidentTransition([{ ok: false }], false)).toBeNull();
    expect(incidentTransition([{ ok: false }, { ok: false }], false)).toBe('open');
    expect(incidentTransition([{ ok: false }, { ok: false }], true)).toBeNull();
    expect(incidentTransition([{ ok: true }, { ok: false }], true)).toBeNull();
    expect(incidentTransition([{ ok: true }, { ok: true }], true)).toBe('resolve');
    expect(incidentTransition([{ ok: true }, { ok: true }], false)).toBeNull();
  });

  it('imports only provider deployments from the previous 30 days', () => {
    const now = Date.parse('2026-10-26T00:00:00Z');
    expect(isDeploymentInImportWindow('2026-10-25T00:00:00Z', now)).toBe(true);
    expect(isDeploymentInImportWindow(now - 30 * 24 * 60 * 60_000, now)).toBe(true);
    expect(isDeploymentInImportWindow(now - 31 * 24 * 60 * 60_000, now)).toBe(false);
    expect(isDeploymentInImportWindow(now + 60_000, now)).toBe(false);
  });
});
