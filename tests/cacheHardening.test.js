const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');

const diskNzbCache = require('../src/cache/diskNzbCache');
const nzbdavStreamCache = require('../src/cache/nzbdavCache');
const nzbdav = require('../src/services/nzbdav');
const proxyAgent = require('../src/utils/proxyAgent');

test('a disk-cache clear revokes an in-flight payload writer', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usenetstreamer-cache-race-'));
  const previousDir = process.env.NZB_CACHE_DIR;
  const originalWriteFile = fs.promises.writeFile;
  let releaseWrite;
  let writerEntered;
  const writerStarted = new Promise((resolve) => { writerEntered = resolve; });
  const writerGate = new Promise((resolve) => { releaseWrite = resolve; });

  process.env.NZB_CACHE_DIR = cacheDir;
  diskNzbCache.reloadConfig();
  fs.promises.writeFile = async (file, data, options) => {
    if (String(file).includes('.nzb.') && String(file).endsWith('.tmp')) {
      writerEntered();
      await writerGate;
    }
    return originalWriteFile.call(fs.promises, file, data, options);
  };

  try {
    const url = 'https://example.test/late.nzb';
    const write = diskNzbCache.cacheToDisk(url, '<nzb></nzb>');
    await writerStarted;
    diskNzbCache.clearDiskCache('race-test');
    releaseWrite();
    await write;

    assert.equal(diskNzbCache.getFromDisk(url), null);
    assert.deepEqual(fs.readdirSync(cacheDir).filter((name) => name.endsWith('.nzb')), []);
  } finally {
    fs.promises.writeFile = originalWriteFile;
    releaseWrite();
    diskNzbCache.clearDiskCache('test-cleanup');
    if (previousDir === undefined) delete process.env.NZB_CACHE_DIR;
    else process.env.NZB_CACHE_DIR = previousDir;
    diskNzbCache.reloadConfig();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('disk-cache index never persists credential-bearing download URLs', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usenetstreamer-cache-secret-'));
  const previousDir = process.env.NZB_CACHE_DIR;
  const secretUrl = 'https://indexer.example/api?t=get&apikey=top-secret&id=42';
  const hash = crypto.createHash('sha256').update(secretUrl).digest('hex').slice(0, 32);
  fs.writeFileSync(path.join(cacheDir, `${hash}.nzb`), '<nzb></nzb>');
  fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify([{
    url: secretUrl,
    hash,
    bytes: 11,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  }]));
  process.env.NZB_CACHE_DIR = cacheDir;
  diskNzbCache.reloadConfig();
  try {
    assert.ok(diskNzbCache.getFromDisk(secretUrl));
    const indexText = fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8');
    assert.equal(indexText.includes('top-secret'), false);
    assert.equal(indexText.includes('apikey='), false);
  } finally {
    if (previousDir === undefined) delete process.env.NZB_CACHE_DIR;
    else process.env.NZB_CACHE_DIR = previousDir;
    diskNzbCache.reloadConfig();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a cleared NZBDav builder may return but cannot repopulate the cache', async () => {
  nzbdavStreamCache.clearNzbdavStreamCache('test-start');
  let resolveBuilder;
  const builderGate = new Promise((resolve) => { resolveBuilder = resolve; });
  const pending = nzbdavStreamCache.getOrCreateNzbdavStream('episode', () => builderGate);

  nzbdavStreamCache.clearNzbdavStreamCache('race-test');
  resolveBuilder({ url: 'https://example.test/stale' });

  assert.deepEqual(await pending, { url: 'https://example.test/stale' });
  assert.equal(nzbdavStreamCache.getCachedNzbdavStream('episode'), null);
});

test('a direct NZBDav cache replacement wins over an older builder', async () => {
  nzbdavStreamCache.clearNzbdavStreamCache('test-start');
  let resolveBuilder;
  const builderGate = new Promise((resolve) => { resolveBuilder = resolve; });
  const pending = nzbdavStreamCache.getOrCreateNzbdavStream('episode', () => builderGate);
  const replacement = { url: 'https://example.test/current' };
  nzbdavStreamCache.cacheNzbdavStreamResult('episode', replacement);
  resolveBuilder({ url: 'https://example.test/stale' });
  await pending;

  assert.equal(nzbdavStreamCache.getCachedNzbdavStream('episode'), replacement);
});

test('NZBDav file-size cache is bounded and LRU ordered', () => {
  const previousMax = process.env.NZBDAV_FILE_SIZE_CACHE_MAX_ENTRIES;
  process.env.NZBDAV_FILE_SIZE_CACHE_MAX_ENTRIES = '2';
  nzbdav.reloadConfig();
  try {
    nzbdav.setCachedFileSize('first', 1);
    nzbdav.setCachedFileSize('second', 2);
    assert.equal(nzbdav.getCachedFileSize('first'), 1); // touch first
    nzbdav.setCachedFileSize('third', 3);
    assert.equal(nzbdav.getCachedFileSize('second'), null);
    assert.equal(nzbdav.getCachedFileSize('first'), 1);
    assert.equal(nzbdav.getNzbdavLocalCacheStats().fileSizes, 2);
  } finally {
    if (previousMax === undefined) delete process.env.NZBDAV_FILE_SIZE_CACHE_MAX_ENTRIES;
    else process.env.NZBDAV_FILE_SIZE_CACHE_MAX_ENTRIES = previousMax;
    nzbdav.reloadConfig();
  }
});

test('NZBDav history snapshot cache is bounded', async () => {
  const previous = {
    url: process.env.NZBDAV_URL,
    key: process.env.NZBDAV_API_KEY,
    max: process.env.NZBDAV_HISTORY_CACHE_MAX_ENTRIES,
  };
  const originalGet = axios.get;
  process.env.NZBDAV_URL = 'https://nzbdav.example';
  process.env.NZBDAV_API_KEY = 'test-key';
  process.env.NZBDAV_HISTORY_CACHE_MAX_ENTRIES = '2';
  axios.get = async () => ({ status: 200, data: { status: true, history: { slots: [] } } });
  nzbdav.reloadConfig();
  try {
    await nzbdav.fetchNzbdavHistorySnapshot(['one']);
    await nzbdav.fetchNzbdavHistorySnapshot(['two']);
    await nzbdav.fetchNzbdavHistorySnapshot(['three']);
    const stats = nzbdav.getNzbdavLocalCacheStats();
    assert.equal(stats.historySnapshots, 2);
    assert.equal(stats.historySnapshotMaxEntries, 2);
  } finally {
    axios.get = originalGet;
    for (const [name, value] of [
      ['NZBDAV_URL', previous.url],
      ['NZBDAV_API_KEY', previous.key],
      ['NZBDAV_HISTORY_CACHE_MAX_ENTRIES', previous.max],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    nzbdav.reloadConfig();
  }
});

test('proxy agent pruning destroys removed agents without exposing credential keys', () => {
  proxyAgent.clearProxyAgentCache();
  const removedUrl = 'http://user:secret@proxy-one.example:8080';
  const keptUrl = 'socks5://user:secret@proxy-two.example:1080';
  const removed = proxyAgent.buildProxyAgents(removedUrl, 'https://indexer.example/api');
  proxyAgent.buildProxyAgents(keptUrl, 'https://indexer.example/api');
  let destroyed = 0;
  const originalDestroy = removed.httpAgent.destroy.bind(removed.httpAgent);
  removed.httpAgent.destroy = () => { destroyed += 1; return originalDestroy(); };

  proxyAgent.pruneProxyAgentCache([keptUrl]);

  assert.equal(destroyed, 1);
  const stats = proxyAgent.getProxyAgentCacheStats();
  assert.equal(stats.entries, 1);
  assert.ok(stats.maxEntries > 0);
  assert.equal(JSON.stringify(stats).includes('secret'), false);
  proxyAgent.clearProxyAgentCache();
});
