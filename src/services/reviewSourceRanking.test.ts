import { describe, expect, it } from 'vitest';
import { rankRelatedFiles, resolveRelativeImport } from './reviewSourceRanking.js';

describe('review source ranking', () => {
  it('puts the module a changed file imports ahead of files that only share words with the task', () => {
    const anchors = [{
      path: 'src/checkout/total.ts',
      content: "import { applyRules } from '../pricing/rules.js';\nimport express from 'express';\nexport const total = 1;"
    }];
    const ranked = rankRelatedFiles([
      'src/checkout/checkout-total.css', 'src/pricing/rules.ts', 'src/zz/unrelated.ts', 'src/checkout/total.test.ts'
    ], anchors);
    expect(ranked).toEqual([
      'src/pricing/rules.ts',
      'src/checkout/total.test.ts',
      'src/checkout/checkout-total.css',
      'src/zz/unrelated.ts'
    ]);
  });

  it('resolves folder index files, __tests__ pairs and dynamic imports', () => {
    const files = new Set(['src/ui/index.tsx', 'src/lib/__tests__/format.test.ts', 'src/lib/lazy.ts']);
    expect(resolveRelativeImport('src/app.ts', './ui', files)).toBe('src/ui/index.tsx');
    expect(rankRelatedFiles([...files], [{ path: 'src/lib/format.ts', content: "const lazy = import('./lazy');" }]))
      .toEqual(['src/lib/lazy.ts', 'src/lib/__tests__/format.test.ts', 'src/ui/index.tsx']);
  });

  it('ignores imports that leave the repository', () => {
    expect(resolveRelativeImport('src/a.ts', '../../outside.ts', new Set(['outside.ts']))).toBeUndefined();
  });
});
