import { parse, type ParserPlugin } from '@babel/parser';

/**
 * Whether a change weakened a test file. JavaScript and TypeScript are read with a real parser
 * (@babel/parser): active tests, disabled tests and assertions are counted from the syntax tree, so
 * text in comments, strings, regular expressions or templates never counts, and test titles are
 * compared so swapping one test for another is visible. If either version does not parse, the
 * change is treated as weakening (fail closed). Other languages fall back to "a test file was
 * deleted".
 */

/** Test file names in languages the parser does not read. */
const OTHER_LANGUAGE_TEST_NAMES = [
  /(^|\/)test_[^/]+\.py$/, // Python: test_models.py
  /_test\.(py|go)$/, // Python and Go: store_test.go
  /_spec\.rb$/, // Ruby: user_spec.rb
  /(^|\/)\w*Tests?\.(java|kt|cs)$/ // Java, Kotlin, C#: UserServiceTest.java
];
/** Code in another language that sits in a test folder. */
const OTHER_LANGUAGE_TEST_FOLDER = /(^|\/)(tests?|__tests__|spec)\/.+\.(py|go|rb|java|kt|cs|php|rs|swift)$/;

/** Test files a change must not weaken: test folders, `*.test.*` / `*.spec.*`, and other languages' test names. */
const TEST_FILE_PATTERNS = [
  /(^|\/)(tests?|__tests__)\//i, // anything in a test folder
  /\.(test|spec)\.[cm]?[jt]sx?$/i, // a.test.ts, b.spec.tsx
  ...OTHER_LANGUAGE_TEST_NAMES.map(pattern => new RegExp(pattern.source, 'i'))
];

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some(pattern => pattern.test(filePath));
}

/** Sources the parser reads. */
const JS_SOURCE = /\.[cm]?[jt]sx?$/i;

/** A test in another language, by name or by sitting in a test folder with a code extension. */
function isOtherLanguageTest(filePath: string): boolean {
  return OTHER_LANGUAGE_TEST_NAMES.some(pattern => pattern.test(filePath)) || OTHER_LANGUAGE_TEST_FOLDER.test(filePath);
}

const TEST_FUNCTIONS = new Set(['it', 'test']);
const DISABLED_TEST_FUNCTIONS = new Set(['xit', 'xtest']);
const SUITE_FUNCTIONS = new Set(['describe', 'suite']);
const DISABLED_SUITE_FUNCTIONS = new Set(['xdescribe']);
const ASSERTION_FUNCTIONS = new Set(['expect', 'assert']);
/** `it.only(...)`, `test.concurrent(...)`: still one test that runs normally. */
const MODIFIERS = new Set(['only', 'concurrent', 'sequential']);
/** `test.fails(...)`, `it.failing(...)`: the test passes only while the code is broken. */
const INVERTING = new Set(['fails', 'failing']);
/** `it.each(table)(...)`, `test.runIf(cond)(...)`: the outer call is the test, the inner call builds it. */
const BUILDERS = new Set(['each', 'for', 'runIf', 'skipIf']);
const DISABLING = new Set(['skip', 'todo', 'fixme']);
/** Position data and comments: never part of what the code does. */
const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);

/**
 * How a test runs. `inverted`: it passes only when the code is broken (`fails`, `failing`).
 * `conditional`: `runIf`/`skipIf` with anything but a literal that always runs it. `disabled`:
 * skipped, todo, `x`-prefixed, or a condition that never runs it. Only `active` counts as kept.
 */
export type TestState = 'active' | 'inverted' | 'conditional' | 'disabled';

export interface TestStrength {
  active: number;
  /** Tests and suites that do not run normally (inverted, conditional or disabled). */
  inactive: number;
  assertions: number;
  /** Titles of active tests (their own title, not the suite's), `<dynamic>` when computed. */
  titles: string[];
  /** Every test with its state, so a title that stops running normally is visible. */
  tests: Array<{ title: string; state: TestState }>;
}

