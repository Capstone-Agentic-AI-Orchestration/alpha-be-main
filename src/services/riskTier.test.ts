import { describe, expect, it } from 'vitest';
import { classifyRisk, pathTokens, sensitivePathCategories, sensitiveTextCategories } from './riskTier.js';

const repo = 'acme/shop-be';
const at = (path: string) => ({ repository: repo, path });

describe('risk tiers', () => {
  it('splits paths into name parts, so auth matches authController but not author', () => {
    expect(pathTokens('src/authController.ts')).toEqual(['src', 'auth', 'controller', 'ts']);
    expect(sensitivePathCategories('src/author.ts')).toEqual([]);
    expect(sensitivePathCategories('src/authController.ts')).toEqual(['security']);
  });

  it.each([
    ['src/auth/session.ts', 'security'],
    ['src/middleware/permissions.ts', 'security'],
    ['src/utils/crypto.ts', 'security'],
    ['prisma/schema.prisma', 'data'],
    ['db/migrations/0003_add_orders.sql', 'data'],
    ['src/billing/invoice.ts', 'money'],
    ['src/payments/stripeWebhook.ts', 'money'],
    ['src/privacy/consentBanner.tsx', 'privacy'],
    ['package.json', 'dependencies'],
    ['web/package-lock.json', 'dependencies'],
    ['LICENSE', 'dependencies'],
    ['.env.production', 'secrets'],
    ['src/config/env.ts', 'secrets'],
    ['certs/server.pem', 'secrets'],
    ['.github/workflows/ci.yml', 'ci_build'],
    ['tsconfig.json', 'ci_build'],
    ['eslint.config.mjs', 'ci_build'],
    ['vitest.config.ts', 'ci_build'],
    ['Dockerfile', 'deployment'],
    ['docker-compose.yml', 'deployment'],
    ['render.yaml', 'deployment'],
    ['infra/main.tf', 'deployment'],
    ['k8s/api.yaml', 'deployment']
  ])('classifies %s as %s', (path, category) => {
    expect(sensitivePathCategories(path)).toContain(category);
  });

  it('leaves ordinary source mechanical', () => {
    for (const path of ['src/components/BookingCard.tsx', 'src/routes/bookings.ts', 'tests/bookings.test.ts', 'src/styles/tokens.css', 'README.md']) {
      expect(sensitivePathCategories(path)).toEqual([]);
    }
    expect(classifyRisk({ paths: [at('src/routes/bookings.ts')], texts: ['Required check “lint” was not observed passing on this attempt.'] }).tier).toBe(0);
  });

  it('adds a project\'s own sensitive patterns to the defaults', () => {
    expect(sensitivePathCategories('src/pricing-rules/discounts.ts', ['src/pricing-rules/**'])).toContain('project_pattern');
    expect(classifyRisk({ paths: [at('src/reports/export.ts')], projectPatterns: ['src/reports/**'] }).tier).toBe(2);
  });

  it('treats a change to an earlier task\'s accepted file as structural (tier 1)', () => {
    const result = classifyRisk({ paths: [at('src/api/contract.ts')], acceptedPaths: [at('src/api/contract.ts')] });
    expect(result.tier).toBe(1);
    expect(result.classifiedPaths).toEqual([{ ...at('src/api/contract.ts'), tier: 1, categories: ['accepted_work'] }]);
  });

  it('makes weakened tests tier 2 whatever happened before', () => {
    const result = classifyRisk({ paths: [at('tests/cart.test.ts')], weakenedTests: [{ ...at('tests/cart.test.ts'), detail: 'removed test cases' }] });
    expect(result.tier).toBe(2);
    expect(result.reasons).toContainEqual(expect.objectContaining({ category: 'tests_weakened', source: 'diff' }));
  });

  it('makes weakened tests structural (tier 1) when the fix is held to putting them back word for word', () => {
    const weakenedTests = [{ ...at('tests/cart.test.ts'), detail: 'replaced test cases (“adds an item”)' }];
    const texts = ['This task replaced test cases. A task may add and update tests but not delete, skip or replace them or remove assertions.',
      'Restore the removed tests exactly.'];
    const restoring = classifyRisk({ paths: [at('tests/cart.test.ts')], texts, weakenedTests, restoresWeakenedTests: true });
    expect(restoring.tier).toBe(1);
    expect(restoring.reasons).toEqual([expect.objectContaining({ tier: 1, category: 'tests_weakened', source: 'diff' })]);
    // The same texts without that hold stay with the person, and other sensitive words still count.
    expect(classifyRisk({ paths: [at('tests/cart.test.ts')], texts, weakenedTests }).tier).toBe(2);
    expect(classifyRisk({ paths: [at('tests/cart.test.ts')], texts: [...texts, 'Also store the session cookie.'], weakenedTests, restoresWeakenedTests: true }).tier).toBe(2);
  });

  it('reads the blocker, the failing check and the proposed fix for sensitive decisions', () => {
    expect(sensitiveTextCategories('Should the session cookie be httpOnly?')).toContain('security');
    expect(sensitiveTextCategories('Skip the failing test so lint passes')).toContain('tests_weakened');
    expect(sensitiveTextCategories('Add a new dependency for dates')).toContain('dependencies');
    expect(sensitiveTextCategories('Set the API key in .env')).toContain('secrets');
    expect(sensitiveTextCategories('The frontend has no API contract for /api/bookings')).toEqual([]);
    expect(classifyRisk({ paths: [at('src/routes/bookings.ts')], texts: ['Relax the lint rules for this file'] }).tier).toBe(2);
  });

  it('never returns tier 3: product scope is only the Orchestrator\'s question to the person', () => {
    expect(classifyRisk({ paths: [], texts: ['Should Project A stay informational or take bookings?'] }).tier).toBe(0);
  });
});
