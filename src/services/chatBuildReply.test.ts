import { describe, expect, it } from 'vitest';
import { orchestrationBuildReply } from './chatService.js';

describe('Alpha\'s reply about a build', () => {
  it('lays out the plan and asks to start, without branch or repository bookkeeping', () => {
    const text = orchestrationBuildReply({ status: 'plan_ready', orchestrationTaskCount: 3,
      decisions: [{ about: 'project-a-be', decision: 'No changes planned here.', toChange: 'Say what it should do.' }] } as any);
    expect(text).toContain("**Here's the plan:** 3 steps. No code has changed yet. Want me to start?");
    expect(text).toContain('**Choices I made**');
    expect(text).not.toMatch(/Working branch|Repository:|Orchestrator plan ready|task\(s\)/);
  });

  it('says where a running or finished build is', () => {
    expect(orchestrationBuildReply({ status: 'in_progress', orchestrationTaskCount: 1 } as any)).toBe('The agents are working on it: 1 step. You can follow along below.');
    expect(orchestrationBuildReply({ status: 'completed' } as any)).toBe('The build is done.');
    expect(orchestrationBuildReply({ status: 'blocked', reason: 'A check failed.' } as any)).toBe('The build is paused.\n\nA check failed.');
  });
});
