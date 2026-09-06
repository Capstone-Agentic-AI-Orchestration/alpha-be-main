import { describe, it, expect } from 'vitest';
import { roleFromTeams, TeamMembership } from './identityService.js';

/**
 * Which Alpha role a GitHub account holds.
 *
 * The role model — client / dev / pm / admin, with a capability matrix and
 * per-role navigation — was driven by a picker over mock users, so "who am I"
 * was whichever entry the switcher was on.
 *
 * The scoping is the part worth pinning. A GitHub account belongs to every org
 * its owner ever joined; this developer's belongs to ten, holding `developer`
 * in one sandbox and `product-owner` in another alongside `project-managers` in
 * the workspace that actually matters. Pooling them answers with whichever rank
 * happens to be highest, which was right here by luck and wrong in general.
 */
const t = (org: string, slug: string): TeamMembership => ({ org, slug });

const WS = 'Capstone-Agentic-AI-Orchestration';

describe('roleFromTeams', () => {
  it('reads the role from a team in the workspace', () => {
    expect(roleFromTeams([t(WS, 'project-managers')], WS)).toBe('pm');
    expect(roleFromTeams([t(WS, 'developers')], WS)).toBe('dev');
  });

  /** The real shape of this account: one relevant team among fifteen others. */
  it('ignores teams in other organisations', () => {
    const teams = [
      t('St-Peter-Sandbox', 'product-owner'),
      t('St-Peter-Sandbox', 'developer'),
      t('Alpha-Explora', 'team-lead'),
      t(WS, 'developers')
    ];
    // 'dev' from the workspace, not 'pm' from a sandbox that outranks it.
    expect(roleFromTeams(teams, WS)).toBe('dev');
  });

  it('gives no answer without a workspace to scope by', () => {
    // Undefined is a real answer. Guessing here is what put a sandbox
    // membership in charge of what the UI would let someone do.
    expect(roleFromTeams([t(WS, 'project-managers')], undefined)).toBeUndefined();
  });

  it('gives no answer when no team in the workspace says anything', () => {
    expect(roleFromTeams([t(WS, 'infrastructure'), t(WS, 'design')], WS)).toBeUndefined();
  });

  it('gives no answer for an account in no teams', () => {
    expect(roleFromTeams([], WS)).toBeUndefined();
  });

  it('takes the strongest role when someone is in several', () => {
    // A person can be in both; the wider capability set is the safe read of
    // what they are entitled to.
    expect(roleFromTeams([t(WS, 'developers'), t(WS, 'project-managers')], WS)).toBe('pm');
    expect(roleFromTeams([t(WS, 'clients'), t(WS, 'developers')], WS)).toBe('dev');
  });

  it('matches the names orgs actually use', () => {
    // Slugs vary between organisations, and a stored mapping table would be one
    // more thing to keep in step with what the org really has.
    expect(roleFromTeams([t(WS, 'developer')], WS)).toBe('dev');
    expect(roleFromTeams([t(WS, 'devs')], WS)).toBe('dev');
    expect(roleFromTeams([t(WS, 'engineering')], WS)).toBe('dev');
    expect(roleFromTeams([t(WS, 'project-manager')], WS)).toBe('pm');
    expect(roleFromTeams([t(WS, 'pm')], WS)).toBe('pm');
    expect(roleFromTeams([t(WS, 'product')], WS)).toBe('pm');
  });

  it('compares organisation names case-insensitively', () => {
    // GitHub preserves the case an org was created with but does not require it
    // when referring to one, so the two spellings must not disagree.
    expect(roleFromTeams([t(WS, 'developers')], WS.toLowerCase())).toBe('dev');
  });

  it('does not match a team whose name merely contains a role word', () => {
    // 'developers-guild' is a different team from 'developers', and reading it
    // as the same one would grant a role nobody assigned.
    expect(roleFromTeams([t(WS, 'developers-guild')], WS)).toBeUndefined();
    expect(roleFromTeams([t(WS, 'ex-project-managers')], WS)).toBeUndefined();
  });
});
