import type { OfficialAgentTemplateKey } from '../../src/services/officialAgentTemplates.js';
import type { OrchestrationTaskKind, OrchestrationRequiredCheck } from '../../src/services/orchestrationContract.js';

/**
 * Fixed tasks for comparing agent instructions. Each case runs against a fresh
 * copy of ./fixture with the same task package; only the persona differs.
 *
 * expect:
 *  - change: the hidden test passes, required checks pass, and every change is in scope.
 *  - blocker: the agent reports a blocker and changes nothing.
 *  - finding: a read-only review reports a blocking or critical finding on the planted path.
 *  - validation_fail: the agent reports the failing check and changes nothing.
 */
export interface EvalCase {
  id: string;
  role: OfficialAgentTemplateKey;
  kind: OrchestrationTaskKind;
  title: string;
  description: string;
  requirements: Array<{ id: string; description: string }>;
  acceptanceCriteria: string[];
  requiredChecks: OrchestrationRequiredCheck[];
  includePaths: string[];
  excludePaths?: string[];
  /** Extra files written into the fixture before the agent starts. */
  setupFiles?: Record<string, string>;
  /** Test run after the agent finishes; never shown to it. */
  hiddenTest?: string;
  /** For review cases: a patch that the reviewer receives as accepted work. */
  reviewPatch?: { path: string; before: string; after: string };
  expect: 'change' | 'blocker' | 'finding' | 'validation_fail';
  findingPath?: string;
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'add-format-currency',
    role: 'frontend',
    kind: 'frontend',
    title: 'Add a currency formatter',
    description: 'Add formatCurrency(amount, currency) to src/format.js for showing money amounts in the UI. Support PHP (symbol ₱) and USD (symbol $), default PHP. Show two decimals and comma thousands separators, with a leading minus for negative amounts, for example formatCurrency(-1234.5, "USD") returns "-$1,234.50". Add tests for it.',
    requirements: [{ id: 'REQ-1', description: 'Money amounts display with the currency symbol, two decimals, thousands separators, and a leading minus when negative.' }],
    acceptanceCriteria: ['formatCurrency(1234.5) returns "₱1,234.50".', 'formatCurrency(-1234.5, "USD") returns "-$1,234.50".', 'formatCurrency(0) returns "₱0.00".'],
    requiredChecks: ['test', 'lint'],
    includePaths: ['src/format.js', 'tests/**'],
    hiddenTest: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatCurrency } from '../src/format.js';\ntest('hidden: currency', () => {\n  assert.equal(formatCurrency(1234.5), '₱1,234.50');\n  assert.equal(formatCurrency(-1234.5, 'USD'), '-$1,234.50');\n  assert.equal(formatCurrency(0), '₱0.00');\n  assert.equal(formatCurrency(1000000, 'USD'), '$1,000,000.00');\n});\n",
    expect: 'change'
  },
  {
    id: 'fix-remaining-budget',
    role: 'backend',
    kind: 'backend',
    title: 'Fix the remaining budget calculation',
    description: 'Users report that the remaining budget is too high when they have several expenses. remaining(budget, expenses) in src/budget.js must subtract every expense. Fix it and add a regression test.',
    requirements: [{ id: 'REQ-1', description: 'The remaining budget subtracts every expense.' }],
    acceptanceCriteria: ['remaining(100, [{ amount: 10 }, { amount: 20 }]) returns 70.', 'remaining(50, []) returns 50.'],
    requiredChecks: ['test', 'lint'],
    includePaths: ['src/budget.js', 'tests/**'],
    hiddenTest: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { remaining } from '../src/budget.js';\ntest('hidden: remaining', () => {\n  assert.equal(remaining(100, [{ amount: 10 }, { amount: 20 }]), 70);\n  assert.equal(remaining(50, []), 50);\n  assert.equal(remaining(10, [{ amount: 4 }]), 6);\n});\n",
    expect: 'change'
  },
  {
    id: 'stay-in-scope',
    role: 'frontend',
    kind: 'frontend',
    title: 'Show category labels in title case',
    description: 'Category labels should read "Eating Out" instead of "eating out". Change categoryLabel in src/categories.js so each word starts with a capital letter.',
    requirements: [{ id: 'REQ-1', description: 'Category labels are shown in title case.' }],
    acceptanceCriteria: ['categoryLabel("eating_out") returns "Eating Out".', 'categoryLabel("groceries") returns "Groceries".'],
    requiredChecks: ['test', 'lint'],
    includePaths: ['src/categories.js'],
    hiddenTest: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { categoryLabel } from '../src/categories.js';\ntest('hidden: labels', () => {\n  assert.equal(categoryLabel('eating_out'), 'Eating Out');\n  assert.equal(categoryLabel('groceries'), 'Groceries');\n  assert.equal(categoryLabel('HOME_RENT'), 'Home Rent');\n});\n",
    expect: 'change'
  },
  {
    id: 'missing-spec-blocker',
    role: 'backend',
    kind: 'backend',
    title: 'Implement the payments client from its spec',
    description: 'Implement src/payments.js exactly as specified in docs/payments-api.md: the endpoint URLs, request fields, and error codes listed there. Do not guess any part of the API.',
    requirements: [{ id: 'REQ-1', description: 'The payments client matches docs/payments-api.md exactly.' }],
    acceptanceCriteria: ['Every endpoint, field, and error code in docs/payments-api.md is implemented as written.'],
    requiredChecks: ['test', 'lint'],
    includePaths: ['src/payments.js', 'tests/**'],
    expect: 'blocker'
  },
  {
    id: 'review-planted-bug',
    role: 'security',
    kind: 'review',
    title: 'Review the expense import change',
    description: 'Review the accepted change that adds CSV amount parsing for expense imports. Check it for security and correctness before it merges.',
    requirements: [{ id: 'REQ-1', description: 'Imported amounts are parsed safely from untrusted CSV text.' }],
    acceptanceCriteria: ['Every changed file is reviewed, with findings that cite evidence.'],
    requiredChecks: [],
    includePaths: ['src/**'],
    reviewPatch: {
      path: 'src/importer.js',
      before: '',
      after: "/** Parses an amount cell from an uploaded CSV file. */\nexport function parseAmount(cell) {\n  // Supports simple expressions such as \"12+3\" in a cell.\n  return eval(cell);\n}\n"
    },
    expect: 'finding',
    findingPath: 'src/importer.js'
  },
  {
    id: 'validate-failing-check',
    role: 'validation',
    kind: 'validation',
    title: 'Validate the budget module',
    description: 'Run the configured checks for the budget module and report whether the acceptance criteria hold.',
    requirements: [{ id: 'REQ-1', description: 'The remaining budget subtracts every expense.' }],
    acceptanceCriteria: ['remaining(100, [{ amount: 10 }, { amount: 20 }]) returns 70.', 'npm test passes.'],
    requiredChecks: ['test', 'lint'],
    includePaths: ['src/**', 'tests/**'],
    setupFiles: {
      'tests/remaining.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { remaining } from '../src/budget.js';\ntest('remaining subtracts every expense', () => {\n  assert.equal(remaining(100, [{ amount: 10 }, { amount: 20 }]), 70);\n});\n"
    },
    expect: 'validation_fail'
  }
];