type AstNode = { type: string } & Record<string, unknown>;

function isNode(value: unknown): value is AstNode {
  return Boolean(value) && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (IGNORED_KEYS.has(key)) continue;
    if (Array.isArray(value)) children.push(...value.filter(isNode));
    else if (isNode(value)) children.push(value);
  }
  return children;
}

/** `true` or `false` when the argument is that literal, otherwise undefined (decided at run time). */
function literalBoolean(argument: unknown): boolean | undefined {
  return isNode(argument) && argument.type === 'BooleanLiteral' ? Boolean(argument.value) : undefined;
}

/** The member name a call's callee ends with: `test.runIf(cond)` gives `runIf`. */
function calledMember(call: AstNode): string | undefined {
  const callee = call.callee;
  if (!isNode(callee) || (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression')) return undefined;
  return isNode(callee.property) && callee.property.type === 'Identifier' ? String(callee.property.name) : undefined;
}

interface CalleeChain {
  root: string;
  props: string[];
  throughCall: boolean;
  /** The literal argument of a `runIf(...)` / `skipIf(...)` builder call, when it is one. */
  conditions: { runIf?: boolean; skipIf?: boolean };
}

/** A callee as a name and member chain: `it.skip.each(t)` is `it` + [skip, each], reached through a call. */
function calleeChain(callee: unknown): CalleeChain | undefined {
  const props: string[] = [];
  const conditions: CalleeChain['conditions'] = {};
  let throughCall = false;
  let node = callee;
  while (isNode(node)) {
    if (node.type === 'Identifier') return { root: String(node.name), props, throughCall, conditions };
    if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed && isNode(node.property) && node.property.type === 'Identifier') {
      props.unshift(String(node.property.name));
      node = node.object;
    } else if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      throughCall = true;
      const member = calledMember(node);
      if (member === 'runIf' || member === 'skipIf') conditions[member] = literalBoolean((node.arguments as unknown[])[0]);
      node = node.callee;
    } else if (node.type === 'TaggedTemplateExpression') {
      throughCall = true;
      node = node.tag;
    } else {
      return undefined;
    }
  }
  return undefined;
}

function title(argument: unknown): string {
  if (isNode(argument) && argument.type === 'StringLiteral') return String(argument.value);
  if (isNode(argument) && argument.type === 'TemplateLiteral' && Array.isArray(argument.expressions) && !argument.expressions.length) {
    const quasis = argument.quasis as Array<{ value: { cooked?: string; raw: string } }>;
    return quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('');
  }
  return '<dynamic>';
}

function isKnownProp(prop: string): boolean {
  return MODIFIERS.has(prop) || INVERTING.has(prop) || BUILDERS.has(prop) || DISABLING.has(prop);
}

/** How a test or suite runs, from how it is called. */
function testState(chain: CalleeChain, disabledRoot: boolean): TestState {
  const { props, conditions } = chain;
  if (disabledRoot || props.some(prop => DISABLING.has(prop))) return 'disabled';
  // skipIf(false) and runIf(true) always run the test; any other condition may not.
  if (props.includes('skipIf') && conditions.skipIf !== false) return conditions.skipIf === true ? 'disabled' : 'conditional';
  if (props.includes('runIf') && conditions.runIf !== true) return conditions.runIf === false ? 'disabled' : 'conditional';
  if (props.some(prop => INVERTING.has(prop))) return 'inverted';
  return 'active';
}

type CallKind = { kind: 'assertion' } | { kind: 'test'; state: TestState } | { kind: 'suite'; state: TestState } | undefined;

