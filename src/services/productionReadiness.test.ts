import { describe, expect, it } from 'vitest';

import { builtFrom, decideReadiness, type SubmittedRound } from './productionReadiness.js';

/**
 * The release rule: for a project with a client, production needs the
 * client's latest UAT round for the commit on uat to have passed.
 */

const REPO = 'acme/shop-fe';
const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const build = (sha: string) => ({ frontend: { repository: REPO, commitSha: sha }, backends: [{ repository: 'acme/shop-be', commitSha: 'c'.repeat(40) }] });
const round = (number: number, outcome: string, sha: string, submittedAt: string): SubmittedRound =>
  ({ number, outcome, submittedAt, build: build(sha) });
const base = { repository: REPO, sha: SHA, hasClient: true, anyRounds: true };

describe('production readiness', () => {
  it('approves when the client passed the commit now on uat', () => {
    expect(decideReadiness({ ...base, submitted: [round(3, 'passed', SHA, '2026-11-08T01:00:00Z')] }))
      .toMatchObject({ state: 'approved', round: 3 });
  });

  it('uses the latest round for that commit, so a later rejection wins over an earlier pass', () => {
    const result = decideReadiness({ ...base, submitted: [
      round(3, 'passed', SHA, '2026-11-08T01:00:00Z'),
      round(4, 'changes_requested', SHA, '2026-11-08T02:00:00Z')
    ] });
    expect(result).toMatchObject({ state: 'not_approved', round: 4, outcome: 'changes_requested' });
  });

  it('does not let a pass for an older build approve what is on uat now', () => {
    const result = decideReadiness({ ...base, submitted: [round(2, 'passed', OLD, '2026-11-07T01:00:00Z')] });
    expect(result.state).toBe('not_approved');
    expect(result).toHaveProperty('reason', expect.stringContaining('has not passed UAT'));
  });

  it('refuses a client project with no submitted round, so skipping UAT is not a way through', () => {
    expect(decideReadiness({ ...base, anyRounds: false, submitted: [] }).state).toBe('not_approved');
  });

  it('leaves a project no client can see to the project manager, and says so', () => {
    expect(decideReadiness({ ...base, hasClient: false, anyRounds: false, submitted: [] }))
      .toMatchObject({ state: 'no_client', reason: expect.stringContaining('project manager') });
  });

  it('matches a backend in the build, case-insensitively, and only at the exact commit', () => {
    expect(builtFrom(build(SHA), 'ACME/shop-be', 'C'.repeat(40))).toBe(true);
    expect(builtFrom(build(SHA), 'acme/shop-be', 'd'.repeat(40))).toBe(false);
    expect(builtFrom(null, REPO, SHA)).toBe(false);
  });
});
