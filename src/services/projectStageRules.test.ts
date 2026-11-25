import { describe, expect, it } from 'vitest';
import { canTransition, canonicalJson, contentHash, nextAction, revisionsUsed, roundCounts, roundIsExtra, type StageState } from './projectStageRules.js';

const base: StageState = { stage: 'poc', round: null, finalDelivered: false, requests: [] };

describe('project stage rules', () => {
  it('moves forward one stage at a time, and lets a legacy project pick where it starts', () => {
    // The contract is signed in person: POC goes straight to development. A project left in the old Contract stage does too.
    expect(canTransition('poc', 'development')).toBe(true);
    expect(canTransition('poc', 'contract')).toBe(false);
    expect(canTransition('contract', 'development')).toBe(true);
    expect(canTransition('development', 'completed')).toBe(true);
    expect(canTransition('development', 'poc')).toBe(false);
    expect(canTransition('completed', 'development')).toBe(false);
    expect(canTransition('unset', 'development')).toBe(true);
    expect(canTransition('unset', 'contract')).toBe(false);
  });

  it('counts a round only when it holds a revision, and marks rounds past the limit as extra', () => {
    expect(roundCounts(['fix', 'fix'])).toBe(false);
    expect(roundCounts(['fix', 'revision'])).toBe(true);
    expect(roundCounts(['out_of_scope'])).toBe(false);
    expect(revisionsUsed([{ counts: true }, { counts: false }, { counts: null }], 0)).toBe(1);
    expect(revisionsUsed([{ counts: true }, { counts: true }], 3)).toBe(5);
    expect(roundIsExtra(2, 3)).toBe(false);
    expect(roundIsExtra(3, 3)).toBe(true);
  });

  it('says whose turn it is', () => {
    expect(nextAction({ ...base, stage: 'unset' })).toMatchObject({ who: 'pm', kind: 'set_stage' });
    // The POC stage is a marker; once the contract is signed in person, the PM starts development.
    expect(nextAction(base)).toMatchObject({ who: 'pm', kind: 'start_development' });
    expect(nextAction({ ...base, stage: 'contract' })).toMatchObject({ who: 'pm', kind: 'start_development' });
    const dev = { ...base, stage: 'development' as const };
    expect(nextAction(dev)).toMatchObject({ who: 'pm', kind: 'share_build' });
    expect(nextAction({ ...dev, round: { status: 'open', number: 1 } })).toMatchObject({ who: 'client', kind: 'submit_round' });
    expect(nextAction({ ...dev, round: { status: 'submitted', number: 1 } })).toMatchObject({ who: 'pm', kind: 'classify_round' });
    expect(nextAction({ ...dev, requests: [{ status: 'open' }] })).toMatchObject({ who: 'pm', kind: 'answer_request' });
    expect(nextAction({ ...dev, requests: [{ status: 'will_do' }] })).toMatchObject({ who: 'pm', kind: 'share_build' });
    expect(nextAction({ ...dev, round: { status: 'open', number: 2 }, requests: [{ status: 'open' }] }))
      .toMatchObject({ who: 'client', kind: 'submit_round' });
    expect(nextAction({ ...dev, finalDelivered: true })).toMatchObject({ who: 'client', kind: 'accept_final' });
    expect(nextAction({ ...base, stage: 'completed' })).toBeNull();
    expect(nextAction({ ...base, stage: 'completed', requests: [{ status: 'open' }] })).toMatchObject({ who: 'pm', kind: 'answer_request' });
  });

  it('hashes the same content the same way whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }] })).toBe('{"a":[{"c":"x","d":2}],"b":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});
