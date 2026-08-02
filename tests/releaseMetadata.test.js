const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReleaseMetadata } = require('../src/services/metadata/releaseParser');

test('does not treat subtitle-only multi markers as multi audio', () => {
  const metadata = parseReleaseMetadata(
    '[ToonsHub] JUJUTSU KAISEN - S02E01 (Japanese 2160p x264 AAC) [Multi-Subs]',
  );

  assert.equal(metadata.inferredLanguages.includes('Multi'), false);
});

test('keeps explicit multi-audio markers even when multi-subs are also present', () => {
  const metadata = parseReleaseMetadata(
    '[Group] Show S02E01 [1080p] [Multi-Audio] [Multi-Subs]',
  );

  assert.equal(metadata.inferredLanguages.includes('Multi'), true);
});

test('does not infer audio shape from languages attached to multi-subs', () => {
  const metadata = parseReleaseMetadata(
    '[Group] Show S02E01 [Japanese English German Subs] [Multi-Subs]',
  );

  assert.equal(metadata.inferredLanguages.includes('Multi'), false);
  assert.equal(metadata.inferredLanguages.includes('Dual Audio'), false);
});
