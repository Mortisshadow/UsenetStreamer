const test = require('node:test');
const assert = require('node:assert/strict');
const { annotateNzbResult } = require('../src/utils/helpers');

test('estimates episode-range pack size from the covered episode count', () => {
  const result = annotateNzbResult({
    title: 'Show S02E01-E05',
    size: 5_000,
    isSeasonPack: true,
    packType: 'episode-range',
    packStartEpisode: 1,
    packEndEpisode: 5,
  }, 0, { episodesInSeason: 25 });
  assert.equal(result.estimatedEpisodeSize, 1_000);
});

test('estimates multi-season pack size from TMDb season episode counts', () => {
  const result = annotateNzbResult({
    title: 'Show S01-S02 Complete',
    size: 50_000,
    isSeasonPack: true,
    packType: 'multi-season',
    packStartSeason: 1,
    packEndSeason: 2,
  }, 0, {
    episodesInSeason: 25,
    seasonEpisodeCounts: { 0: 2, 1: 25, 2: 25 },
  });
  assert.equal(result.estimatedEpisodeSize, 1_000);
});
