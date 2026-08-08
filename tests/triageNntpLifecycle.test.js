const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/services/triage');

test('NNTP pool key changes when credentials rotate without exposing the password', () => {
  const base = { host: 'news.example.test', port: 563, user: 'alice', useTLS: true };
  const first = _test.buildPoolKey({ ...base, pass: 'old-secret' }, 4, 120000);
  const second = _test.buildPoolKey({ ...base, pass: 'new-secret' }, 4, 120000);

  assert.notEqual(first, second);
  assert.equal(first.includes('old-secret'), false);
  assert.equal(second.includes('new-secret'), false);
});

test('BODY timeout marks the client for eviction and ignores a late callback', async () => {
  let callback;
  const client = {
    body(_segmentId, cb) {
      callback = cb;
    },
  };

  await assert.rejects(
    _test.fetchSegmentBodyWithClient(client, 'article@example.test', 5),
    (err) => err.code === 'BODY_TIMEOUT' && err.dropClient === true,
  );

  assert.doesNotThrow(() => callback(null, 1, '<article@example.test>', Buffer.from('late')));
});

test('runWithClient drops a client after a timed-out BODY operation', async () => {
  const client = { body() {} };
  const releases = [];
  const pool = {
    async acquire() { return client; },
    release(releasedClient, options) { releases.push({ releasedClient, options }); },
  };

  await assert.rejects(
    _test.runWithClient(pool, (value) => _test.fetchSegmentBodyWithClient(value, 'stuck@example.test', 5)),
    { code: 'BODY_TIMEOUT' },
  );
  assert.deepEqual(releases, [{ releasedClient: client, options: { drop: true } }]);
});
