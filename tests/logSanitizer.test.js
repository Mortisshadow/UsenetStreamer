const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSensitiveString, sanitizeLogValue } = require('../src/utils/logSanitizer');

test('redacts indexer secrets while preserving useful URL context', () => {
  const input = 'http://prowlarr:9696/1/download?apikey=secret&link=opaque&file=Show.S02E05';
  assert.equal(
    redactSensitiveString(input),
    'http://prowlarr:9696/1/download?apikey=[REDACTED]&link=[REDACTED]&file=Show.S02E05',
  );
  assert.equal(
    redactSensitiveString('&lt;link&gt;https://example.test/get?a=1&amp;apikey=secret&amp;link=opaque&lt;/link&gt;'),
    '&lt;link&gt;https://example.test/get?a=1&amp;apikey=[REDACTED]&amp;link=[REDACTED]&lt;/link&gt;',
  );
});

test('sanitizes nested log context without mutating non-secret fields', () => {
  const value = sanitizeLogValue({
    title: 'Show',
    apiKey: 'secret',
    nested: { url: 'https://user:pass@example.test/get?token=abc' },
  });
  assert.deepEqual(value, {
    title: 'Show',
    apiKey: '[REDACTED]',
    nested: { url: 'https://[REDACTED]@example.test/get?token=[REDACTED]' },
  });
});
