// Parses an imported sort/filter config JSON and extracts the slice that
// configures our sort/filter pipeline. Everything else (services, presets,
// proxy, formatter, catalogs) is ignored.
//
// Input: full config JSON string OR parsed object.
// Output: { sortCriteria, preferred, filters, expressions, warnings: [] }
//
// Failures: invalid JSON or non-object input → throws Error.
// Unrecognized but otherwise valid fields → warnings array.

// Sort keys we honor in our engine.
const APPLICABLE_SORT_KEYS = new Set([
  'size', 'age', 'resolution', 'quality',
  'encode', 'releaseGroup', 'visualTag', 'audioTag', 'audioChannel',
  'language', 'keyword',
  'rankScore',
  'streamExpressionMatched', 'streamExpressionScore',
]);

// Sort keys that exist in some upstream schemas but don't translate to a
// Usenet addon. We silently drop these from the imported sortCriteria and
// surface a warning so the user understands what happened. Our addon has its
// own internal logic for verified-stream prioritization (Smart Play) and
// doesn't need user-facing `cached`/`library` sort keys.
const IGNORED_SORT_KEYS = {
  cached: 'Imported "cached" sort key is dropped — our addon always surfaces verified streams first via its own logic.',
  library: 'Imported "library" sort key is dropped — not applicable to Usenet streams.',
  service: 'Imported "service" sort key is dropped — only one source (our addon).',
  seeders: 'Imported "seeders" sort key is dropped — not applicable to Usenet (no peer count).',
  private: 'Imported "private" sort key is dropped — torrent-only concept.',
  addon: 'Imported "addon" sort key is dropped — only one source (our addon).',
  subtitle: 'Imported "subtitle" sort key is dropped — subtitles aren\'t part of our stream metadata.',
  seadex: 'Imported "seadex" sort key is dropped — torrent/anime indexer concept.',
  streamType: 'Imported "streamType" sort key is dropped — all our streams are Usenet.',
  regexPatterns: 'Imported "regexPatterns" sort key is dropped — the user-facing preferred-regex sort tier was removed (excluded/required regex filters are still honored).',
  regexScore: 'Imported "regexScore" sort key is dropped — the user-facing preferred-regex sort tier was removed.',
  // bitrate is dropped as a SORT key only — the bitrate numeric *range* (Max
  // Bitrate filter) is still imported. For a single requested title all
  // candidates share one runtime, so bitrate sort is identical to size sort.
  bitrate: 'Imported "bitrate" sort key is dropped — it produces the same order as "size" here (all candidates share one runtime). The Max-Bitrate numeric limit is still imported.',
};

const SORT_LIST_KEYS = [
  'global', 'movies', 'series', 'anime',
  'cached', 'uncached',
  'cachedMovies', 'uncachedMovies',
  'cachedSeries', 'uncachedSeries',
  'cachedAnime', 'uncachedAnime',
];

function parseInput(input) {
  if (input === null || input === undefined) throw new Error('Empty config');
  if (typeof input === 'object') return input;
  if (typeof input === 'string') {
    let trimmed = input.trim();
    if (!trimmed) throw new Error('Empty config string');
    // Optional base64 wrapper (some exporters provide base64-encoded UserData)
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
        if (decoded.startsWith('{')) trimmed = decoded;
      } catch (_) {
        // fall through to JSON.parse below — will throw
      }
    }
    return JSON.parse(trimmed);
  }
  throw new Error('Unsupported input type for imported config');
}

function normalizeCriterion(entry, warnings, warnedKeys) {
  if (!entry || typeof entry !== 'object') return null;
  const key = entry.key;
  if (typeof key !== 'string' || !key) return null;
  if (Object.prototype.hasOwnProperty.call(IGNORED_SORT_KEYS, key)) {
    if (!warnedKeys.has(key)) {
      warnings.push(IGNORED_SORT_KEYS[key]);
      warnedKeys.add(key);
    }
    return null;
  }
  if (!APPLICABLE_SORT_KEYS.has(key)) {
    warnings.push(`Unknown sort key dropped: ${key}`);
    return null;
  }
  const direction = entry.direction === 'asc' ? 'asc' : 'desc';
  return { key, direction };
}

function pickSortCriteria(raw, warnings) {
  const result = {};
  if (!raw || typeof raw !== 'object') return result;
  // Track which ignored keys we've already warned about so the user sees
  // each reason only once, not once per sort list.
  const warnedKeys = new Set();
  for (const listName of SORT_LIST_KEYS) {
    const list = raw[listName];
    if (!Array.isArray(list)) continue;
    const normalized = list.map((e) => normalizeCriterion(e, warnings, warnedKeys)).filter(Boolean);
    if (normalized.length > 0) result[listName] = normalized;
  }
  return result;
}

