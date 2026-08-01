// Sort engine.
//
// The user config has up to 12 sort lists:
//   global, movies, series, anime,
//   cached, uncached, cachedMovies, uncachedMovies,
//   cachedSeries, uncachedSeries, cachedAnime, uncachedAnime
// Each list is an ordered array of { key, direction: 'asc'|'desc' }.
// Per-type lists fall back to `global` when empty. The cached/uncached
// variants are only used when `global[0].key === 'cached'` (the split-mode
// trigger).
//
// For each stream, we build an array of comparable values via valueForCriterion
// and lexicographically compare.

const { valueForCriterion } = require('./sortKeys');

const DEFAULT_SORT_DIRECTION = 'desc';
const ASC_KEYS_BY_DEFAULT = new Set(['files', 'size_asc']); // placeholder, currently unused but documents intent

// When a config resolves to NO sort criteria (e.g. an imported config with an
// empty sortCriteria.global, or a per-type list with no global fallback), we
// still sort by resolution then size rather than returning raw indexer order.
// This matches the legacy engine's quality-then-size default and prevents a
// silently-unsorted result list.
const DEFAULT_SORT_CRITERIA = [
  { key: 'resolution', direction: 'desc' },
  { key: 'size', direction: 'desc' },
];

function isStreamCached(stream) {
  // Our addon's NZB streams are inherently uncached. We let imported configs
  // signal "cached" via behaviorHints.cached for parity with the import schema.
  if (stream && stream.behaviorHints && stream.behaviorHints.cached === true) return true;
  if (stream && stream.service && stream.service.cached === true) return true;
  if (stream && stream._cached === true) return true;
  return false;
}

// By convention: direction multiplier of +1 (asc) or -1 (desc) is applied to
// the raw key value. The compare is then ascending on the multiplied values,
// which gives:
//   desc: higher raw value sorts first
//   asc:  lower raw value sorts first
function applyDirection(value, direction) {
  const multiplier = direction === 'asc' ? 1 : -1;
  return multiplier * value;
}

function dynamicSortKey(stream, criteria, context) {
  if (!Array.isArray(criteria)) return [];
  const out = new Array(criteria.length);
  for (let i = 0; i < criteria.length; i += 1) {
    const criterion = criteria[i] || {};
    const raw = valueForCriterion(criterion, stream, context);
    out[i] = applyDirection(raw, criterion.direction || DEFAULT_SORT_DIRECTION);
  }
  return out;
}

