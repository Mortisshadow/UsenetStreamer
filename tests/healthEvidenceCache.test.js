const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExactEvidenceKey,
  runWithExactHealthEvidence,
  clearHealthEvidenceCache,
} = require('../src/cache/healthEvidenceCache');

test('exact positive health evidence is shared in flight and reused by content', async () => {
  clearHealthEvidenceCache();
  const key = buildExactEvidenceKey({
    nzbPayload: '<nzb><file subject="Example"><segments /></file></nzb>',
    triageConfig: { nntpConfig: { host: 'news.example.test', port: 563, tls: true } },
    requestedEpisode: { season: 2, episode: 5 },
    isSeasonPack: true,
  });
  let calls = 0;
  const task = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: 'verified', blockers: [], episodeCoverage: { status: 'covered' } };
  };

  const [first, coalesced] = await Promise.all([
    runWithExactHealthEvidence(key, task),
    runWithExactHealthEvidence(key, task),
  ]);
  const cached = await runWithExactHealthEvidence(key, task);

  assert.equal(calls, 1);
  assert.equal(first.source, 'live');
  assert.equal(coalesced.source, 'flight');
  assert.equal(cached.source, 'cache');
  assert.equal(cached.value.status, 'verified');
  clearHealthEvidenceCache();
});

test('health evidence never caches non-verified decisions and is episode scoped', async () => {
  clearHealthEvidenceCache();
  const base = {
    nzbPayload: '<nzb><file subject="Season pack"><segments /></file></nzb>',
    triageConfig: { nntpConfig: { host: 'news.example.test', port: 563, tls: true } },
    isSeasonPack: true,
  };
  const episodeFiveKey = buildExactEvidenceKey({
    ...base,
    requestedEpisode: { season: 2, episode: 5 },
  });
  const episodeSixKey = buildExactEvidenceKey({
    ...base,
    requestedEpisode: { season: 2, episode: 6 },
  });
  assert.notEqual(episodeFiveKey, episodeSixKey);

  let calls = 0;
  const blockedTask = async () => {
    calls += 1;
    return { status: 'blocked', blockers: ['missing-segments'] };
  };
  assert.equal((await runWithExactHealthEvidence(episodeFiveKey, blockedTask)).source, 'live');
  assert.equal((await runWithExactHealthEvidence(episodeFiveKey, blockedTask)).source, 'live');
  assert.equal(calls, 2);
  clearHealthEvidenceCache();
});
