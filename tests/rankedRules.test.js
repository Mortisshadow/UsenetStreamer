'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, evaluate } = require('../src/services/rules/sel');
const { BUILTIN_FUNCTIONS } = require('../src/services/rules/selFunctions');
const { applyRankedRules, parseRulesConfig } = require('../src/services/rules/rankEngine');
const { sortStreams } = require('../src/services/sort/sortEngine');
const { importAioConfig } = require('../src/services/sort/aioImporter');

function result(title, overrides = {}) {
  return {
    title,
    resolution: '1080p',
    encode: 'AVC',
    languages: [],
    size: 4 * 1024 ** 3,
    publishDateMs: Date.now() - 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

test('SEL evaluates safe set functions, arithmetic and query constants', () => {
  const streams = [
    { ref: 1, attrs: { resolution: '4k' }, tags: [], rseTags: [] },
    { ref: 2, attrs: { resolution: '1080p' }, tags: [], rseTags: [] },
  ];
  const compiled = compile("queryType == 'anime' && count(resolution(streams, '2160p')) + 1 == 2 ? resolution(streams, '4k') : []");
  const matched = evaluate(compiled, { streams, constants: { queryType: 'anime' }, functions: BUILTIN_FUNCTIONS });
  assert.deepEqual(matched.map((entry) => entry.ref), [1]);
  assert.throws(() => compile("stream.constructor == 'x'"), /Unknown stream attribute/);
});

test('German language and quality points add up and sort before normal criteria', () => {
  const german1080 = result('Show German 1080p', { languages: ['de'] });
  const english4k = result('Show English 2160p', { resolution: '4k', languages: ['English'], size: 20 * 1024 ** 3 });
  const rules = {
    rankedStreamExpressions: [
      { name: 'German', expression: "language(streams, 'German')", score: 300 },
      { name: '4K', expression: "resolution(streams, '2160p')", score: 80 },
      { name: '1080p', expression: "resolution(streams, '1080p')", score: 50 },
    ],
  };
  const ranked = applyRankedRules([english4k, german1080], rules, { queryType: 'series' });
  assert.equal(german1080._rankTotalScore, 350);
  assert.equal(english4k._rankTotalScore, 80);
  const sorted = sortStreams(ranked.results, { sortCriteria: {}, preferred: {} }, { type: 'series', rankScoreFirst: true });
  assert.equal(sorted[0], german1080);
});

test('SEL can score all packs or only a specific pack type', () => {
  const season = result('Show Season 2', { isSeasonPack: true, packType: 'season' });
  const batch = result('Show Episodes 1-5', { isSeasonPack: true, packType: 'episode-range' });
  const single = result('Show S02E05');
  const rules = {
    rankedStreamExpressions: [
      { name: 'Any pack', expression: 'seasonPack(streams)', score: 10 },
      { name: 'Full season', expression: "packType(streams, 'season')", score: 40 },
    ],
  };
  applyRankedRules([season, batch, single], rules);
  assert.equal(season._rankTotalScore, 50);
  assert.equal(batch._rankTotalScore, 10);
  assert.equal(single._rankTotalScore, 0);
});

test('regex tags feed SEL scoring and keep/drop modes filter the pool', () => {
  const goodGerman = result('Movie.GERMAN.1080p');
  const blockedGerman = result('Movie.GERMAN.CAM');
  const english = result('Movie.ENGLISH.1080p');
  const rules = {
    rankedRegexPatterns: [
      { name: 'German Marker', pattern: 'GERMAN', score: 10, mode: 'keep' },
      { name: 'Bad Source', pattern: 'CAM', mode: 'drop' },
    ],
    rankedStreamExpressions: [
      { name: 'Tagged German', expression: "regexMatched(streams, 'German Marker')", score: 200 },
    ],
  };
  const ranked = applyRankedRules([goodGerman, blockedGerman, english], rules);
  assert.deepEqual(ranked.results, [goodGerman]);
  assert.equal(goodGerman._rankTotalScore, 200);
  assert.equal(blockedGerman._rankExcludedBy, 'Bad Source');
  assert.equal(english._rankExcludedBy, '(no keep match)');
});

test('Ultimate-shaped imports preserve ranked rules and clamp scores', () => {
  const imported = importAioConfig({
    config: {
      rankedRegexPatterns: [{ name: 'German marker', pattern: '/GERMAN/i', score: 25 }],
      rankedStreamExpressions: [{ name: 'German', expression: "language(streams, 'de')", score: 999999 }],
    },
  });
  assert.equal(imported.rules.rankedStreamExpressions[0].score, 10000);
  assert.equal(imported.rules.rankedRegexPatterns[0].pattern, 'GERMAN');
  assert.equal(imported.rules.rankedRegexPatterns[0].flags, 'i');
  const parsed = parseRulesConfig(JSON.stringify(imported.rules));
  assert.equal(parsed.rankedStreamExpressions[0].name, 'German');
});
