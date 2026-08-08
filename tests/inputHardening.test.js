'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSafeRegex } = require('../src/utils/safeRegex');
const { isPrivateAddress, parseHttpUrl, validateOutboundUrl, validateRedirect, createPinnedLookup } = require('../src/utils/safeUrl');
const { normalizeNzbdavPath, sanitizeNzbdavPathSegment, joinNzbdavPath } = require('../src/utils/parsers');
const { withoutSensitiveHeaders } = require('../src/utils/safeDownload');
const { compileRules } = require('../src/services/rules/rankEngine');
const { normalizePatternEntry } = require('../src/services/sort/precompute');

test('safe regex validation rejects common catastrophic backtracking shapes', () => {
  assert.equal(validateSafeRegex('(?:GERMAN|DEUTSCH)', 'i'), null);
  assert.equal(validateSafeRegex('(a+)+$', 'i')?.kind, 'nested-quantifier');
  assert.equal(validateSafeRegex('(a|aa)+$', 'i')?.kind, 'ambiguous-alternation');
  assert.equal(validateSafeRegex('(S\\d{1,2})?', 'i'), null);
  assert.equal(validateSafeRegex('ok', 'ii')?.kind, 'flags');
});

test('rank engine reports unsafe administrator regex without compiling it', () => {
  const compiled = compileRules({ rankedRegexPatterns: [{ id: 'bad', pattern: '(a+)+$', enabled: true }] });
  assert.equal(compiled.regex[0].compiled, undefined);
  assert.match(compiled.errors[0].message, /nested repetition/i);
});

test('filter-side administrator regex uses the same safety policy', () => {
  assert.equal(normalizePatternEntry('(a+)+$'), null);
  assert.ok(normalizePatternEntry('(?:GERMAN|DEUTSCH)'));
  assert.equal(normalizePatternEntry('/german/g').pattern.flags.includes('g'), false);
});

test('outbound URL validation blocks unsafe schemes, credentials, and private DNS answers', async () => {
  assert.throws(() => parseHttpUrl('file:///etc/passwd'), /HTTP/);
  assert.throws(() => parseHttpUrl('https://user:pass@example.com/file.nzb'), /Credentials/);
  await assert.rejects(
    validateOutboundUrl('https://indexer.example/file.nzb', {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    /private, loopback, or link-local/,
  );
  const validated = await validateOutboundUrl('https://indexer.example/file.nzb', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  });
  assert.equal(validated.addresses[0].address, '8.8.8.8');
});

test('private address classifier covers IPv4, IPv6, mapped, and carrier-grade ranges', () => {
  for (const address of ['10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '192.168.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('validated addresses can be pinned to prevent a second DNS lookup', async () => {
  const lookup = createPinnedLookup({ addresses: [{ address: '8.8.8.8', family: 4 }] });
  await new Promise((resolve, reject) => lookup('changed.example', {}, (error, address, family) => {
    if (error) return reject(error);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
    resolve();
  }));
});

test('redirect policy blocks transport downgrade and marks cross-origin credentials for stripping', async () => {
  await assert.rejects(
    validateRedirect('https://indexer.example/a', 'http://indexer.example/b', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    }),
    /HTTPS to HTTP/,
  );
  const redirected = await validateRedirect('https://indexer.example/a', 'https://cdn.example/b', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  });
  assert.equal(redirected.sameOrigin, false);
  assert.equal(redirected.stripSensitiveHeaders, true);
});

test('cross-origin redirect header filtering is case-insensitive', () => {
  const filtered = withoutSensitiveHeaders({
    Authorization: 'Bearer secret',
    Cookie: 'session=secret',
    'X-Api-Key': 'secret',
    Accept: 'application/x-nzb',
  });
  assert.deepEqual(filtered, { Accept: 'application/x-nzb' });
});

test('WebDAV path helpers remove traversal and reject injected dynamic segments', () => {
  assert.throws(() => normalizeNzbdavPath('/content/tv/../../secret'), /traversal/);
  assert.equal(normalizeNzbdavPath('content\\tv\\show'), '/content/tv/show');
  assert.throws(() => sanitizeNzbdavPathSegment('../secret'), /separator/);
  assert.throws(() => sanitizeNzbdavPathSegment('..'), /relative/);
  assert.equal(joinNzbdavPath('content', 'tv', 'A Show [2025]'), '/content/tv/A Show [2025]');
});
