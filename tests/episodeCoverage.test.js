const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeManifestEpisodeCoverage } = require('../src/services/triage/episodeCoverage');

const options = { isSeasonPack: true, requestedEpisode: { season: 2, episode: 7 } };
const files = (...names) => names.map((filename) => ({ filename, subject: filename, segments: [] }));

test('confirms the requested direct video in a pack manifest', () => {
  const coverage = analyzeManifestEpisodeCoverage(files(
    'Show.S02E06.mkv',
    'Show.S02E07.mkv',
    'Show.S02E08.mkv',
  ), options);
  assert.equal(coverage.status, 'confirmed');
  assert.equal(coverage.source, 'video-subject');
  assert.deepEqual(coverage.targetFiles.map((file) => file.filename), ['Show.S02E07.mkv']);
});

test('confirms an episode-specific archive and leaves generic archives unknown', () => {
  assert.equal(analyzeManifestEpisodeCoverage(files('Show.S02E07.part01.rar'), options).status, 'confirmed');
  assert.equal(analyzeManifestEpisodeCoverage(files('abc.part01.rar', 'abc.part02.rar'), options).status, 'unknown');
});

test('marks a visible direct-video inventory without the requested episode missing', () => {
  const coverage = analyzeManifestEpisodeCoverage(files('Show.S02E05.mkv', 'Show.S02E06.mkv'), options);
  assert.equal(coverage.status, 'missing');
});

test('does not treat a single episode-range video as confirmed coverage', () => {
  const coverage = analyzeManifestEpisodeCoverage(files('Show.S02E01-E25.mkv'), options);
  assert.equal(coverage.status, 'unknown');
});

test('does not analyze normal single-episode results as packs', () => {
  assert.equal(analyzeManifestEpisodeCoverage(files('Show.S02E07.mkv'), { ...options, isSeasonPack: false }), null);
});
