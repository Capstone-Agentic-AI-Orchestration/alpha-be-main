import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isPathInside, samePath } from './samePath.js';

describe('comparing local paths', () => {
  const base = path.resolve('Projects', 'Alpha');
  it('ignores letter case where the platform does, and only there', () => {
    expect(samePath(base, base.toUpperCase(), true)).toBe(true);
    expect(samePath(base, base.toUpperCase(), false)).toBe(false);
    expect(isPathInside(path.join(base.toLowerCase(), 'src'), base, true)).toBe(true);
  });
  it('never treats a sibling with the same prefix as inside', () => {
    expect(isPathInside(base + '-other', base, true)).toBe(false);
    expect(isPathInside(path.join(base, '..', 'elsewhere'), base, true)).toBe(false);
    expect(isPathInside(base, base, false)).toBe(true);
  });
});
