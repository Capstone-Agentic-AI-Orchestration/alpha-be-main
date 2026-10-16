import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), getSession: vi.fn(), setSession: vi.fn(), runtimes: vi.fn() }));
vi.mock('./sqliteService.js', () => ({ sqliteService: { getRuntimes: mocks.runtimes, getThreadSession: mocks.getSession, setThreadSession: mocks.setSession } }));
vi.mock('./cliRunner.js', () => ({ runCliTurn: mocks.run }));
import { sendBuilderMessage } from './agentBuilderService.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.runtimes.mockReturnValue([{ id: 'codex', provider: 'OpenAI', status: 'online', models: ['first', 'selected'] }]);
  mocks.run.mockResolvedValue({ content: 'Ready', sessionId: 'cli-session' });
});

describe('the builder execution model', () => {
  it('executes the selected model rather than the first catalog model', async () => {
    const result = await sendBuilderMessage({ sessionId: 'draft-1', runtimeId: 'codex', modelName: 'selected', message: 'Design a reviewer' });
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ provider: 'OpenAI', modelName: 'selected' }));
    expect(result.modelName).toBe('selected');
    expect(mocks.getSession).toHaveBeenCalledWith('draft-1', '__agent_builder__:codex:selected');
    expect(mocks.setSession).toHaveBeenCalledWith('draft-1', '__agent_builder__:codex:selected', 'cli-session');
  });
  it('rejects unknown models without starting a CLI', async () => {
    await expect(sendBuilderMessage({ sessionId: 'draft-1', runtimeId: 'codex', modelName: 'invented', message: 'Design a reviewer' })).rejects.toThrow('available builder model');
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('rejects offline runtimes and does not reuse another model’s session', async () => {
    mocks.runtimes.mockReturnValue([{ id: 'codex', provider: 'OpenAI', status: 'offline', models: ['selected'] }]);
    await expect(sendBuilderMessage({ sessionId: 'draft-1', runtimeId: 'codex', modelName: 'selected', message: 'Hello' })).rejects.toThrow('unavailable');
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});