/** What one call is: a test or suite and how it runs, an assertion, or none of these. */
function callKind(node: AstNode): CallKind {
  const chain = calleeChain(node.callee);
  if (!chain) return undefined;
  const { root, props, throughCall } = chain;
  if (ASSERTION_FUNCTIONS.has(root)) return throughCall ? undefined : { kind: 'assertion' };
  const disabledRoot = DISABLED_TEST_FUNCTIONS.has(root) || DISABLED_SUITE_FUNCTIONS.has(root);
  const isTest = TEST_FUNCTIONS.has(root) || DISABLED_TEST_FUNCTIONS.has(root);
  if (!isTest && !SUITE_FUNCTIONS.has(root) && !DISABLED_SUITE_FUNCTIONS.has(root)) return undefined;
  if (!props.every(isKnownProp)) return undefined;
  // The builder call itself (`it.each(table)`) is not a test; the call it returns is.
  if (props.some(prop => BUILDERS.has(prop)) !== throughCall) return undefined;
  return { kind: isTest ? 'test' : 'suite', state: testState(chain, disabledRoot) };
}

function parserPlugins(filePath: string): ParserPlugin[] {
  if (/\.[cm]?tsx$/i.test(filePath)) return ['typescript', 'jsx', 'decorators-legacy'];
  if (/\.[cm]?ts$/i.test(filePath)) return ['typescript', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

/** An active test's title and what it does: its callee and every argument after the title. */
interface ActiveTest { title: string; body: string }

/** A node as text without positions or comments, so the same code written again compares equal. */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => (IGNORED_KEYS.has(key) ? undefined : item));
}

/** Adds one call to the counts: an assertion, a test with its state, or a suite that does not run normally. */
function countCall(strength: TestStrength, active: ActiveTest[], node: AstNode): void {
  const call = callKind(node);
  if (!call) return;
  if (call.kind === 'assertion') {
    strength.assertions += 1;
    return;
  }
  if (call.state !== 'active') strength.inactive += 1;
  if (call.kind === 'suite') return;
  const [titleArgument, ...rest] = node.arguments as unknown[];
  const testTitle = title(titleArgument);
  strength.tests.push({ title: testTitle, state: call.state });
  if (call.state === 'active') {
    strength.active += 1;
    strength.titles.push(testTitle);
    active.push({ title: testTitle, body: fingerprint({ callee: node.callee, rest }) });
  }
}

/** Counts from the syntax tree. Throws when the source does not parse. */
export function testStrength(source: string, filePath = 'test.ts'): TestStrength {
  return countTests(source, filePath).strength;
}

function countTests(source: string, filePath: string): { strength: TestStrength; active: ActiveTest[] } {
  const ast = parse(source, {
    sourceType: 'unambiguous',
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowUndeclaredExports: true,
    errorRecovery: false,
    plugins: parserPlugins(filePath)
  }) as unknown as AstNode;
  const strength: TestStrength = { active: 0, inactive: 0, assertions: 0, titles: [], tests: [] };
  const active: ActiveTest[] = [];
  const stack: AstNode[] = [ast];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') countCall(strength, active, node);
    // Reversed, so nodes come off the stack in source order and titles read top to bottom.
    stack.push(...childNodes(node).reverse());
  }
  return { strength, active };
}

/**
 * Titles `before` had that `after` lost (each occurrence counts); computed titles are not compared.
 * A test renamed with exactly the same code is kept, not lost: one new title per old test, so a
 * single test cannot stand in for two.
 */
function missingTitles(before: readonly ActiveTest[], after: readonly ActiveTest[]): string[] {
  const remaining = new Map<string, number>();
  for (const item of after) remaining.set(item.title, (remaining.get(item.title) ?? 0) + 1);
  const lost: ActiveTest[] = [];
  for (const item of before) {
    if (item.title === '<dynamic>') continue;
    const left = remaining.get(item.title) ?? 0;
    if (left > 0) remaining.set(item.title, left - 1);
    else lost.push(item);
  }
  // The titles `after` has that `before` did not, each usable once.
  const beforeCount = new Map<string, number>();
  for (const item of before) beforeCount.set(item.title, (beforeCount.get(item.title) ?? 0) + 1);
  const added = after.filter(item => {
    const left = beforeCount.get(item.title) ?? 0;
    if (left > 0) beforeCount.set(item.title, left - 1);
    return left === 0 && item.title !== '<dynamic>';
  });
  return lost.filter(item => {
    const index = added.findIndex(candidate => candidate.body === item.body);
    if (index === -1) return true;
    added.splice(index, 1);
    return false;
  }).map(item => item.title);
}

