const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const constants = require('../src/config/constants');
const nzbdav = require('../src/services/nzbdav');
const axios = require('axios');

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('NZBDAV backend configuration advertises the supported modes', () => {
  assert.deepEqual(constants.NZBDAV_BACKEND_VALUES, ['auto', 'generic', 'infinidysk']);
  assert.equal(constants.DEFAULT_NZBDAV_BACKEND, 'auto');
  assert.ok(constants.ADMIN_CONFIG_KEYS.includes('NZBDAV_BACKEND'));
});

test('native JSON listing succeeds', async () => {
  const oldBackend = process.env.NZBDAV_BACKEND;
  const oldUrl = process.env.NZBDAV_URL;
  const oldApiKey = process.env.NZBDAV_API_KEY;
  const oldPost = axios.post;
  process.env.NZBDAV_BACKEND = 'infinidysk';
  process.env.NZBDAV_URL = 'http://infini.test';
  process.env.NZBDAV_API_KEY = 'api-secret';
  let called = 0;
  axios.post = async (url, body, options) => {
    called += 1;
    assert.equal(url, 'http://infini.test/api/list-webdav-directory');
    assert.equal(body, 'directory=%2Fcontent%2Ftest');
    assert.equal(options.headers['x-api-key'], 'api-secret');
    return { status: 200, data: { items: [{ name: 'movie.mkv', isDirectory: false, size: 42 }] } };
  };
  try {
    nzbdav.reloadConfig();
    const entries = await nzbdav.listWebdavDirectory('/content/test');
    assert.deepEqual(entries[0].name, 'movie.mkv');
    assert.equal(called, 1);
  } finally { axios.post = oldPost; restoreEnv('NZBDAV_BACKEND', oldBackend); restoreEnv('NZBDAV_URL', oldUrl); restoreEnv('NZBDAV_API_KEY', oldApiKey); nzbdav.reloadConfig(); }
});

test('auto falls back to WebDAV on an unsupported native endpoint', async () => {
  const oldBackend = process.env.NZBDAV_BACKEND;
  process.env.NZBDAV_BACKEND = 'auto';
  nzbdav.reloadConfig();
  let fallbackCalls = 0;
  try {
    const entries = await nzbdav.listWebdavDirectory('/content/test', {
      nativeLister: async () => { throw new Error('capability: endpoint returned 404'); },
      webdavLister: async (normalizedPath, relativePath) => {
        fallbackCalls += 1;
        assert.equal(normalizedPath, '/content/test');
        assert.equal(relativePath, 'content/test');
        return [{ name: 'fallback.mkv', isDirectory: false, size: 7 }];
      },
    });
    assert.equal(fallbackCalls, 1);
    assert.equal(entries[0].name, 'fallback.mkv');
  } finally {
    if (oldBackend === undefined) delete process.env.NZBDAV_BACKEND;
    else process.env.NZBDAV_BACKEND = oldBackend;
    nzbdav.reloadConfig();
  }
});

test('generic backend never calls the native API', async () => {
  const oldBackend = process.env.NZBDAV_BACKEND;
  process.env.NZBDAV_BACKEND = 'generic';
  nzbdav.reloadConfig();
  let nativeCalls = 0;
  try {
    const entries = await nzbdav.listWebdavDirectory('/content/test', {
      nativeLister: async () => { nativeCalls += 1; return []; },
      webdavLister: async () => [{ name: 'generic.mkv', isDirectory: false, size: 8 }],
    });
    assert.equal(nativeCalls, 0);
    assert.equal(entries[0].name, 'generic.mkv');
  } finally {
    if (oldBackend === undefined) delete process.env.NZBDAV_BACKEND;
    else process.env.NZBDAV_BACKEND = oldBackend;
    nzbdav.reloadConfig();
  }
});

