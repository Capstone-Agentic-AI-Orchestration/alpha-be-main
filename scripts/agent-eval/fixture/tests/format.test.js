import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPercent } from '../src/format.js';

test('formats a percentage', () => {
  assert.equal(formatPercent(0.425), '43%');
});
