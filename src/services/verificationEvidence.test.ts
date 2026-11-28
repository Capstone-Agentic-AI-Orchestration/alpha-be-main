import { describe, expect, it } from 'vitest';
import { verificationFailureEvidence } from './verificationEvidence.js';

const install = 'npm ci --no-audit --no-fund --prefer-offline';
const logs = [
  '$ ' + install + ' (exit 0)',
  '[' + install + '] npm warn deprecated glob@7.2.3: Old versions of glob are not supported',
  '[' + install + '] npm warn deprecated prebuild-install@7.1.3: No longer maintained.',
  '$ npm run test (exit 0)',
  '[npm run test] PASS tests/unit/accounts.spec.ts',
  '$ npm run typecheck (exit 2)',
  '[npm run typecheck] > tsc --noEmit',
  '[npm run typecheck] ts-jest[config] (WARN) \u001b[94mmessage\u001b[0m TS151002: Using hybrid module kind',
  '[npm run typecheck] src/auth.ts(72,43): error TS2345: Argument of type \'{}\' is not assignable to parameter of type \'string\'.',
  '$ npm run lint (exit 1)',
  '[npm run lint] > eslint src tests',
  '[npm run lint] C:\\work\\resort-website-a-be\\src\\app.ts',
  '[npm run lint]   33:72  error  \'_next\' is defined but never used  @typescript-eslint/no-unused-vars',
  '[npm run lint]   26:67  error  A require() style import is forbidden  @typescript-eslint/no-require-imports',
  '[npm run lint] ✖ 2 problems (2 errors, 0 warnings)',
  ...Array.from({ length: 40 }, (_, i) => '[npm run lint] npm warn deprecated noise-' + i)
];

describe('what a repair attempt is told about a failed check', () => {
  it('keeps the failing commands\' error lines and drops install and warning noise', () => {
    const evidence = verificationFailureEvidence(logs);
    expect(evidence).toContain('npm run typecheck failed:');
    expect(evidence).toContain('src/auth.ts(72,43): error TS2345');
    expect(evidence).toContain('npm run lint failed:');
    expect(evidence).toContain('33:72  error  \'_next\' is defined but never used');
    expect(evidence).toContain('app.ts');
    expect(evidence).not.toContain('npm warn');
    expect(evidence).not.toContain('ts-jest[config]');
    expect(evidence).not.toContain('npm run test failed');
    // The errors come first, so a later cut to the first 2,000 characters keeps them.
    expect(evidence.length).toBeLessThan(1_600);
  });

  it('falls back to a failing command\'s last lines when no line looks like an error', () => {
    const evidence = verificationFailureEvidence(['$ npm run test (exit 1)', '[npm run test] something odd happened']);
    expect(evidence).toBe('npm run test failed:\n  something odd happened');
    expect(verificationFailureEvidence(['$ npm run test (exit 0)', '[npm run test] fine'])).toBe('');
  });
});
