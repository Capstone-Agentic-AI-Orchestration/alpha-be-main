import { describe, expect, it } from 'vitest';

import { workspaceRegistry } from './workspaceRegistry.js';

describe('workspace squad management capabilities', () => {
  it('allows developers to manage squads they own', () => {
    expect(workspaceRegistry.can('dev', 'squad.manage')).toBe(true);
  });

  it('keeps squad management restricted from project managers', () => {
    expect(workspaceRegistry.can('pm', 'squad.manage')).toBe(false);
  });

  it('allows workspace administrators to manage squads', () => {
    expect(workspaceRegistry.can('admin', 'squad.manage')).toBe(true);
  });
});