// Ascending lexicographic compare. The direction multiplier in applyDirection
// has already mapped "preferred" to a lower numeric value, so plain ascending
// gives the right order. NaN sorts last (treat as worse than anything).
function compareKeys(aKey, bKey) {
  const len = Math.max(aKey.length, bKey.length);
  for (let i = 0; i < len; i += 1) {
    const a = aKey[i];
    const b = bKey[i];
    if (a === b) continue;
    // Both NaN → treat as a tie at this position and advance to the next key
    // (NaN === NaN is false, so this must be checked explicitly).
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    if (Number.isNaN(a)) return 1;
    if (Number.isNaN(b)) return -1;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function pickCriteria(sortCriteria, type, splitState) {
  // splitState: 'cached' | 'uncached' | null (no split)
  if (!sortCriteria) return [];

  const typeKey = type === 'series' ? 'series' : type === 'anime' ? 'anime' : 'movies';
  const splitPrefix = splitState === 'cached' ? 'cached' : splitState === 'uncached' ? 'uncached' : null;

  if (splitPrefix) {
    const typeSpecific = sortCriteria[`${splitPrefix}${typeKey.charAt(0).toUpperCase()}${typeKey.slice(1)}`];
    if (Array.isArray(typeSpecific) && typeSpecific.length > 0) return typeSpecific;
    const split = sortCriteria[splitPrefix];
    if (Array.isArray(split) && split.length > 0) return split;
  }

  const typeArr = sortCriteria[typeKey];
  if (Array.isArray(typeArr) && typeArr.length > 0) return typeArr;

  const global = sortCriteria.global;
  return Array.isArray(global) ? global : [];
}

function shouldSplitOnCached(sortCriteria) {
  const g = sortCriteria?.global;
  if (!Array.isArray(g) || g.length === 0) return false;
  if (g[0]?.key !== 'cached') return false;
  return Boolean(
    (Array.isArray(sortCriteria.cached) && sortCriteria.cached.length)
    || (Array.isArray(sortCriteria.uncached) && sortCriteria.uncached.length)
  );
}

/**
 * Sort an array of stream/result objects using the engine's config shape.
 * Mutates and returns the input array.
 *
 * @param {Array<object>} streams
 * @param {object} userConfig - { sortCriteria, preferred }
 *   sortCriteria: { global, movies, series, anime, cached, uncached, ... }
 *   preferred: { resolutions, qualities, encodes, releaseGroups, visualTags, audioTags, audioChannels, languages }
 * @param {object} context - { type: 'movie'|'series'|'anime' }
 * @returns {Array<object>} sorted in place
 */
function sortStreams(streams, userConfig = {}, context = {}) {
  if (!Array.isArray(streams) || streams.length <= 1) return streams || [];

  const sortCriteria = userConfig.sortCriteria || {};
  const preferred = userConfig.preferred || {};
  const type = context.type || 'movie';

  const split = shouldSplitOnCached(sortCriteria);

  if (!split) {
    let criteria = pickCriteria(sortCriteria, type, null);
    // No configured criteria (e.g. imported config with empty sortCriteria) →
    // fall back to the default resolution→size sort instead of leaving the
    // list in raw indexer order.
    if (criteria.length === 0) criteria = DEFAULT_SORT_CRITERIA;
    if (context.rankScoreFirst && !criteria.some((criterion) => criterion.key === 'rankScore' || criterion.key === 'streamExpressionScore')) {
      criteria = [{ key: 'rankScore', direction: 'desc' }, ...criteria];
    }
    const keyContext = { preferred };
    const keyed = streams.map((stream) => ({ stream, key: dynamicSortKey(stream, criteria, keyContext) }));
    keyed.sort((a, b) => compareKeys(a.key, b.key));
    return keyed.map((entry) => entry.stream);
  }

  // Split mode: cached on top (or bottom, depending on direction), each
  // group sorted by its own criteria list.
  const cachedDirection = sortCriteria.global[0].direction === 'asc' ? 'asc' : 'desc';
  const cachedGroup = [];
  const uncachedGroup = [];
  for (const stream of streams) {
    (isStreamCached(stream) ? cachedGroup : uncachedGroup).push(stream);
  }
  const keyContext = { preferred };
  const sortBy = (group, state) => {
    let crit = pickCriteria(sortCriteria, type, state);
    if (crit.length === 0 && context.rankScoreFirst) crit = DEFAULT_SORT_CRITERIA;
    if (crit.length === 0) return group;
    if (context.rankScoreFirst && !crit.some((criterion) => criterion.key === 'rankScore' || criterion.key === 'streamExpressionScore')) {
      crit = [{ key: 'rankScore', direction: 'desc' }, ...crit];
    }
    const keyed = group.map((stream) => ({ stream, key: dynamicSortKey(stream, crit, keyContext) }));
    keyed.sort((a, b) => compareKeys(a.key, b.key));
    return keyed.map((entry) => entry.stream);
  };
  const sortedCached = sortBy(cachedGroup, 'cached');
  const sortedUncached = sortBy(uncachedGroup, 'uncached');
  return cachedDirection === 'desc'
    ? [...sortedCached, ...sortedUncached]
    : [...sortedUncached, ...sortedCached];
}

module.exports = {
  sortStreams,
  // Internal exports for tests
  dynamicSortKey,
  compareKeys,
  pickCriteria,
  shouldSplitOnCached,
};
