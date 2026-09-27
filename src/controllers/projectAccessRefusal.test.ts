import { afterEach, describe, expect, it, vi } from 'vitest';

import { workspaceRegistry } from '../services/workspaceRegistry.js';
import { requireProjectWorkspace } from './workspaceContext.js';

/**
 * What a caller is told when a project route refuses them.
 *
 * Developers discover every PM-owned project but reach only the ones they are
 * assigned to. Answering "not found" for a project on their screen sent them
 * looking for a missing project rather than a missing assignment -- "Conversation
 * not created: Project not found in the active workspace." What they cannot
 * discover must still read as absent.
 */

function fakeResponse() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
}

const req: any = { workspace: { userId: 'Dev1', workspaceId: 'ws-default', role: 'dev' } };

function access(canAccess: boolean, canDiscover: boolean) {
  vi.spyOn(workspaceRegistry, 'canAccessProject').mockReturnValue(canAccess);
  vi.spyOn(workspaceRegistry, 'canDiscoverProject').mockReturnValue(canDiscover);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a project route refusing its caller', () => {
  it('says the caller is not assigned when they can see the project', () => {
    access(false, true);
    const res = fakeResponse();

    expect(requireProjectWorkspace(req, res, 'proj-1')).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'project_not_assigned' });
    expect(res.body.error).toMatch(/not assigned to this project/);
  });

  it('still answers not found for a project the caller cannot see', () => {
    access(false, false);
    const res = fakeResponse();

    expect(requireProjectWorkspace(req, res, 'proj-hidden')).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Project not found in the active workspace.');
  });

  it('lets an assigned caller through untouched', () => {
    access(true, true);
    const res = fakeResponse();

    expect(requireProjectWorkspace(req, res, 'proj-1')).toBe(true);
    expect(res.body).toBeUndefined();
  });
});
