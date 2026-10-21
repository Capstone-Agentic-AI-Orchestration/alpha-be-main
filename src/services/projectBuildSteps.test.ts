import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp: string;
let opened: { close(): void }[] = [];

async function startDaemon() {
  process.env.ALPHA_HOME = tmp;
  vi.resetModules();
  const sqlite = await import('./sqliteService.js');
  const context = await import('./workspaceContext.js');
  opened.push(sqlite.sqliteService);
  return { svc: sqlite.sqliteService, runWithWorkspace: context.runWithWorkspace };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-build-room-'));
  opened = [];
});

afterEach(() => {
  for (const service of opened) {
    try { service.close(); } catch { /* already closed */ }
  }
  delete process.env.ALPHA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('project build room configuration', () => {
  it('persists ordered project steps and keeps them inside the active workspace', async () => {
    const { svc, runWithWorkspace } = await startDaemon();
    const defaultProject = svc.createProject({ id: 'project-default', name: 'Default project', key: 'DEF' });
    const defaultAgent = svc.getAgents()[0];

    const saved = svc.saveProjectBuildSteps(defaultProject.id, [
      {
        label: 'Requirements',
        phase: 'requirements',
        agentId: defaultAgent.id,
        enabled: true,
        required: true
      },
      {
        label: 'Review',
        phase: 'review',
        enabled: false,
        required: false
      }
    ]);

    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      projectId: defaultProject.id,
      label: 'Requirements',
      phase: 'requirements',
      agentId: defaultAgent.id,
      position: 0,
      enabled: true,
      required: true
    });
    expect(saved[1]).toMatchObject({ position: 1, enabled: false, required: false });

    const workspace = svc.createWorkspace({ name: 'Client workspace' });
    runWithWorkspace(workspace.id, () => {
      expect(() => svc.getProjectBuildSteps(defaultProject.id)).toThrow('Project not found');
      const project = svc.createProject({ id: 'project-client', name: 'Client project', key: 'CLI' });
      const agent = svc.getAgents()[0];
      const clientSteps = svc.saveProjectBuildSteps(project.id, [{
        label: 'Implementation',
        phase: 'implementation',
        agentId: agent.id
      }]);
      expect(clientSteps[0].projectId).toBe(project.id);
    });

    expect(svc.getProjectBuildSteps(defaultProject.id).map(step => step.label)).toEqual(['Requirements', 'Review']);
  });

  it('rejects invalid phases and cross-workspace owners', async () => {
    const { svc } = await startDaemon();
    const project = svc.createProject({ id: 'project-default', name: 'Default project', key: 'DEF' });
    const agent = svc.getAgents()[0];

    expect(() => svc.saveProjectBuildSteps(project.id, [{
      label: 'Unknown',
      phase: 'not-a-phase' as any
    }])).toThrow('Unsupported build step phase');

    expect(() => svc.saveProjectBuildSteps(project.id, [{
      label: 'Missing owner',
      phase: 'implementation',
      agentId: 'agent-from-another-workspace'
    }])).toThrow('Agent not found');

    // An older client may still send a squad; it is dropped and the agent kept.
    const saved = svc.saveProjectBuildSteps(project.id, [{
      label: 'Old client',
      phase: 'implementation',
      agentId: agent.id,
      squadId: 'squad-core'
    } as any]);
    expect(saved[0]).toMatchObject({ agentId: agent.id });
    expect(saved[0].squadId).toBeUndefined();
  });
});