/** The reason with up to three of the missing titles: removed test cases (“a”, “b”, …). */
function named(reason: string, titles: readonly string[]): string {
  if (!titles.length) return reason;
  const shown = titles.slice(0, 3).map(item => '“' + item + '”');
  if (titles.length > 3) shown.push('…');
  return `${reason} (${shown.join(', ')})`;
}

/**
 * How `after` weakened `before`, or undefined when it kept every active test, its title, and every
 * assertion. Throws when either version does not parse; testFileWeakening turns that into weakening.
 */
const STATE_WEAKENING: Record<Exclude<TestState, 'active'>, string> = {
  inverted: 'turned tests into expected failures, which pass when the code is broken',
  conditional: 'made tests run only on a condition',
  disabled: 'skipped or disabled tests'
};

export function testWeakening(before: string, after: string, filePath = 'test.ts'): string | undefined {
  const { strength: was, active: wasActive } = countTests(before, filePath);
  const { strength: now, active: nowActive } = countTests(after, filePath);
  const missing = missingTitles(wasActive, nowActive);
  // Per title first: a test that is still there but no longer runs normally.
  for (const state of ['inverted', 'conditional', 'disabled'] as const) {
    const changed = missing.filter(item => now.tests.some(test => test.title === item && test.state === state));
    if (changed.length) return named(STATE_WEAKENING[state], changed);
  }
  if (now.active < was.active) return named('removed test cases', missing);
  if (now.inactive > was.inactive) return 'skipped or disabled tests';
  if (missing.length) return named('replaced test cases', missing);
  if (now.assertions < was.assertions) return 'removed assertions';
  return undefined;
}

/**
 * The titles of `before`'s active tests that `after` does not have word for word: same title and
 * same code (formatting and comments aside). Stricter than testWeakening, which counts assertions
 * but does not read them: an Orchestrator fix that restores tests is held to this. Computed titles
 * cannot be matched, so they count as not kept. Throws when either version does not parse.
 */
export function testsNotKeptExactly(before: string, after: string, filePath = 'test.ts'): string[] {
  const remaining = countTests(after, filePath).active.map(item => `${item.title}\n${item.body}`);
  return countTests(before, filePath).active.filter(item => {
    const index = item.title === '<dynamic>' ? -1 : remaining.indexOf(`${item.title}\n${item.body}`);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  }).map(item => item.title);
}

function isTestSource(filePath: string, content: string): boolean {
  if (!JS_SOURCE.test(filePath)) return isOtherLanguageTest(filePath);
  try {
    const strength = testStrength(content, filePath);
    return strength.active + strength.inactive + strength.assertions > 0;
  } catch {
    return true;
  }
}

/**
 * How a change weakened one test file, or undefined when it did not. `before` is undefined when the
 * file is new, `after` when the change deleted it. A JavaScript or TypeScript version that does not
 * parse fails closed: Alpha cannot show the tests were kept, so it does not assume they were.
 */
export function testFileWeakening(filePath: string, before: string | undefined, after: string | undefined): string | undefined {
  if (before === undefined || !isTestFile(filePath)) return undefined;
  if (after === undefined) return isTestSource(filePath, before) ? 'deleted a test file' : undefined;
  if (!JS_SOURCE.test(filePath)) return undefined;
  try {
    return testWeakening(before, after, filePath);
  } catch {
    return 'changed a test file Alpha could not parse, so it could not confirm the tests were kept';
  }
}
