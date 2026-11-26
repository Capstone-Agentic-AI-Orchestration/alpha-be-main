import { describe, expect, it } from 'vitest';
import { isTestFile, testFileWeakening, testStrength, testWeakening, testsNotKeptExactly } from './testWeakening.js';

const accepted = [
  'import { accounts } from "../src/accounts";',
  'describe("accounts", () => {',
  '  it("stores accounts", () => { expect(accounts.size).toBe(0); });',
  '  test.each([1, 2])("finds %s", value => { expect(value).toBeGreaterThan(0); });',
  '});'
].join('\n');

describe('test weakening', () => {
  it('recognises test files in JavaScript and other languages', () => {
    expect(['tests/unit/a.ts', 'src/a.test.ts', 'src/__tests__/a.js', 'web/b.spec.tsx', 'app/test_models.py', 'pkg/store_test.go', 'src/UserServiceTest.java']
      .every(file => isTestFile(file))).toBe(true);
    expect(isTestFile('src/testing.ts')).toBe(false);
  });

  it('counts active tests, titles and assertions from the syntax tree, not comments or strings', () => {
    expect(testStrength(accepted)).toEqual({ active: 2, inactive: 0, assertions: 2, titles: ['stores accounts', 'finds %s'],
      tests: [{ title: 'stores accounts', state: 'active' }, { title: 'finds %s', state: 'active' }] });
    const padded = `${accepted}\n// it("ghost", () => { expect(1).toBe(1); });\nconst note = "test(expect(";\n/* test(() => expect(1)) */`;
    expect(testStrength(padded)).toEqual(testStrength(accepted));
  });

  it('is not fooled by a quote inside a regular expression literal', () => {
    // The old scanner read the quote in the regex as opening a string, emptied the code after it, and lost the test.
    const withRegex = `${accepted}\nconst quote = /"/;\nit("keeps quotes", () => { expect(quote.test('"')).toBe(true); });`;
    expect(testStrength(withRegex)).toMatchObject({ active: 3, assertions: 3 });
    expect(testWeakening(withRegex, withRegex.replace('it("keeps quotes"', 'it.skip("keeps quotes"'))).toBe('skipped or disabled tests (“keeps quotes”)');
  });

  it('does not count code inside a template ${...} as a test, or miss a real one after it', () => {
    // A test call written inside a template string is text, not a test: replacing a real test with it is a removal.
    const phantom = accepted.replace('  it("stores accounts", () => { expect(accounts.size).toBe(0); });',
      '  const label = `${"it("}stores accounts ${(() => "expect(")()}`;');
    expect(testStrength(phantom)).toMatchObject({ active: 1, assertions: 1 });
    expect(testWeakening(accepted, phantom)).toBe('removed test cases (“stores accounts”)');
    const nested = `const title = \`case \${\`inner \${1}\`}\`;\nit(title, () => { expect(1).toBe(1); });`;
    expect(testStrength(nested)).toMatchObject({ active: 1, assertions: 1, titles: ['<dynamic>'] });
  });

  it('flags removing, skipping, replacing or emptying tests, and allows adding to them', () => {
    expect(testWeakening(accepted, accepted.replace('  it("stores accounts", () => { expect(accounts.size).toBe(0); });\n', ''))).toBe('removed test cases (“stores accounts”)');
    expect(testWeakening(accepted, accepted.replace('  it("stores', '  // it("stores'))).toBe('removed test cases (“stores accounts”)');
    expect(testWeakening(accepted, accepted.replace('it("stores', 'it.skip("stores'))).toBe('skipped or disabled tests (“stores accounts”)');
    expect(testWeakening(accepted, `${accepted}\ndescribe.skip("later", () => {});`)).toBe('skipped or disabled tests');
    expect(testWeakening(accepted, `${accepted}\nxit("later", () => {});`)).toBe('skipped or disabled tests');
    expect(testWeakening(accepted, accepted.replace('expect(accounts.size).toBe(0);', ''))).toBe('removed assertions');
    expect(testWeakening(accepted, accepted.replace('it("stores accounts", () => { expect(accounts.size).toBe(0); });',
      'it("something easier", () => { expect(accounts).toBeDefined(); });'))).toBe('replaced test cases (“stores accounts”)');
    expect(testWeakening(accepted, `${accepted}\nimport { signIn } from "../src/auth";\nit("signs in", () => { expect(signIn).toBeDefined(); });`)).toBeUndefined();
  });

  it('keeps a test renamed with exactly the same code, and nothing looser', () => {
    // Only the title changed: the same test still runs, so nothing was weakened.
    expect(testWeakening(accepted, accepted.replace('"stores accounts"', '"stores the accounts"'))).toBeUndefined();
    // Formatting and comments do not make it a different test.
    expect(testWeakening(accepted, accepted.replace('it("stores accounts", () => { expect(accounts.size).toBe(0); });',
      'it("stores the accounts", () => {\n    // empty at start\n    expect(accounts.size).toBe(0);\n  });'))).toBeUndefined();
    // A rename that also changes what the test checks is still a replacement.
    expect(testWeakening(accepted, accepted.replace('it("stores accounts", () => { expect(accounts.size).toBe(0); });',
      'it("stores the accounts", () => { expect(accounts.size).toBe(1); });'))).toBe('replaced test cases (“stores accounts”)');
    // One new test cannot stand in for two old ones with the same code.
    const twins = 'it("a", () => { expect(1).toBe(1); });\nit("b", () => { expect(1).toBe(1); });';
    expect(testWeakening(twins, 'it("c", () => { expect(1).toBe(1); });\nit("d", () => { expect(2).toBe(2); });')).toBe('replaced test cases (“b”)');
    // Switching `it` to `test.each` is not the same test.
    expect(testWeakening(accepted, accepted.replace('it("stores accounts", () => { expect(accounts.size).toBe(0); });',
      'test.each([1])("stores the accounts", () => { expect(accounts.size).toBe(0); });'))).toBe('replaced test cases (“stores accounts”)');
  });

  it('names the tests that are not back word for word, for a fix that must restore them', () => {
    expect(testsNotKeptExactly(accepted, `${accepted}\nit("adds", () => { expect(1).toBe(1); });`)).toEqual([]);
    // Same title, same number of assertions, different check: testWeakening lets it pass, this does not.
    const loosened = accepted.replace('expect(accounts.size).toBe(0)', 'expect(accounts).toBeDefined()');
    expect(testWeakening(accepted, loosened)).toBeUndefined();
    expect(testsNotKeptExactly(accepted, loosened)).toEqual(['stores accounts']);
    expect(testsNotKeptExactly(accepted, accepted.replace('"stores accounts"', '"stores the accounts"'))).toEqual(['stores accounts']);
    expect(() => testsNotKeptExactly(accepted, 'it("broken", () => {')).toThrow();
  });

  it('treats a test that passes only when the code is broken as weakened', () => {
    expect(testWeakening(accepted, accepted.replace('it("stores', 'test.fails("stores')))
      .toBe('turned tests into expected failures, which pass when the code is broken (“stores accounts”)');
    expect(testWeakening(accepted, accepted.replace('it("stores', 'it.failing("stores')))
      .toBe('turned tests into expected failures, which pass when the code is broken (“stores accounts”)');
    expect(testStrength('test.fails("x", () => {});')).toMatchObject({ active: 0, inactive: 1, tests: [{ title: 'x', state: 'inverted' }] });
  });

  it('treats runIf and skipIf as conditional unless the literal always runs the test', () => {
    const conditional = 'made tests run only on a condition (“stores accounts”)';
    expect(testWeakening(accepted, accepted.replace('it("stores', 'it.runIf(process.env.CI)("stores'))).toBe(conditional);
    expect(testWeakening(accepted, accepted.replace('it("stores', 'test.skipIf(isWindows)("stores'))).toBe(conditional);
    expect(testWeakening(accepted, accepted.replace('it("stores', 'it.runIf(false)("stores'))).toBe('skipped or disabled tests (“stores accounts”)');
    expect(testWeakening(accepted, accepted.replace('it("stores', 'test.skipIf(true)("stores'))).toBe('skipped or disabled tests (“stores accounts”)');
    // A literal that always runs it is still an active test.
    expect(testWeakening(accepted, accepted.replace('it("stores', 'it.runIf(true)("stores'))).toBeUndefined();
    expect(testWeakening(accepted, accepted.replace('it("stores', 'test.skipIf(false)("stores'))).toBeUndefined();
    expect(testWeakening(accepted, accepted.replace('test.each([1, 2])', 'test.skipIf(slow).each([1, 2])'))).toBe('made tests run only on a condition (“finds %s”)');
  });

  it('compares each title, so keeping the count while weakening one test is still caught', () => {
    // One test is inverted and a new one is added: the active count stays at two.
    const swapped = `${accepted.replace('it("stores', 'it.failing("stores')}\nit("a new easy test", () => { expect(1).toBe(1); });`;
    expect(testStrength(swapped).active).toBe(2);
    expect(testWeakening(accepted, swapped)).toBe('turned tests into expected failures, which pass when the code is broken (“stores accounts”)');
    // Turning an expected failure back into a normal test strengthens it.
    const inverted = accepted.replace('it("stores', 'test.fails("stores');
    expect(testWeakening(inverted, accepted)).toBeUndefined();
  });

  it('reads TypeScript and JSX, and counts a table test once', () => {
    const tsx = 'import { render } from "x";\nconst wrap = <T,>(value: T): T => value;\nit.each`a | b\n${1} | ${2}`("adds $a", ({ a }: { a: number }) => { expect(render(<b>{wrap(a)}</b>)).toBeTruthy(); });';
    expect(testStrength(tsx, 'web/a.test.tsx')).toMatchObject({ active: 1, inactive: 0, assertions: 1 });
    expect(testStrength('test.extend({ db: 1 });\ntest.skipIf(true)("later", () => {});', 'a.test.ts')).toMatchObject({ active: 0, inactive: 1 });
  });

  it('fails closed when either version does not parse, and checks other languages by deletion only', () => {
    expect(testFileWeakening('tests/a.test.ts', accepted, `${accepted}\nit("broken", () => {`)).toMatch(/could not parse/);
    expect(testFileWeakening('tests/a.test.ts', 'it("x", () => { expect(1', accepted)).toMatch(/could not parse/);
    expect(testFileWeakening('tests/a.test.ts', accepted, undefined)).toBe('deleted a test file');
    expect(testFileWeakening('tests/helpers.ts', 'export const fixture = 1;', undefined)).toBeUndefined();
    expect(testFileWeakening('tests/a.test.ts', undefined, accepted)).toBeUndefined();
    expect(testFileWeakening('app/test_models.py', 'def test_a():\n    assert 1', 'def test_b():\n    pass')).toBeUndefined();
    expect(testFileWeakening('app/test_models.py', 'def test_a():\n    assert 1', undefined)).toBe('deleted a test file');
    expect(testFileWeakening('src/accounts.ts', accepted, undefined)).toBeUndefined();
  });
});
