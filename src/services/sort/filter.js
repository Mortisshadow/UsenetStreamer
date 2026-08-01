// Stream filtering for the sort pipeline.
//
// Each dimension supports an `excluded` list (drop if matches) and an
// optional `included` list (drop if NOT in list, when list is non-empty).
// We omit the three-tier required/included/excluded model from the upstream
// schema — for our user base, excluded + preferred (sort-only) covers 95% of
// real configs.
//
// Numeric ranges (size, bitrate, age) accept { min, max } where either bound
// is optional. min in bytes/bps/hours, max likewise.
//
// Regex patterns: array of strings (or { pattern, flags, negate }). When a
// pattern matches the stream's title/group/indexer, the stream is dropped
// (or kept, if negate=true).

const { normalizePatternList } = require('./precompute');
const {
  getStreamResolution,
  getStreamQuality,
  getStreamEncode,
  getStreamReleaseGroup,
  getStreamVisualTags,
  getStreamAudioTags,
  getStreamAudioChannels,
  getStreamLanguages,
  getStreamBitrate,
  getStreamSize,
  getStreamAgeMs,
  AUDIO_CHANNEL_SYNONYMS,
  AUDIO_SYNONYMS,
  ENCODE_SYNONYMS,
  QUALITY_SYNONYMS,
  RESOLUTION_SYNONYMS,
  LANGUAGE_SYNONYMS,
} = require('./sortKeys');

// Canonicalize a token through a synonym map (lowercased). When the map
// doesn't know the token, fall back to the lowered raw form. Filtering MUST
// canonicalize both the configured list and the stream value through the same
// map so that aliases match (e.g. exclude "4k" drops a "2160p" stream, exclude
// "english" drops "en", exclude "ddp" drops "dd+"). The sort engine already
// does this; the filter must match it.
function canonicalize(value, synonyms) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  return (synonyms && synonyms[s]) || s;
}

function scalarInSetWithSynonyms(value, set, synonyms) {
  if (!set) return false;
  const canon = canonicalize(value, synonyms);
  if (!canon) return false;
  return set.has(canon);
}

function lowerSetWithSynonyms(list, synonyms) {
  if (!Array.isArray(list)) return null;
  const out = new Set();
  for (const v of list) {
    const canon = canonicalize(v, synonyms);
    if (canon) out.add(canon);
  }
  return out.size ? out : null;
}

function listHasOverlapWithSynonyms(values, set, synonyms) {
  if (!set) return false;
  for (const v of values) {
    const canon = canonicalize(v, synonyms);
    if (canon && set.has(canon)) return true;
  }
  return false;
}

function lowerSet(list) {
  if (!Array.isArray(list)) return null;
  const out = new Set();
  for (const v of list) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim().toLowerCase();
    if (s) out.add(s);
  }
  return out.size ? out : null;
}

function listHasOverlap(values, set) {
  if (!set) return false;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (set.has(String(v).trim().toLowerCase())) return true;
  }
  return false;
}

function scalarInSet(value, set) {
  if (!set) return false;
  if (value === null || value === undefined) return false;
  return set.has(String(value).trim().toLowerCase());
}

function inRange(value, range) {
  if (!range || typeof range !== 'object') return true;
  // Missing/unknown value: pass through. Filtering on data we don't have
  // would silently drop most streams (e.g. bitrate is rarely in NZB titles,
  // so a max-bitrate filter would nuke 95% of results). User intent for a
  // range filter is "don't show me streams outside this range" — not "don't
  // show me streams I can't measure".
  if (!Number.isFinite(value)) return true;
  if (Number.isFinite(range.min) && value < range.min) return false;
  if (Number.isFinite(range.max) && value > range.max) return false;
  return true;
}

function matchesAnyPattern(targets, patterns) {
  for (const entry of patterns) {
    let matched = false;
    for (const target of targets) {
      if (entry.pattern.test(target)) { matched = true; break; }
    }
    if (entry.negate ? !matched : matched) return true;
  }
  return false;
}

function getTargetStrings(stream) {
  const out = [];
  for (const field of ['title', 'normalizedTitle', 'group', 'releaseGroup', 'indexer']) {
    const v = stream && stream[field];
    if (typeof v === 'string' && v) out.push(v);
  }
  return out;
}

/**
 * Filter a list of streams using the engine's filter config.
 * @param {Array<object>} streams
 * @param {object} filters - { excluded:{resolutions, qualities, ...}, included:{...}, ranges:{size,bitrate,ageHours}, excludedRegex, requiredRegex }
 * @param {object} [opts] - { dropLog } — if dropLog is an array, each removed
 *   stream is pushed as { title, reason } so callers can explain a "0 results"
 *   outcome (which filter dropped everything).
 * @returns {Array<object>} new array
 */
