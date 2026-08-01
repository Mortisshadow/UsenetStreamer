const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePackCoreTitle, matchesStrictPackTitle } = require('../src/utils/stringUtils');

test('normalizes release groups and season sequel markers for pack matching', () => {
  assert.equal(normalizePackCoreTitle('[Breeze] Mob Psycho 100 Season 2 [1080p]', 2), 'mob psycho 100');
  assert.equal(normalizePackCoreTitle('Mob.Psycho.100.II.S02.2019.COMPLETE.German', 2), 'mob psycho 100');
  assert.equal(normalizePackCoreTitle('Mob.Psycho.100.S02E05.1080p', 2), 'mob psycho 100');
  assert.equal(normalizePackCoreTitle('Mob Psycho 100 2x05 1080p', 2), 'mob psycho 100');
  assert.equal(
    normalizePackCoreTitle('Mob Psycho 100 2016 S02E05 1080p', 2, { stripReleaseYear: true }),
    'mob psycho 100',
  );
});

test('accepts authoritative aliases but rejects spin-off title additions', () => {
  const allowed = ['My Hero Academia', 'Boku no Hero Academia'];
  assert.equal(matchesStrictPackTitle('[RH] Boku no Hero Academia S2 + Special [1080p]', allowed, 2), true);
  assert.equal(matchesStrictPackTitle('[PK] Boku no Hero Academia Season 2 My Hero Academia S2', allowed, 2), true);
  assert.equal(matchesStrictPackTitle('Vigilante - Boku no Hero Academia Illegals S2 - 07', allowed, 2), false);
  assert.equal(matchesStrictPackTitle('Doctor Who S02E05', ['Doctor Who (2005)'], 2), false);
  assert.equal(matchesStrictPackTitle('Doctor Who 2005 S02E05', ['Doctor Who (2005)'], 2), true);
});
