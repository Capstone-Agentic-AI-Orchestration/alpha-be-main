import { describe, expect, it } from 'vitest';
import { canTransition, canonicalJson, contentHash, nextAction, revisionsUsed, roundCounts, submitRequiresQuote, type StageState } from './projectStageRules.js';

const base: StageState = { stage: 'poc', poc: null, contract: null, round: null, finalDelivered: false, quotes: [] };

describe('project stage rules', () => {
  it('moves forward one stage at a time, and lets a legacy project pick where it starts', () => {
    expect(canTransition('poc', 'contract')).toBe(true);
    expect(canTransition('contract', 'development')).toBe(true);
    expect(canTransition('development', 'completed')).toBe(true);
    expect(canTransition('poc', 'development')).toBe(false);
    expect(canTransition('development', 'poc')).toBe(false);
    expect(canTransition('completed', 'development')).toBe(false);
    expect(canTransition('unset', 'development')).toBe(true);
    expect(canTransition('unset', 'contract')).toBe(false);
  });

  it('counts a round only when it holds a revision, and never a paid one', () => {
    expect(roundCounts(['fix', 'fix'])).toBe(false);
    expect(roundCounts(['fix', 'revision'])).toBe(true);
    expect(roundCounts(['out_of_scope'])).toBe(false);
    expect(revisionsUsed([{ counts: true, paid: false }, { counts: false, paid: false }, { counts: null, paid: false }], 0)).toBe(1);
    expect(revisionsUsed([{ counts: true, paid: true }], 1)).toBe(1);
    expect(submitRequiresQuote(2, 3)).toBe(false);
    expect(submitRequiresQuote(3, 3)).toBe(true);
  });

  it('says whose turn it is', () => {
    expect(nextAction({ ...base, stage: 'unset' })).toMatchObject({ who: 'pm', kind: 'set_stage' });
    expect(nextAction(base)).toMatchObject({ who: 'pm', kind: 'publish_poc' });
    expect(nextAction({ ...base, poc: { status: 'published', number: 2 } })).toMatchObject({ who: 'client', kind: 'review_poc', label: 'Review POC v2' });
    expect(nextAction({ ...base, poc: { status: 'changes_requested', number: 2 } })).toMatchObject({ who: 'pm', kind: 'publish_poc' });
    expect(nextAction({ ...base, stage: 'contract' })).toMatchObject({ who: 'pm', kind: 'issue_contract' });
    expect(nextAction({ ...base, stage: 'contract', contract: { status: 'issued' } })).toMatchObject({ who: 'client', kind: 'sign_contract' });
    expect(nextAction({ ...base, stage: 'contract', contract: { status: 'client_signed' } })).toMatchObject({ who: 'pm', kind: 'countersign_contract' });
    const dev = { ...base, stage: 'development' as const };
    expect(nextAction(dev)).toMatchObject({ who: 'pm', kind: 'share_build' });
    expect(nextAction({ ...dev, round: { status: 'open', number: 1 } })).toMatchObject({ who: 'client', kind: 'submit_round' });
    expect(nextAction({ ...dev, round: { status: 'submitted', number: 1 } })).toMatchObject({ who: 'pm', kind: 'classify_round' });
    expect(nextAction({ ...dev, quotes: [{ status: 'requested' }] })).toMatchObject({ who: 'pm', kind: 'send_quote' });
    expect(nextAction({ ...dev, quotes: [{ status: 'sent' }] })).toMatchObject({ who: 'client', kind: 'decide_quote' });
    expect(nextAction({ ...dev, finalDelivered: true })).toMatchObject({ who: 'client', kind: 'accept_final' });
    expect(nextAction({ ...base, stage: 'completed' })).toBeNull();
    expect(nextAction({ ...base, stage: 'completed', quotes: [{ status: 'requested' }] })).toMatchObject({ who: 'pm', kind: 'send_quote' });
  });

  it('hashes the same content the same way whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }] })).toBe('{"a":[{"c":"x","d":2}],"b":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});
