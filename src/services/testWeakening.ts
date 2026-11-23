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
/** `it.only(...)`, `test.concurrent(...)`: still one active test. */
const MODIFIERS = new Set(['only', 'concurrent', 'sequential', 'fails', 'failing']);
/** `it.each(table)(...)`, `test.runIf(cond)(...)`: the outer call is the test, the inner call builds it. */
const BUILDERS = new Set(['each', 'for', 'runIf', 'skipIf']);
const DISABLING = new Set(['skip', 'todo', 'fixme', 'skipIf']);
/** Position data and comments: never part of what the code does. */
const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);

export interface TestStrength {
  active: number;
  inactive: number;
  assertions: number;
  /** Titles of active tests (their own title, not the suite's), `<dynamic>` when computed. */
  titles: string[];
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

/** A callee as a name and member chain: `it.skip.each(t)` is `it` + [skip, each], reached through a call. */
function calleeChain(callee: unknown): { root: string; props: string[]; throughCall: boolean } | undefined {
  const props: string[] = [];
  let throughCall = false;
  let node = callee;
  while (isNode(node)) {
    if (node.type === 'Identifier') return { root: String(node.name), props, throughCall };
    if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed && isNode(node.property) && node.property.type === 'Identifier') {
      props.unshift(String(node.property.name));
      node = node.object;
    } else if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      throughCall = true;
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

type CallKind = 'active' | 'inactive' | 'assertion' | undefined;

/** What one call is: an active or disabled test or suite, an assertion, or none of these. */
function callKind(node: AstNode): CallKind {
  const chain = calleeChain(node.callee);
  if (!chain) return undefined;
  const { root, props, throughCall } = chain;
  if (ASSERTION_FUNCTIONS.has(root)) return throughCall ? undefined : 'assertion';
  const disabledRoot = DISABLED_TEST_FUNCTIONS.has(root) || DISABLED_SUITE_FUNCTIONS.has(root);
  const testRoot = TEST_FUNCTIONS.has(root);
  if (!disabledRoot && !testRoot && !SUITE_FUNCTIONS.has(root)) return undefined;
  if (props.some(prop => !MODIFIERS.has(prop) && !BUILDERS.has(prop) && !DISABLING.has(prop))) return undefined;
  // The builder call itself (`it.each(table)`) is not a test; the call it returns is.
  if (props.some(prop => BUILDERS.has(prop)) !== throughCall) return undefined;
  if (disabledRoot || props.some(prop => DISABLING.has(prop))) return 'inactive';
  return testRoot ? 'active' : undefined;
}

function parserPlugins(filePath: string): ParserPlugin[] {
  if (/\.[cm]?tsx$/i.test(filePath)) return ['typescript', 'jsx', 'decorators-legacy'];
  if (/\.[cm]?ts$/i.test(filePath)) return ['typescript', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

/** Counts from the syntax tree. Throws when the source does not parse. */
export function testStrength(source: string, filePath = 'test.ts'): TestStrength {
  const ast = parse(source, {
    sourceType: 'unambiguous',
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowUndeclaredExports: true,
    errorRecovery: false,
    plugins: parserPlugins(filePath)
  }) as unknown as AstNode;
  const strength: TestStrength = { active: 0, inactive: 0, assertions: 0, titles: [] };
  const stack: AstNode[] = [ast];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const kind = callKind(node);
      if (kind === 'assertion') strength.assertions += 1;
      else if (kind === 'inactive') strength.inactive += 1;
      else if (kind === 'active') {
        strength.active += 1;
        strength.titles.push(title((node.arguments as unknown[])[0]));
      }
    }
    // Reversed, so nodes come off the stack in source order and titles read top to bottom.
    stack.push(...childNodes(node).reverse());
  }
  return strength;
}

/** Titles `before` had that `after` lost (each occurrence counts); computed titles are not compared. */
function missingTitles(before: readonly string[], after: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const item of after) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  const missing: string[] = [];
  for (const item of before) {
    if (item === '<dynamic>') continue;
    const left = remaining.get(item) ?? 0;
    if (left > 0) remaining.set(item, left - 1);
    else missing.push(item);
  }
  return missing;
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
export function testWeakening(before: string, after: string, filePath = 'test.ts'): string | undefined {
  const was = testStrength(before, filePath);
  const now = testStrength(after, filePath);
  const missing = missingTitles(was.titles, now.titles);
  if (now.active < was.active) return named('removed test cases', missing);
  if (now.inactive > was.inactive) return 'skipped or disabled tests';
  if (missing.length) return named('replaced test cases', missing);
  if (now.assertions < was.assertions) return 'removed assertions';
  return undefined;
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