test('InfiniDysk view target is encoded and signed without exposing the secret', () => {
  const previous = {
    backend: process.env.NZBDAV_BACKEND,
    url: process.env.NZBDAV_URL,
    webdavUrl: process.env.NZBDAV_WEBDAV_URL,
    key: process.env.INFINIDYSK_FRONTEND_API_KEY,
  };
  process.env.NZBDAV_BACKEND = 'auto';
  process.env.NZBDAV_URL = 'https://infini.test';
  process.env.NZBDAV_WEBDAV_URL = 'https://dav.test';
  process.env.INFINIDYSK_FRONTEND_API_KEY = 'frontend-secret';
  nzbdav.reloadConfig();
  try {
    const target = nzbdav.buildNzbdavUpstreamTarget('/content/TV/Show Name/Episode 01.mkv');
    const expected = crypto.createHmac('sha256', 'frontend-secret')
      .update('content/TV/Show Name/Episode 01.mkv').digest('hex');
    assert.equal(target.useInfiniView, true);
    assert.equal(target.targetUrl, `https://infini.test/view/content/TV/Show%20Name/Episode%2001.mkv?downloadKey=${expected}`);
    assert.equal(target.targetUrl.includes('frontend-secret'), false);
  } finally {
    restoreEnv('NZBDAV_BACKEND', previous.backend);
    restoreEnv('NZBDAV_URL', previous.url);
    restoreEnv('NZBDAV_WEBDAV_URL', previous.webdavUrl);
    restoreEnv('INFINIDYSK_FRONTEND_API_KEY', previous.key);
    nzbdav.reloadConfig();
  }
});

test('unsafe entry names are discarded while walking listings', async () => {
  const oldBackend = process.env.NZBDAV_BACKEND; const oldUrl = process.env.NZBDAV_URL; const oldPost = axios.post;
  process.env.NZBDAV_BACKEND = 'infinidysk'; process.env.NZBDAV_URL = 'http://infini.test';
  axios.post = async () => ({ status: 200, data: { items: [
    { name: '../escape.mkv', isDirectory: false, size: 999 },
    { name: 'Show.S01E02.mkv', isDirectory: false, size: 10 },
  ] } });
  try { nzbdav.reloadConfig(); const result = await nzbdav.findBestVideoFile({ category: 'TV', jobName: 'job', requestedEpisode: { season: 1, episode: 2 } }); assert.equal(result.name, 'Show.S01E02.mkv'); assert.ok(!result.absolutePath.includes('escape')); }
  finally { axios.post = oldPost; restoreEnv('NZBDAV_BACKEND', oldBackend); restoreEnv('NZBDAV_URL', oldUrl); nzbdav.reloadConfig(); }
});

test('episode selection prefers matching episode over larger non-match', async () => {
  const oldBackend = process.env.NZBDAV_BACKEND; const oldUrl = process.env.NZBDAV_URL; const oldPost = axios.post;
  process.env.NZBDAV_BACKEND = 'infinidysk'; process.env.NZBDAV_URL = 'http://infini.test';
  axios.post = async () => ({ status: 200, data: { items: [{ name: 'Show.S01E02.mkv', isDirectory: false, size: 10 }, { name: 'Show.S01E03.mkv', isDirectory: false, size: 100 }] } });
  try { nzbdav.reloadConfig(); const result = await nzbdav.findBestVideoFile({ category: 'TV', jobName: 'job', requestedEpisode: { season: 1, episode: 2 } }); assert.equal(result.name, 'Show.S01E02.mkv'); }
  finally { axios.post = oldPost; restoreEnv('NZBDAV_BACKEND', oldBackend); restoreEnv('NZBDAV_URL', oldUrl); nzbdav.reloadConfig(); }
});

// Keep this assertion close to the documentation: these are the currently
// exported operations that a future adapter-level test can exercise.
test('current nzbdav exports include directory walk and selection APIs', () => {
  assert.equal(typeof nzbdav.listWebdavDirectory, 'function');
  assert.equal(typeof nzbdav.findBestVideoFile, 'function');
});
