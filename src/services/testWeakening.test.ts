import { describe, expect, it } from 'vitest';
import { TEST_FILE, stripCommentsAndStrings, testStrength, testWeakening } from './testWeakening.js';

const accepted = [
  'import { accounts } from "../src/accounts";',
  'describe("accounts", () => {',
  '  it("stores accounts", () => { expect(accounts.size).toBe(0); });',
  '  test.each([1, 2])("finds %s", value => { expect(value).toBeGreaterThan(0); });',
  '});'
].join('\n');

describe('test weakening', () => {
  it('recognises test files', () => {
    expect(['tests/unit/a.ts', 'src/a.test.ts', 'src/__tests__/a.js', 'web/b.spec.tsx'].every(file => TEST_FILE.test(file))).toBe(true);
    expect(TEST_FILE.test('src/testing.ts')).toBe(false);
  });

  it('counts active tests and assertions in code, not in comments or strings', () => {
    expect(testStrength(accepted)).toEqual({ active: 2, inactive: 0, assertions: 2 });
    const padded = `${accepted}\n// it("ghost", () => { expect(1).toBe(1); });\nconst note = "test(expect(";\n/* test(() => expect(1)) */`;
    expect(testStrength(padded)).toEqual(testStrength(accepted));
    expect(stripCommentsAndStrings('a("x\\"y") // c\nb')).toBe('a("") \nb');
  });

  it('flags removing, skipping or emptying tests, and allows adding to them', () => {
    expect(testWeakening(accepted, accepted.replace('  it("stores accounts", () => { expect(accounts.size).toBe(0); });\n', ''))).toBe('removed test cases');
    // Moving a test into a comment, or a string, removes it.
    expect(testWeakening(accepted, accepted.replace('  it("stores', '  // it("stores'))).toBe('removed test cases');
    expect(testWeakening(accepted, accepted.replace('it("stores', 'it.skip("stores'))).toBe('removed test cases');
    expect(testWeakening(accepted, `${accepted}\ndescribe.skip("later", () => {});`)).toBe('skipped or disabled tests');
    expect(testWeakening(accepted, accepted.replace('expect(accounts.size).toBe(0);', ''))).toBe('removed assertions');
    expect(testWeakening(accepted, `${accepted}\nimport { signIn } from "../src/auth";\nit("signs in", () => { expect(signIn).toBeDefined(); });`)).toBeUndefined();
  });
});
