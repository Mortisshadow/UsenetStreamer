const test = require('node:test');
const assert = require('node:assert/strict');
const backgroundTriage = require('../src/services/backgroundTriage');
const { BackgroundTriageSession } = backgroundTriage;

const candidates = Array.from({ length: 6 }, (_, index) => ({
  title: `Show ${index + 1}`,
  downloadUrl: `https://example.test/${index + 1}.nzb`,
}));

test('background triage batches never exceed the remaining health-check budget', () => {
  const session = new BackgroundTriageSession('series:test', candidates, {}, {
    initialBatchSize: 6,
    maxEvaluate: 2,
  });
  const cursor = { index: 0 };
  const failedBatch = session._claimAttemptBudget(session._buildNextBatch(cursor, []));
  assert.equal(failedBatch.length, 2);

  // Fetch errors still consumed two Treasure-Maps NZB downloads. Queueing the
  // failed candidates for retry must not create more attempts past the limit.
  failedBatch.forEach((candidate) => session.decisions.set(candidate.downloadUrl, { status: 'fetch-error' }));
  assert.equal(session._buildNextBatch(cursor, failedBatch.slice()).length, 0);
  assert.equal(session._claimAttemptBudget(failedBatch).length, 0);

  session.close();
});

test('getOrStart atomically reuses an existing background session', async () => {
  const key = 'series:single-flight';
  const first = backgroundTriage.getOrStart(key, [], {}, {});
  const second = backgroundTriage.getOrStart(key, candidates, {}, {});

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.session, first.session);
  await first.session.runPromise;
  backgroundTriage.closeSession(key);
});
