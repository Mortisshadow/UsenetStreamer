const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAdaptiveTriageBudget } = require('../src/utils/requestBudget');

test('caps blocking triage to the remaining response deadline', () => {
  const budget = computeAdaptiveTriageBudget({
    requestStartTs: 1000,
    now: 7600,
    configuredTriageBudgetMs: 25000,
    responseBudgetMs: 24000,
    responseReserveMs: 1000,
  });
  assert.equal(budget.elapsedMs, 6600);
  assert.equal(budget.triageBudgetMs, 16400);
});

test('keeps the configured triage limit when the response has ample time', () => {
  const budget = computeAdaptiveTriageBudget({
    requestStartTs: 1000,
    now: 1500,
    configuredTriageBudgetMs: 8000,
    responseBudgetMs: 24000,
    responseReserveMs: 1000,
  });
  assert.equal(budget.triageBudgetMs, 8000);
});

test('returns zero when the response deadline is already exhausted', () => {
  const budget = computeAdaptiveTriageBudget({
    requestStartTs: 1000,
    now: 26000,
    configuredTriageBudgetMs: 25000,
    responseBudgetMs: 24000,
    responseReserveMs: 1000,
  });
  assert.equal(budget.triageBudgetMs, 0);
});
