import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../models/index.js';
import type { OrchestrationSnapshot } from './orchestrationStateMachine.js';

const { saved } = vi.hoisted(() => ({ saved: [] as ChatMessage[] }));
vi.mock('./chatWriteThrough.js', () => ({ saveChatMessageAndShare: (message: ChatMessage) => { saved.push(message); } }));
vi.mock('./chatService.js', () => ({ chatService: { emit: vi.fn() } }));

import { postStartedNotice } from './orchestrationChatNotice.js';

/** Starting a plan, from the card or from chat, is said in its conversation, where its progress then shows. */
describe('the started-plan notice in chat', () => {
  const snapshot = (threadId?: string) => ({
    run: { id: 'run-1', workspaceId: 'ws-default', planVersion: 2, originChatThreadId: threadId },
    tasks: [{ required: true }, { required: true }, { required: false }]
  }) as unknown as OrchestrationSnapshot;

  it('posts one build message for the run, so the chat shows the live progress under it', async () => {
    saved.length = 0;
    const store = { getChatMessages: () => saved };
    await postStartedNotice(store, snapshot('thread-1'));
    await postStartedNotice(store, snapshot('thread-1'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: 'run-1-started-v2', threadId: 'thread-1', messageType: 'build', orchestrationRunId: 'run-1' });
    expect(saved[0].content).toContain('Starting now. The agents are working through the 2 steps');
  });

  it('says nothing for a build that did not start from a conversation', async () => {
    saved.length = 0;
    await postStartedNotice({ getChatMessages: () => saved }, snapshot());
    expect(saved).toHaveLength(0);
  });
});
