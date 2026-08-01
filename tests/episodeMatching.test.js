const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSeasonEpisodePairs,
  getEpisodeMatchState,
  getSeasonMatchState,
  titleContainsSeasonPack,
} = require('../src/utils/episodeMatching');
const { fileMatchesEpisode } = require('../src/utils/parsers');

const requested = { season: 2, episode: 5 };

test('extracts common episode forms and multi-episode chains', () => {
  assert.deepEqual(extractSeasonEpisodePairs('Show.S02E05E06.1080p'), [
    { season: 2, episode: 5 },
    { season: 2, episode: 6 },
  ]);
  assert.deepEqual(extractSeasonEpisodePairs('Show 2x05 WEB-DL'), [
    { season: 2, episode: 5 },
  ]);
});

test('rejects explicit wrong seasons and episodes', () => {
  assert.equal(getEpisodeMatchState('Mob.Psycho.100.S02E05.1080p', requested), 'exact');
  assert.equal(getEpisodeMatchState('Mob.Psycho.100.S01E05.1080p', requested), 'mismatch');
  assert.equal(getEpisodeMatchState('Mob.Psycho.100.S02E04.1080p', requested), 'mismatch');
  assert.equal(getEpisodeMatchState('Mob.Psycho.100.E05.1080p', requested), 'none');
  assert.equal(getSeasonMatchState('Mob.Psycho.100.S01.1080p', 2), 'mismatch');
  assert.equal(getSeasonMatchState('Mob.Psycho.100.S01-S03.1080p', 2), 'exact');
});

test('uses structured indexer metadata when the title is ambiguous', () => {
  assert.equal(getEpisodeMatchState('Mob Psycho 100 E05', requested, { season: 2, episode: 5 }), 'exact');
  assert.equal(getEpisodeMatchState('Mob Psycho 100 E05', requested, { season: 1, episode: 5 }), 'mismatch');
});

test('matches requested files inside season packs', () => {
  assert.equal(fileMatchesEpisode('Mob Psycho 100 - S02.E05.mkv', requested), true);
  assert.equal(fileMatchesEpisode('Mob.Psycho.100.S02E04E05.mkv', requested), true);
  assert.equal(fileMatchesEpisode('Mob.Psycho.100.S01E05.mkv', requested), false);
  assert.equal(fileMatchesEpisode('05.mkv', requested), false);
});

test('recognises requested season packs and rejects wrong-season packs', () => {
  assert.equal(titleContainsSeasonPack('Mob.Psycho.100.S02.1080p.BluRay', 2), true);
  assert.equal(titleContainsSeasonPack('Mob Psycho 100 Season 2 Complete', 2), true);
  assert.equal(titleContainsSeasonPack('Mob.Psycho.100.S01-S03.Complete', 2), true);
  assert.equal(titleContainsSeasonPack('Mob.Psycho.100.S01.Complete', 2), false);
  assert.equal(titleContainsSeasonPack('Mob.Psycho.100.S02E05.1080p', 2), false);
});
