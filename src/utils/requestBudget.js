const DEFAULT_RESPONSE_BUDGET_MS = 24000;
const DEFAULT_RESPONSE_RESERVE_MS = 1000;

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function computeAdaptiveTriageBudget({
  requestStartTs,
  now = Date.now(),
  configuredTriageBudgetMs,
  responseBudgetMs = DEFAULT_RESPONSE_BUDGET_MS,
  responseReserveMs = DEFAULT_RESPONSE_RESERVE_MS,
} = {}) {
  const startedAt = finiteNonNegative(requestStartTs, now);
  const elapsedMs = Math.max(0, now - startedAt);
  const totalBudgetMs = finiteNonNegative(responseBudgetMs, DEFAULT_RESPONSE_BUDGET_MS);
  const reserveMs = finiteNonNegative(responseReserveMs, DEFAULT_RESPONSE_RESERVE_MS);
  const configuredMs = finiteNonNegative(configuredTriageBudgetMs, 0);
  const remainingResponseMs = Math.max(0, totalBudgetMs - elapsedMs - reserveMs);
  return {
    elapsedMs,
    responseBudgetMs: totalBudgetMs,
    responseReserveMs: reserveMs,
    remainingResponseMs,
    triageBudgetMs: Math.max(0, Math.min(configuredMs, remainingResponseMs)),
  };
}

module.exports = {
  DEFAULT_RESPONSE_BUDGET_MS,
  DEFAULT_RESPONSE_RESERVE_MS,
  computeAdaptiveTriageBudget,
};
