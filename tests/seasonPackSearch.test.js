const test = require('node:test');
const assert = require('node:assert/strict');
const seasonPackSearch = require('../src/services/seasonPackSearch');

test.afterEach(() => {
  seasonPackSearch.clear('test');
});

test('season pack mode defaults to background and preserves legacy off', () => {
  assert.equal(seasonPackSearch.resolveMode({}, 'nzbdav'), 'background');
  assert.equal(seasonPackSearch.resolveMode({ NZB_INCLUDE_SEASON_PACKS: 'false' }, 'nzbdav'), 'off');
  assert.equal(seasonPackSearch.resolveMode({ NZB_SEASON_PACK_MODE: 'wait' }, 'nzbdav'), 'wait');
  assert.equal(seasonPackSearch.resolveMode({ NZB_SEASON_PACK_MODE: 'background' }, 'native'), 'off');
});

test('season snapshot merge only exposes packs covering the requested episode', () => {
  const snapshot = [
    { title: 'Show S02E01-E05 1080p', downloadUrl: 'https://example.test/range.nzb' },
    { title: 'Show Season 2 Complete 1080p', downloadUrl: 'https://example.test/season.nzb' },
  ];
  const episodeFive = seasonPackSearch.mergeSnapshotResults([], snapshot, { season: 2, episode: 5 });
  const episodeSix = seasonPackSearch.mergeSnapshotResults([], snapshot, { season: 2, episode: 6 });

  assert.equal(episodeFive.length, 2);
  assert.equal(episodeSix.length, 1);
  assert.equal(episodeFive[0].packType, 'episode-range');
  assert.equal(episodeSix[0].packType, 'season');

  const noDuplicate = seasonPackSearch.mergeSnapshotResults(episodeFive, snapshot, { season: 2, episode: 5 });
  assert.equal(noDuplicate.length, 2);
});

test('concurrent requests share one season search and reuse its positive snapshot', async () => {
  let calls = 0;
  const task = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      results: [{ title: 'Show Season 2 Complete', downloadUrl: 'https://example.test/pack.nzb' }],
      sourceOutcomes: [{ query: 'Show Season 2', status: 'ok' }],
    };
  };

  const first = seasonPackSearch.getOrStart('season-2', task);
  const second = seasonPackSearch.getOrStart('season-2', task);
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(first.promise, second.promise);

  const completed = await first.promise;
  const reused = seasonPackSearch.getOrStart('season-2', task);
  assert.equal(calls, 1);
  assert.equal(completed.status, 'ready');
  assert.equal(reused.snapshot.status, 'ready');
  assert.equal((await reused.promise).results.length, 1);
});

test('a successful empty search is negative-cached without rerunning the task', async () => {
  let calls = 0;
  const task = async () => {
    calls += 1;
    return { results: [], sourceOutcomes: [{ query: 'Show S02', status: 'ok' }] };
  };
  const first = seasonPackSearch.getOrStart('negative-season', task);
  assert.equal((await first.promise).status, 'negative');
  const second = seasonPackSearch.getOrStart('negative-season', task);
  assert.equal(second.snapshot.status, 'negative');
  assert.equal(calls, 1);
});

test('useful results from an incomplete search publish a short-lived partial snapshot', async () => {
  const job = seasonPackSearch.getOrStart('partial-season', async () => ({
    results: [{ title: 'Show Season 2 Complete', downloadUrl: 'https://example.test/partial.nzb' }],
    sourceOutcomes: [{ query: 'Show S02', status: 'partial' }],
    partial: true,
  }));
  const snapshot = await job.promise;
  assert.equal(snapshot.status, 'ready_partial');
  assert.equal(snapshot.results.length, 1);
});

test('global pack search concurrency is bounded', async () => {
  const previous = process.env.NZB_SEASON_PACK_MAX_CONCURRENT_SEARCHES;
  process.env.NZB_SEASON_PACK_MAX_CONCURRENT_SEARCHES = '1';
  let active = 0;
  let maximumActive = 0;
  const task = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { results: [] };
  };
  try {
    const a = seasonPackSearch.getOrStart('bounded-a', task);
    const b = seasonPackSearch.getOrStart('bounded-b', task);
    await Promise.all([a.promise, b.promise]);
    assert.equal(maximumActive, 1);
  } finally {
    if (previous === undefined) delete process.env.NZB_SEASON_PACK_MAX_CONCURRENT_SEARCHES;
    else process.env.NZB_SEASON_PACK_MAX_CONCURRENT_SEARCHES = previous;
  }
});

test('the queue rejects excess work without retaining another pending snapshot', async () => {
  const previousConcurrent = process.env.NZB_SEASON_PACK_MAX_CONCURRENT_SEARCHES;
  const previousQueued = process.env.NZB_SEASON_PACK_MAX_QUEUED_SEARCHES;
  process.env.NZB_SEASON_PACK_MAX_CONCURRENT_SEARCHES = '1';
  process.env.NZB_SEASON_PACK_MAX_QUEUED_SEARCHES = '0';
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  try {
    const first = seasonPackSearch.getOrStart('queue-first', async () => {
      await blocker;
      return { results: [] };
    });
    const rejected = seasonPackSearch.getOrStart('queue-rejected', async () => ({ results: [] }));
    assert.equal(first.started, true);
    assert.equal(rejected.started, false);
    assert.equal(rejected.rejected, true);
    assert.equal(rejected.snapshot.status, 'overloaded');
    assert.equal(seasonPackSearch.getSnapshot('queue-rejected'), null);
    release();
    await first.promise;
  } finally {
    release?.();
    if (previousConcurrent === undefined) delete process.env.NZB_SEASON_PACK_MAX_CONCURRENT_SEARCHES;
    else process.env.NZB_SEASON_PACK_MAX_CONCURRENT_SEARCHES = previousConcurrent;
    if (previousQueued === undefined) delete process.env.NZB_SEASON_PACK_MAX_QUEUED_SEARCHES;
    else process.env.NZB_SEASON_PACK_MAX_QUEUED_SEARCHES = previousQueued;
  }
});

test('a stuck job is converted into a transient retryable error by the watchdog', async () => {
  const previous = process.env.NZB_SEASON_PACK_JOB_TIMEOUT_MS;
  process.env.NZB_SEASON_PACK_JOB_TIMEOUT_MS = '5';
  try {
    const job = seasonPackSearch.getOrStart('timeout-season', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { results: [] };
    });
    const snapshot = await job.promise;
    assert.equal(snapshot.status, 'transient_error');
    assert.match(snapshot.error, /exceeded 5 ms/);
  } finally {
    if (previous === undefined) delete process.env.NZB_SEASON_PACK_JOB_TIMEOUT_MS;
    else process.env.NZB_SEASON_PACK_JOB_TIMEOUT_MS = previous;
  }
});