function filterStreams(streams, filters = {}, opts = {}) {
  if (!Array.isArray(streams) || streams.length === 0) return streams || [];
  if (!filters || typeof filters !== 'object') return streams;

  const dropLog = Array.isArray(opts.dropLog) ? opts.dropLog : null;
  const drop = (stream, reason) => {
    if (dropLog) dropLog.push({
      title: stream && (stream.title || stream.Title) || null,
      reason,
      seasonPack: stream?.isSeasonPack === true,
    });
    return false;
  };

  const excluded = filters.excluded || {};
  const included = filters.included || {};
  const ranges = filters.ranges || {};

  // Prebuild sets for cheap lookups. Dimensions with a synonym map use the
  // synonym-aware builder so aliases match (matching the sort engine). Quality
  // canonicalizes legacy aliases (e.g. bare "remux" → "bluray remux"). Release
  // groups and visual tags have no synonym map → plain lowerSet.
  const excludedSets = {
    resolutions: lowerSetWithSynonyms(excluded.resolutions, RESOLUTION_SYNONYMS),
    qualities: lowerSetWithSynonyms(excluded.qualities, QUALITY_SYNONYMS),
    encodes: lowerSetWithSynonyms(excluded.encodes, ENCODE_SYNONYMS),
    releaseGroups: lowerSet(excluded.releaseGroups),
    visualTags: lowerSet(excluded.visualTags),
    audioTags: lowerSetWithSynonyms(excluded.audioTags, AUDIO_SYNONYMS),
    audioChannels: lowerSetWithSynonyms(excluded.audioChannels, AUDIO_CHANNEL_SYNONYMS),
    languages: lowerSetWithSynonyms(excluded.languages, LANGUAGE_SYNONYMS),
  };
  // We only support ONE whitelist: Allowed Resolutions (included.resolutions).
  // There is no per-dimension "included" UI, so the other included.* fields are
  // never populated (the importer drops them with a warning). Keeping only
  // resolutions here matches the supported feature set. Synonym-aware so the
  // grid's "4k" matches a "2160p" stream.
  const includedSets = {
    resolutions: lowerSetWithSynonyms(included.resolutions, RESOLUTION_SYNONYMS),
  };

  const excludedRegex = normalizePatternList(filters.excludedRegex);
  const requiredRegex = normalizePatternList(filters.requiredRegex);

  return streams.filter((stream) => {
    if (!stream || typeof stream !== 'object') return false;

    // Scalar excludes (resolution + encode + quality are synonym-aware:
    // '4k'≡'2160p', 'x264'≡'h.264'≡'avc', 'remux'≡'bluray remux'). Release
    // groups have no synonym map.
    if (scalarInSetWithSynonyms(getStreamResolution(stream), excludedSets.resolutions, RESOLUTION_SYNONYMS)) return drop(stream, `excluded:resolution=${getStreamResolution(stream)}`);
    if (scalarInSetWithSynonyms(getStreamQuality(stream), excludedSets.qualities, QUALITY_SYNONYMS)) return drop(stream, `excluded:quality=${getStreamQuality(stream)}`);
    if (scalarInSetWithSynonyms(getStreamEncode(stream), excludedSets.encodes, ENCODE_SYNONYMS)) return drop(stream, `excluded:encode=${getStreamEncode(stream)}`);
    if (scalarInSet(getStreamReleaseGroup(stream), excludedSets.releaseGroups)) return drop(stream, `excluded:releaseGroup=${getStreamReleaseGroup(stream)}`);

    // Allowed-Resolutions whitelist (the only "included" filter we support).
    // getStreamResolution returns 'unknown' for missing, so an "unknown" entry
    // in the allowed list keeps undetectable-resolution streams; omitting it
    // drops them — user-controlled via the grid's "unknown" checkbox.
    if (includedSets.resolutions && !scalarInSetWithSynonyms(getStreamResolution(stream), includedSets.resolutions, RESOLUTION_SYNONYMS)) return drop(stream, `notAllowed:resolution=${getStreamResolution(stream)}`);

    // List excludes (audioTags, audioChannels, languages are synonym-aware).
    if (listHasOverlap(getStreamVisualTags(stream), excludedSets.visualTags)) return drop(stream, 'excluded:visualTag');
    if (listHasOverlapWithSynonyms(getStreamAudioTags(stream), excludedSets.audioTags, AUDIO_SYNONYMS)) return drop(stream, 'excluded:audioTag');
    if (listHasOverlapWithSynonyms(getStreamAudioChannels(stream), excludedSets.audioChannels, AUDIO_CHANNEL_SYNONYMS)) return drop(stream, 'excluded:audioChannel');
    if (listHasOverlapWithSynonyms(getStreamLanguages(stream), excludedSets.languages, LANGUAGE_SYNONYMS)) return drop(stream, `excluded:language=${(getStreamLanguages(stream) || []).join('|')}`);

    // Numeric ranges
    if (!inRange(getStreamSize(stream), ranges.size)) return drop(stream, `range:size=${getStreamSize(stream)}`);
    if (!inRange(getStreamBitrate(stream), ranges.bitrate)) return drop(stream, `range:bitrate=${getStreamBitrate(stream)}`);
    const ageMs = getStreamAgeMs(stream);
    const ageHours = Number.isFinite(ageMs) ? ageMs / 3_600_000 : null;
    if (!inRange(ageHours, ranges.ageHours)) return drop(stream, `range:age=${ageHours}`);

    // Regex patterns
    if (excludedRegex.length > 0 && matchesAnyPattern(getTargetStrings(stream), excludedRegex)) return drop(stream, 'excludedRegex');
    if (requiredRegex.length > 0 && !matchesAnyPattern(getTargetStrings(stream), requiredRegex)) return drop(stream, 'requiredRegex');

    return true;
  });
}

module.exports = {
  filterStreams,
};
