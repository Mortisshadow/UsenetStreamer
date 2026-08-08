const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runWithIndexerSerialization, runNzbDownloadSingleFlight } = require('../src/services/triage/runner');
const diskNzbCache = require('../src/cache/diskNzbCache');
const { partitionHistorySlots } = require('../src/services/nzbdav');

test('serialized indexer tasks never overlap across concurrent callers', async () => {
  let active = 0;
  let maximumActive = 0;
  const run = () => runWithIndexerSerialization('treasure-maps', true, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });

  await Promise.all([run(), run(), run()]);
  assert.equal(maximumActive, 1);
});

test('serialized indexer wait respects its deadline without wedging the chain', async () => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const first = runWithIndexerSerialization('deadline-indexer', true, async () => {
    firstStarted();
    await new Promise((resolve) => { releaseFirst = resolve; });
  });
  await started;

  await assert.rejects(
    runWithIndexerSerialization('deadline-indexer', true, async () => {}, Date.now() + 20),
    { code: 'TRIAGE_TIMEOUT' },
  );
  releaseFirst();
  await first;
  await runWithIndexerSerialization('deadline-indexer', true, async () => {});
});

test('identical concurrent NZB downloads share one in-flight operation', async () => {
  let calls = 0;
  const task = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return '<nzb />';
  };
  const values = await Promise.all([
    runNzbDownloadSingleFlight('https://example.test/a.nzb', task),
    runNzbDownloadSingleFlight('https://example.test/a.nzb', task),
    runNzbDownloadSingleFlight('https://example.test/a.nzb', task),
  ]);
  assert.deepEqual(values, ['<nzb />', '<nzb />', '<nzb />']);
  assert.equal(calls, 1);
});

test('one NZBDav history snapshot partitions completed and failed jobs', () => {
  const snapshot = partitionHistorySlots([
    { status: 'Completed', nzo_id: 'done-1', job_name: 'Show.S02E05' },
    { Status: 'Failed', NzoId: 'failed-1', JobName: 'Movie.2026', FailMessage: 'missing' },
    { status: 'Downloading', nzo_id: 'active-1', job_name: 'Ignored' },
  ], 'Tv');
  assert.equal(snapshot.completed.size, 1);
  assert.equal(snapshot.failed.size, 1);
  assert.equal(snapshot.completed.values().next().value.nzoId, 'done-1');
  assert.equal(snapshot.failed.values().next().value.failMessage, 'missing');
});

test('asynchronous disk writes remain immediately readable through pending cache', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usenetstreamer-cache-'));
  const previousDir = process.env.NZB_CACHE_DIR;
  process.env.NZB_CACHE_DIR = cacheDir;
  diskNzbCache.reloadConfig();

  try {
    const payload = '<?xml version="1.0"?><nzb></nzb>';
    const write = diskNzbCache.cacheToDisk('https://example.test/item.nzb?token=secret', payload, {
      title: 'Example',
    });
    assert.equal(diskNzbCache.getFromDisk('https://example.test/item.nzb?token=secret').payloadBuffer.toString('utf8'), payload);
    await write;
    assert.equal(diskNzbCache.getFromDisk('https://example.test/item.nzb?token=secret').payloadBuffer.toString('utf8'), payload);
    diskNzbCache.clearDiskCache('test');
  } finally {
    if (previousDir === undefined) delete process.env.NZB_CACHE_DIR;
    else process.env.NZB_CACHE_DIR = previousDir;
    diskNzbCache.reloadConfig();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
