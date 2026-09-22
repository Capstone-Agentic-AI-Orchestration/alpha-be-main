import { describe, it, expect } from 'vitest';

import { keyForRepo } from './githubRepoDiscovery.js';

/**
 * The key is what every card of a repository is called by -- ABM-12 -- so it
 * has to be short, recognisable, and never one another project already holds.
 */
describe('keyForRepo', () => {
  it('takes the initials of a multi-word name', () => {
    expect(keyForRepo('alpha-be-main', new Set())).toBe('ABM');
    expect(keyForRepo('Test_Agents_Fe', new Set())).toBe('TAF');
  });

  it('shortens a one-word name', () => {
    expect(keyForRepo('systemsample1', new Set())).toBe('SYST');
    expect(keyForRepo('test', new Set())).toBe('TEST');
  });

  it('numbers a clash rather than failing', () => {
    expect(keyForRepo('alpha-be-main', new Set(['ABM']))).toBe('ABM2');
    expect(keyForRepo('alpha-be-main', new Set(['ABM', 'ABM2']))).toBe('ABM3');
  });

  it('has a key for a name with no letters in it', () => {
    expect(keyForRepo('---', new Set())).toBe('REPO');
  });
});
