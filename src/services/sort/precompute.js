// Precomputes keyword match state on each stream so the sort key extractor
// can read it cheaply. (Trimmed-down precomputer: we no longer have a
// user-facing preferred-regex sort tier — only filter-side excluded/required
// regex remains, handled by filter.js via the normalizePatternEntry /
// normalizePatternList primitives below.)
//
// Stream fields written (all underscored to keep them out of the wire format):
//   _keywordMatched: boolean

const DEFAULT_MATCH_FIELDS = ['title', 'normalizedTitle', 'group', 'releaseGroup', 'indexer'];
const { validateSafeRegex } = require('../../utils/safeRegex');

function getMatchableStrings(stream, extraFields = []) {
  const out = [];
  const fields = DEFAULT_MATCH_FIELDS.concat(extraFields);
  for (const field of fields) {
    const v = stream && stream[field];
    if (v && typeof v === 'string') out.push(v);
  }
  return out;
}

function safeRegex(pattern, flags) {
  try {
    const statelessFlags = String(flags || '').replace(/[gy]/gi, '');
    if (validateSafeRegex(pattern, statelessFlags)) return null;
    return new RegExp(pattern, statelessFlags);
  } catch (_) {
    return null;
  }
}

// Accept JS regex literal syntax `/pattern/flags` in addition to plain
// pattern strings. Community regex packs (e.g. Vidhin's Releases-Regex)
// store patterns as full literals, and without this our parser would treat
// the surrounding slashes as part of the regex and never match anything.
function parseRegexLiteralForm(value) {
  if (typeof value !== 'string') return { source: '', flags: '' };
  const trimmed = value.trim();
  const m = trimmed.match(/^\/((?:\\.|[^\\\/])*)\/([gimsuy]*)$/);
  if (m) return { source: m[1], flags: m[2] || '' };
  return { source: trimmed, flags: '' };
}

/**
 * Parse a user-supplied regex pattern config entry.
 * Supports:
 *   - "raw regex string"
 *   - { name, pattern, flags, negate, weight }
 *   - "!pattern"  → negate shorthand
 * Used by filter.js for excluded/required regex lists.
 */
function normalizePatternEntry(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') {
    let raw = entry.trim();
    if (!raw) return null;
    let negate = false;
    if (raw.startsWith('!')) {
      negate = true;
      raw = raw.slice(1).trim();
    }
    const { source, flags } = parseRegexLiteralForm(raw);
    if (!source) return null;
    const rx = safeRegex(source, flags || 'i');
    return rx ? { pattern: rx, negate, weight: 1 } : null;
  }
  if (typeof entry === 'object') {
    if (entry.enabled === false) return null;
    const fromLiteral = parseRegexLiteralForm(entry.pattern);
    const inlineFlags = fromLiteral.flags;
    const explicitFlags = (typeof entry.flags === 'string') ? entry.flags : '';
    const flags = inlineFlags || explicitFlags || 'i';
    const rx = safeRegex(fromLiteral.source, flags);
    if (!rx) return null;
    const weight = Number.isFinite(entry.weight) ? entry.weight
      : Number.isFinite(entry.score) ? entry.score
      : 1;
    return {
      name: typeof entry.name === 'string' ? entry.name : undefined,
      pattern: rx,
      negate: Boolean(entry.negate),
      weight,
    };
  }
  return null;
}

function normalizePatternList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizePatternEntry).filter(Boolean);
}

function normalizeKeywordList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object' && typeof entry.value === 'string') return entry.value.trim();
      return '';
    })
    .filter(Boolean);
}

function buildKeywordRegex(keywords) {
  if (!keywords.length) return null;
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return safeRegex(`(${escaped})`, 'i');
}

function matchesAny(targets, pattern) {
  for (const target of targets) {
    pattern.lastIndex = 0;
    if (pattern.test(target)) return true;
  }
  return false;
}

/**
 * Annotate one stream with keyword match state.
 * Mutates and returns the stream.
 */
function annotateStreamMatches(stream, { keywordRegex }) {
  if (!stream || typeof stream !== 'object') return stream;
  if (!keywordRegex) return stream;
  const targets = getMatchableStrings(stream);
  stream._keywordMatched = matchesAny(targets, keywordRegex);
  return stream;
}

/**
 * Precompute keyword matches for a batch of streams.
 * @param {Array<object>} streams
 * @param {object} userConfig
 *   - preferredKeywordsPatterns: array of strings or {value} entries
 * @returns {Array<object>} the same array, each entry mutated with _keywordMatched
 */
function precomputeMatches(streams, userConfig = {}) {
  if (!Array.isArray(streams) || streams.length === 0) return streams || [];
  const keywords = normalizeKeywordList(userConfig.preferredKeywordsPatterns);
  const keywordRegex = buildKeywordRegex(keywords);
  if (!keywordRegex) return streams;
  for (const stream of streams) {
    annotateStreamMatches(stream, { keywordRegex });
  }
  return streams;
}

module.exports = {
  precomputeMatches,
  normalizePatternList,
  normalizePatternEntry,
  normalizeKeywordList,
  buildKeywordRegex,
  annotateStreamMatches,
};
