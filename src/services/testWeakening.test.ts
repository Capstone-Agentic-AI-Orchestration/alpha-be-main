import { describe, expect, it } from 'vitest';
import { isTestFile, testFileWeakening, testStrength, testWeakening } from './testWeakening.js';

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
    expect(testStrength(accepted)).toEqual({ active: 2, inactive: 0, assertions: 2, titles: ['stores accounts', 'finds %s'] });
    const padded = `${accepted}\n// it("ghost", () => { expect(1).toBe(1); });\nconst note = "test(expect(";\n/* test(() => expect(1)) */`;
    expect(testStrength(padded)).toEqual(testStrength(accepted));
  });

  it('is not fooled by a quote inside a regular expression literal', () => {
    // The old scanner read the quote in the regex as opening a string, emptied the code after it, and lost the test.
    const withRegex = `${accepted}\nconst quote = /"/;\nit("keeps quotes", () => { expect(quote.test('"')).toBe(true); });`;
    expect(testStrength(withRegex)).toMatchObject({ active: 3, assertions: 3 });
    expect(testWeakening(withRegex, withRegex.replace('it("keeps quotes"', 'it.skip("keeps quotes"'))).toBe('removed test cases (“keeps quotes”)');
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
    expect(testWeakening(accepted, accepted.replace('it("stores', 'it.skip("stores'))).toBe('removed test cases (“stores accounts”)');
    expect(testWeakening(accepted, `${accepted}\ndescribe.skip("later", () => {});`)).toBe('skipped or disabled tests');
    expect(testWeakening(accepted, `${accepted}\nxit("later", () => {});`)).toBe('skipped or disabled tests');
    expect(testWeakening(accepted, accepted.replace('expect(accounts.size).toBe(0);', ''))).toBe('removed assertions');
    expect(testWeakening(accepted, accepted.replace('"stores accounts"', '"something easier"'))).toBe('replaced test cases (“stores accounts”)');
    expect(testWeakening(accepted, `${accepted}\nimport { signIn } from "../src/auth";\nit("signs in", () => { expect(signIn).toBeDefined(); });`)).toBeUndefined();
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
