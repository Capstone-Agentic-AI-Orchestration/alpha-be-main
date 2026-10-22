import test from 'node:test';
import assert from 'node:assert/strict';
import { totalSpent } from '../src/budget.js';

test('totals expenses', () => {
  assert.equal(totalSpent([{ amount: 5 }, { amount: 7 }]), 12);
});
