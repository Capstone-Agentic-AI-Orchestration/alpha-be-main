import { describe, expect, it } from 'vitest';
import { GITHUB_DESCRIPTION_MAX, githubRepoDescription } from './githubRepoDescription.js';

/**
 * GitHub refuses a repository description with a line break, a control character
 * or more than 350 characters, and says only "422 Repository creation failed".
 */
describe('a repository description GitHub accepts', () => {
  it('turns line breaks, tabs and other control characters into single spaces', () => {
    expect(githubRepoDescription('Goal:\r\n  Build it\tfast\u0007 now\n')).toBe('Goal: Build it fast now');
  });

  it('leaves the field out when nothing printable is left', () => {
    for (const value of [undefined, null, '', ' \n\t ']) expect(githubRepoDescription(value)).toBeUndefined();
  });

  it('cuts a long description at a word, within the limit', () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join('\n');
    const result = githubRepoDescription(long)!;
    expect(result.length).toBeLessThanOrEqual(GITHUB_DESCRIPTION_MAX);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toMatch(/\s…$/);
    expect(long.replace(/\n/g, ' ').startsWith(result.slice(0, -1))).toBe(true);
  });

  it('keeps a description that already fits as it is', () => {
    expect(githubRepoDescription('A storefront for the spring launch')).toBe('A storefront for the spring launch');
  });
});