function pickStringArray(raw, key) {
  const v = raw[key];
  if (!Array.isArray(v)) return [];
  return v.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function pickPatternArray(raw, key) {
  const v = raw[key];
  if (!Array.isArray(v)) return [];
  return v
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && typeof entry.pattern === 'string') {
        return {
          name: typeof entry.name === 'string' ? entry.name : undefined,
          pattern: entry.pattern,
          flags: typeof entry.flags === 'string' ? entry.flags : undefined,
          negate: Boolean(entry.negate),
          weight: Number.isFinite(entry.weight) ? entry.weight : 1,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function pickRange(raw, minKey, maxKey) {
  const min = Number(raw[minKey]);
  const max = Number(raw[maxKey]);
  const range = {};
  if (Number.isFinite(min)) range.min = min;
  if (Number.isFinite(max)) range.max = max;
  return Object.keys(range).length ? range : null;
}

// The import schema stores size/bitrate as
//   { global: { movies: [min,max], series: [min,max], anime: [...] }, resolution: {...} }
// We collapse to a single global range by taking the broadest movies/series
// tuple (so we don't accidentally over-filter for either content type).
function pickAioTupleRange(raw, fieldName) {
  const filter = raw[fieldName];
  if (!filter || typeof filter !== 'object') return null;
  const tuples = [filter.global?.movies, filter.global?.series, filter.global?.anime]
    .filter((t) => Array.isArray(t) && t.length === 2);
  if (tuples.length === 0) return null;
  // Use the most permissive bounds (smallest min, largest max) across types.
  let min = Infinity;
  let max = 0;
  for (const [a, b] of tuples) {
    if (Number.isFinite(a)) min = Math.min(min, a);
    if (Number.isFinite(b) && b > max) max = b;
  }
  const range = {};
  if (Number.isFinite(min) && min > 0 && min !== Infinity) range.min = min;
  if (max > 0) range.max = max;
  return Object.keys(range).length ? range : null;
}

/**
 * Import a sort/filter config export.
 * @param {string|object} input
 * @returns {{ sortCriteria, preferred, filters, expressions, warnings }}
 */
function importAioConfig(input) {
  const warnings = [];
  const raw = parseInput(input);
  if (!raw || typeof raw !== 'object') {
    throw new Error('Imported config must be a JSON object');
  }

  const sortCriteria = pickSortCriteria(raw.sortCriteria, warnings);

  const preferred = {
    resolutions: pickStringArray(raw, 'preferredResolutions'),
    qualities: pickStringArray(raw, 'preferredQualities'),
    encodes: pickStringArray(raw, 'preferredEncodes'),
    visualTags: pickStringArray(raw, 'preferredVisualTags'),
    audioTags: pickStringArray(raw, 'preferredAudioTags'),
    audioChannels: pickStringArray(raw, 'preferredAudioChannels'),
    languages: pickStringArray(raw, 'preferredLanguages'),
    releaseGroups: pickStringArray(raw, 'preferredReleaseGroups'),
  };

  const filters = {
    excluded: {
      // No excluded.resolutions — resolution restriction is the Allowed-
      // Resolutions grid (included.resolutions). An imported excludedResolutions
      // is warned-and-dropped below.
      qualities: pickStringArray(raw, 'excludedQualities'),
      encodes: pickStringArray(raw, 'excludedEncodes'),
      visualTags: pickStringArray(raw, 'excludedVisualTags'),
      audioTags: pickStringArray(raw, 'excludedAudioTags'),
      audioChannels: pickStringArray(raw, 'excludedAudioChannels'),
      languages: pickStringArray(raw, 'excludedLanguages'),
      releaseGroups: pickStringArray(raw, 'excludedReleaseGroups'),
    },
    // We only support a per-dimension EXCLUDED list plus an Allowed-Resolutions
    // whitelist (mapped to included.resolutions). The other "included"
    // dimensions have no UI, so importing them would create invisible filters
    // the user can't see or edit. We drop them here and warn (see below).
    included: {
      resolutions: pickStringArray(raw, 'includedResolutions'),
    },
    ranges: {
      size: pickAioTupleRange(raw, 'size'),
      bitrate: pickAioTupleRange(raw, 'bitrate'),
      ageHours: pickRange(raw, 'minAge', 'maxAge'),
    },
    excludedRegex: pickPatternArray(raw, 'excludedRegexPatterns'),
    requiredRegex: pickPatternArray(raw, 'requiredRegexPatterns'),
  };

  // Warn about any non-empty "included" dimensions we don't support. Only
  // includedResolutions maps to a real UI control (Allowed Resolutions); the
  // rest would be invisible filters, so they're dropped above.
  const UNSUPPORTED_INCLUDED = [
    ['includedQualities', 'qualities'],
    ['includedEncodes', 'encodes'],
    ['includedVisualTags', 'visual tags'],
    ['includedAudioTags', 'audio tags'],
    ['includedAudioChannels', 'audio channels'],
    ['includedLanguages', 'languages'],
    ['includedReleaseGroups', 'release groups'],
  ];
  for (const [rawKey, label] of UNSUPPORTED_INCLUDED) {
    if (pickStringArray(raw, rawKey).length > 0) {
      warnings.push(`Imported "${rawKey}" (${label}) is ignored — this addon supports an Excluded list plus an Allowed-Resolutions whitelist, not a per-dimension "included" filter. Use the Excluded list instead.`);
    }
  }
  // excludedResolutions has no dedicated UI; resolution restriction is the
  // Allowed-Resolutions grid. Warn so the user re-applies it there.
  if (pickStringArray(raw, 'excludedResolutions').length > 0) {
    warnings.push('Imported "excludedResolutions" is ignored — restrict resolutions via the Allowed Resolutions grid instead (uncheck the resolutions you do not want).');
  }

  const expressions = {
    keywords: pickPatternArray(raw, 'preferredKeywordsPatterns'),
  };

  // Ultimate-compatible ranked rules can live at the top level or below a
  // filter/rules wrapper depending on which exporter produced the backup.
  const { parseRulesConfig } = require('../rules/rankEngine');
  const rules = parseRulesConfig(raw);

  return { sortCriteria, preferred, filters, expressions, rules, warnings };
}

module.exports = {
  importAioConfig,
};
