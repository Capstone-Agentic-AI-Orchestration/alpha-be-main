import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  records: [] as any[], role: 'dev', user: 'person', access: true,
  refresh: vi.fn(async () => ({})), advance: vi.fn(async () => ({})),
  api: { get: vi.fn(async () => ({ login: 'person' })) }, token: vi.fn(async () => 'pinned-test-token'), withToken: vi.fn()
}));
vi.mock('./sqliteService.js', () => ({ sqliteService: { listAllOrchestrationDeliveries: () => state.records } }));
vi.mock('./orchestrationDeliveryService.js', () => ({ OrchestrationDeliveryService: class { refresh = state.refresh; advanceAuthorized = state.advance; } }));
vi.mock('./identityService.js', () => ({ currentIdentity: async () => ({ source: 'github', login: state.user, role: state.role }) }));
vi.mock('./alphaGitHubToken.js', () => ({ requiresSessionAuthentication: () => false, isSessionAuthenticated: () => true }));
vi.mock('./workspaceRegistry.js', () => ({ workspaceRegistry: { resolve: async () => state.access ? ({ userId: state.user, workspaceId: 'ws', role: state.role }) : null,
  can: (_role: string, capability: string) => capability === 'squad.read' || state.role === 'dev', canAccessLiveBuildRoom: () => state.access } }));
vi.mock('./githubApi.js', () => ({ tokenForThisRequest: state.token, githubApiWithToken: (token: string) => { state.withToken(token); return state.api; }, githubApi: () => state.api }));
import { deliveryServiceForActor, startOrchestrationDeliveryMonitor } from './orchestrationDeliveryRuntime.js';
import type { WorkspaceContext } from './workspaceRegistry.js';

let stop: (() => void) | undefined;
beforeEach(() => { vi.clearAllMocks(); state.records = []; state.role = 'dev'; state.user = 'person'; state.access = true; state.api.get.mockResolvedValue({ login: 'person' }); });
afterEach(() => { stop?.(); stop = undefined; });
describe('authorized delivery worker', () => {
  it('pins the GitHub credential and verifies the actual actor before executing', async () => {
    await deliveryServiceForActor({ userId: 'person', workspaceId: 'ws', role: 'dev' } as WorkspaceContext);
    expect(state.withToken).toHaveBeenCalledWith('pinned-test-token');
    expect(state.api.get).toHaveBeenCalledWith('/user');
    state.api.get.mockResolvedValue({ login: 'someone-else' });
    await expect(deliveryServiceForActor({ userId: 'person' } as WorkspaceContext)).rejects.toMatchObject({ status: 403 });
  });
  it('advances developer-authorized delivery without requiring a PM role', async () => {
    state.records = [{ runId: 'build', workspaceId: 'ws', projectId: 'project', ownerId: 'person', stage: 'uat_approval', authorization: { actorId: 'person' } }];
    stop = startOrchestrationDeliveryMonitor(60_000);
    await vi.waitFor(() => expect(state.advance).toHaveBeenCalledWith(expect.objectContaining({ role: 'dev' }), 'build'));
  });
  it('does not advance deliveries after project access is revoked', async () => {
    state.access = false;
    state.records = [{ runId: 'build', workspaceId: 'ws', projectId: 'project', ownerId: 'person', stage: 'uat_approval' }];
    stop = startOrchestrationDeliveryMonitor(60_000);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(state.advance).not.toHaveBeenCalled(); expect(state.refresh).not.toHaveBeenCalled();
  });
  it('does not use another account’s grant or poll terminal deliveries indefinitely', async () => {
    state.records = [
      { runId: 'other', ownerId: 'other-person', stage: 'uat_approval' },
      { runId: 'done', ownerId: 'person', stage: 'uat_ready' },
      { runId: 'old', ownerId: 'person', stage: 'superseded' }
    ];
    stop = startOrchestrationDeliveryMonitor(60_000);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(state.advance).not.toHaveBeenCalled(); expect(state.refresh).not.toHaveBeenCalled();
  });
});
