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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-workspace-'));
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

describe('workspace data boundaries', () => {
  it('migrates legacy data into the default workspace and isolates new workspaces', async () => {
    const { svc, runWithWorkspace } = await startDaemon();
    const defaultProject = svc.createProject({ id: 'project-default', name: 'Default project', key: 'DEF' });
    const defaultThread = svc.createChatThread({ id: 'thread-default', title: 'Default chat' });
    const workspace = svc.createWorkspace({ name: 'Client workspace' });

    expect(svc.getWorkspaces().map(item => item.id)).toEqual(['ws-default', workspace.id]);
    expect(svc.getProjects().map(item => item.id)).toEqual([defaultProject.id]);
    expect(svc.getChatThreads().map(item => item.id)).toEqual([defaultThread.id]);

    runWithWorkspace(workspace.id, () => {
      expect(svc.getProjects()).toEqual([]);
      expect(svc.getChatThreads()).toEqual([]);
      expect(svc.getAgents()).toHaveLength(10);
      svc.createProject({ id: 'project-client', name: 'Client project', key: 'CLI' });
      svc.createChatThread({ id: 'thread-client', title: 'Client chat' });
    });

    expect(svc.getProjects().map(item => item.id)).toEqual([defaultProject.id]);
    expect(svc.getChatThreads().map(item => item.id)).toEqual([defaultThread.id]);

    runWithWorkspace(workspace.id, () => {
      expect(svc.getProjects().map(item => item.id)).toEqual(['project-client']);
      expect(svc.getChatThreads().map(item => item.id)).toEqual(['thread-client']);
    });
  });
});
