// Per-criterion sort key extractors.
//
// Reimplementation of the upstream dynamicSortKey() concept, adapted for our
// parsed NZB result shape. Each extractor takes a stream and the user's sort
// context and returns a numeric value where HIGHER = preferred (we always flip
// with the direction multiplier in the caller).
//
// Streams that should sort to the bottom for a criterion return
// Number.NEGATIVE_INFINITY (or equivalent), so that with direction `desc` they
// land last and with `asc` they land first.

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

// Synonym maps for sort dimensions where the parser emits a different token
// than typical preferred lists use (imported tokens, our admin UI tokens,
// hand-edited env vars, etc.). Each map's KEYS are forms that can appear on a
// stream or in a user list; the VALUE is the canonical form used for matching.
// Two tokens compare equal if they map to the same canonical form.
const ENCODE_SYNONYMS = {
  'x265': 'hevc', 'h265': 'hevc', 'h.265': 'hevc', 'hevc': 'hevc',
  'x264': 'avc', 'h264': 'avc', 'h.264': 'avc', 'avc': 'avc',
  'av1': 'av1',
  'xvid': 'xvid',
  'divx': 'divx', 'dvix': 'divx',
  'vp9': 'vp9',
  'mpeg2': 'mpeg2',
};
const AUDIO_SYNONYMS = {
  // DTS family
  'dts lossless': 'dts-hd ma', 'dts hd ma': 'dts-hd ma', 'dts-hd ma': 'dts-hd ma', 'dts hdma': 'dts-hd ma',
  'dts-hd': 'dts-hd', 'dts hd': 'dts-hd', 'dtshd': 'dts-hd',
  'dts-es': 'dts-es', 'dts es': 'dts-es',
  'dts:x': 'dts:x', 'dtsx': 'dts:x', 'dts x': 'dts:x',
  'dts lossy': 'dts', 'dts': 'dts',
  // Dolby Digital family
  'ddp': 'dd+', 'dd+': 'dd+', 'eac3': 'dd+', 'e-ac3': 'dd+', 'ddplus': 'dd+',
  'dd': 'dd', 'ac3': 'dd',
  'truehd': 'truehd', 'true-hd': 'truehd', 'true hd': 'truehd',
  'atmos': 'atmos', 'dolby atmos': 'atmos',
  // Other
  'aac': 'aac', 'aac2': 'aac', 'qaac': 'aac',
  'flac': 'flac',
  'opus': 'opus',
  'mp3': 'mp3',
};
const AUDIO_CHANNEL_SYNONYMS = {
  // Numeric channel tokens
  '7.1': '7.1', '7.1ch': '7.1', '8ch': '7.1',
  '6.1': '6.1', '6.1ch': '6.1',
  '5.1': '5.1', '5.1ch': '5.1', '6ch': '5.1',
  '2.1': '2.1', '2.1ch': '2.1',
  '2.0': '2.0', '2.0ch': '2.0', 'stereo': '2.0',
  '1.0': '1.0', '1.0ch': '1.0', 'mono': '1.0',
};
// Quality aliases. The canonical tier set has no standalone "REMUX" — any remux
// folds into "BluRay REMUX". Old configs that stored a bare "REMUX" (or the old
// parser's "TeleSync"/"TeleCine" labels) would otherwise stop matching, so map
// those legacy/alias spellings onto the canonical tier. Unmapped values fall
// through to themselves (canonicalize's `|| s`), so all other quality matching
// is unchanged.
const QUALITY_SYNONYMS = {
  'remux': 'bluray remux',
  'bd remux': 'bluray remux', 'br remux': 'bluray remux', 'uhd remux': 'bluray remux',
  'bdremux': 'bluray remux', 'brremux': 'bluray remux', 'uhdremux': 'bluray remux',
  'telesync': 'ts',
  'telecine': 'tc',
};
const RESOLUTION_SYNONYMS = {
  '4k': '4k', '2160p': '4k', 'uhd': '4k',
  '8k': '8k', '4320p': '8k',
  '1440p': '1440p', '2k': '1440p',
  '1080p': '1080p', 'fhd': '1080p',
  '720p': '720p', 'hd': '720p',
  '576p': '576p',
  '540p': '540p',
  '480p': '480p',
  '360p': '360p',
  '240p': '240p',
  '144p': '144p',
  'unknown': 'unknown',
};
const LANGUAGE_SYNONYMS = {
  'en': 'english', 'eng': 'english', 'english': 'english',
  'de': 'german', 'ger': 'german', 'deu': 'german', 'german': 'german',
  'fr': 'french', 'fre': 'french', 'fra': 'french', 'french': 'french',
  'es': 'spanish', 'spa': 'spanish', 'spanish': 'spanish', 'esp': 'spanish',
  'it': 'italian', 'ita': 'italian', 'italian': 'italian',
  'pt': 'portuguese', 'por': 'portuguese', 'portuguese': 'portuguese',
  // Brazilian Portuguese canonicalizes to 'portuguese' so it matches a
  // "Portuguese" preference (the only Portuguese option the UI exposes).
  'pt-br': 'portuguese', 'pt_br': 'portuguese', 'ptbr': 'portuguese', 'brazilian': 'portuguese',
  'ja': 'japanese', 'jpn': 'japanese', 'jap': 'japanese', 'japanese': 'japanese',
  'ko': 'korean', 'kor': 'korean', 'korean': 'korean',
  'zh': 'chinese', 'chi': 'chinese', 'zho': 'chinese', 'chinese': 'chinese',
  'ru': 'russian', 'rus': 'russian', 'russian': 'russian',
  'ar': 'arabic', 'ara': 'arabic', 'arabic': 'arabic',
  'hi': 'hindi', 'hin': 'hindi', 'hindi': 'hindi',
  'ta': 'tamil', 'tam': 'tamil', 'tamil': 'tamil',
  'te': 'telugu', 'tel': 'telugu', 'telugu': 'telugu',
  'ml': 'malayalam', 'mal': 'malayalam', 'malayalam': 'malayalam',
  'kn': 'kannada', 'kan': 'kannada', 'kannada': 'kannada',
  'bn': 'bengali', 'ben': 'bengali', 'bengali': 'bengali',
  'mr': 'marathi', 'mar': 'marathi', 'marathi': 'marathi',
  'gu': 'gujarati', 'guj': 'gujarati', 'gujarati': 'gujarati',
  'pa': 'punjabi', 'pan': 'punjabi', 'punjabi': 'punjabi',
  'ur': 'urdu', 'urd': 'urdu', 'urdu': 'urdu',
  'tr': 'turkish', 'tur': 'turkish', 'turkish': 'turkish',
  'pl': 'polish', 'pol': 'polish', 'polish': 'polish',
  'cs': 'czech', 'cze': 'czech', 'ces': 'czech', 'czech': 'czech',
  'nl': 'dutch', 'dut': 'dutch', 'nld': 'dutch', 'dutch': 'dutch',
  'sv': 'swedish', 'swe': 'swedish', 'swedish': 'swedish',
  'no': 'norwegian', 'nor': 'norwegian', 'norwegian': 'norwegian',
  'da': 'danish', 'dan': 'danish', 'danish': 'danish',
  'fi': 'finnish', 'fin': 'finnish', 'finnish': 'finnish',
  'th': 'thai', 'tha': 'thai', 'thai': 'thai',
  'vi': 'vietnamese', 'vie': 'vietnamese', 'vietnamese': 'vietnamese',
  'id': 'indonesian', 'ind': 'indonesian', 'indonesian': 'indonesian',
  'ms': 'malay', 'msa': 'malay', 'malay': 'malay',
  'tl': 'tagalog', 'tgl': 'tagalog', 'tagalog': 'tagalog',
  'fil': 'filipino', 'filipino': 'filipino',
  // --- Languages added this session: every UI label + the ISO 639-1/2 codes
  // the parser emits must canonicalize to the same form, or exclude/prefer by
  // name won't match a code-tagged release. ---
  'la': 'latino', 'lat': 'latino', 'latino': 'latino', 'latin spanish': 'latino',
  'ca': 'catalan', 'cat': 'catalan', 'catalan': 'catalan',
  'eu': 'basque', 'eus': 'basque', 'baq': 'basque', 'basque': 'basque',
  'gl': 'galician', 'glg': 'galician', 'galician': 'galician',
  'cy': 'welsh', 'cym': 'welsh', 'wel': 'welsh', 'welsh': 'welsh',
  'ga': 'irish', 'gle': 'irish', 'irish': 'irish',
  'bho': 'bhojpuri', 'bhojpuri': 'bhojpuri',
  'ne': 'nepali', 'nep': 'nepali', 'nepali': 'nepali',
  'si': 'sinhala', 'sin': 'sinhala', 'sinhala': 'sinhala', 'sinhalese': 'sinhala',
  'taiwanese': 'taiwanese', 'zh-tw': 'taiwanese', 'zh_tw': 'taiwanese',
  'mn': 'mongolian', 'mon': 'mongolian', 'mongolian': 'mongolian',
  'km': 'khmer', 'khm': 'khmer', 'khmer': 'khmer', 'cambodian': 'khmer',
  'lo': 'lao', 'lao': 'lao',
  'my': 'burmese', 'mya': 'burmese', 'bur': 'burmese', 'burmese': 'burmese', 'myanmar': 'burmese',
  'he': 'hebrew', 'heb': 'hebrew', 'iw': 'hebrew', 'hebrew': 'hebrew',
  'fa': 'persian', 'fas': 'persian', 'per': 'persian', 'persian': 'persian', 'farsi': 'persian',
  'ps': 'pashto', 'pus': 'pashto', 'pashto': 'pashto',
  'az': 'azerbaijani', 'aze': 'azerbaijani', 'azerbaijani': 'azerbaijani', 'azeri': 'azerbaijani',
  'kk': 'kazakh', 'kaz': 'kazakh', 'kazakh': 'kazakh',
  'uz': 'uzbek', 'uzb': 'uzbek', 'uzbek': 'uzbek',
  'hy': 'armenian', 'hye': 'armenian', 'arm': 'armenian', 'armenian': 'armenian',
  'ka': 'georgian', 'kat': 'georgian', 'geo': 'georgian', 'georgian': 'georgian',
  'uk': 'ukrainian', 'ukr': 'ukrainian', 'ukrainian': 'ukrainian',
  'sk': 'slovak', 'slk': 'slovak', 'slo': 'slovak', 'slovak': 'slovak',
  'sl': 'slovenian', 'slv': 'slovenian', 'slovenian': 'slovenian', 'slovene': 'slovenian',
  'hr': 'croatian', 'hrv': 'croatian', 'croatian': 'croatian',
  'sr': 'serbian', 'srp': 'serbian', 'serbian': 'serbian',
  'bg': 'bulgarian', 'bul': 'bulgarian', 'bulgarian': 'bulgarian',
  'mk': 'macedonian', 'mkd': 'macedonian', 'mac': 'macedonian', 'macedonian': 'macedonian',
  'be': 'belarusian', 'bel': 'belarusian', 'belarusian': 'belarusian',
  'sq': 'albanian', 'alb': 'albanian', 'sqi': 'albanian', 'albanian': 'albanian',
  'is': 'icelandic', 'isl': 'icelandic', 'ice': 'icelandic', 'icelandic': 'icelandic',
  'et': 'estonian', 'est': 'estonian', 'estonian': 'estonian',
  'lv': 'latvian', 'lav': 'latvian', 'latvian': 'latvian',
  'lt': 'lithuanian', 'lit': 'lithuanian', 'lithuanian': 'lithuanian',
  'el': 'greek', 'ell': 'greek', 'gre': 'greek', 'greek': 'greek',
  'ro': 'romanian', 'ron': 'romanian', 'rum': 'romanian', 'romanian': 'romanian',
  'hu': 'hungarian', 'hun': 'hungarian', 'hungarian': 'hungarian',
  'af': 'afrikaans', 'afr': 'afrikaans', 'afrikaans': 'afrikaans',
  'sw': 'swahili', 'swa': 'swahili', 'swahili': 'swahili',
  'am': 'amharic', 'amh': 'amharic', 'amharic': 'amharic',
  'yo': 'yoruba', 'yor': 'yoruba', 'yoruba': 'yoruba',
  'zu': 'zulu', 'zul': 'zulu', 'zulu': 'zulu',
};

function canonicalize(value, synonyms) {
  const lower = normalizeString(value);
  if (!lower) return '';
  if (synonyms && Object.prototype.hasOwnProperty.call(synonyms, lower)) return synonyms[lower];
  return lower;
}

function listIndex(list, target, synonyms) {
  if (!Array.isArray(list) || list.length === 0 || target === null || target === undefined || target === '') return -1;
  const needle = canonicalize(target, synonyms);
  if (!needle) return -1;
  for (let i = 0; i < list.length; i += 1) {
    if (canonicalize(list[i], synonyms) === needle) return i;
  }
  return -1;
}

// Find the smallest index among `candidates` in `list`. -1 if no match.
function bestListIndex(list, candidates, synonyms) {
  if (!Array.isArray(list) || list.length === 0) return -1;
  if (!Array.isArray(candidates) || candidates.length === 0) return -1;
  let best = -1;
  for (const candidate of candidates) {
    const idx = listIndex(list, candidate, synonyms);
    if (idx === -1) continue;
    if (best === -1 || idx < best) best = idx;
  }
  return best;
}

// Convert an "index into preferred list" into a sort score:
//   matched   → `-idx`        (lower index = better)
//   unmatched → `-Infinity`   (always worst)
// The caller multiplies by direction (-1 for desc, +1 for asc), then the
// compare is ascending. Effect:
//   desc + idx 0   →  0    (sorts first)
//   desc + idx 5   →  5    (sorts after index 0)
//   desc + unmatched → +Inf (sorts last)
//   asc  + unmatched → -Inf (sorts first)
function indexScore(idx) {
  if (idx === -1) return Number.NEGATIVE_INFINITY;
  return -idx;
}

function getStreamResolution(stream) {
  if (!stream) return 'unknown';
  // Missing/undetectable resolution normalizes to the literal "unknown" so the
  // Allowed-Resolutions grid's "unknown" checkbox actually controls whether
  // these streams are kept (filter) and where they rank (sort), via an explicit
  // "Unknown" bucket. RESOLUTION_SYNONYMS maps 'unknown' → 'unknown', and the
  // grid offers an "unknown" option.
  return stream.resolution || stream.parsedFile?.resolution || 'unknown';
}

function getStreamQuality(stream) {
  if (!stream) return null;
  // parsedFile fallback must read the parser's actual field name (qualityLabel),
  // not 'quality' — otherwise the fallback silently yields nothing.
  return stream.qualityLabel || stream.source || stream.parsedFile?.qualityLabel || null;
}

function getStreamEncode(stream) {
  if (!stream) return null;
  // Prefer the canonical `encode` tier (HEVC/AVC/AV1/XviD/DivX). Fall back to
  // the raw `codec` for streams parsed before the classifier landed.
  return stream.encode || stream.parsedFile?.encode || stream.codec || stream.parsedFile?.codec || null;
}

function getStreamReleaseGroup(stream) {
  if (!stream) return null;
  return stream.group || stream.releaseGroup || stream.parsedFile?.releaseGroup || null;
}

function getStreamVisualTags(stream) {
  if (!stream) return [];
  // Canonical visualTags (incl. derived HDR+DV / DV Only / HDR Only). When
  // present, use them verbatim. Fall back to the raw hdr list only for streams
  // parsed before the classifier landed.
  const visual = Array.isArray(stream.visualTags) ? stream.visualTags : [];
  const parsed = Array.isArray(stream.parsedFile?.visualTags) ? stream.parsedFile.visualTags : [];
  if (visual.length || parsed.length) return [...visual, ...parsed];
  const hdr = Array.isArray(stream.hdrList) ? stream.hdrList : [];
  return [...hdr];
}

function getStreamAudioTags(stream) {
  if (!stream) return [];
  // Canonical audioTags (Atmos/DD+/DTS:X/…). Fall back to the raw audio list
  // for streams parsed before the classifier landed.
  const tags = Array.isArray(stream.audioTags) ? stream.audioTags : [];
  const parsed = Array.isArray(stream.parsedFile?.audioTags) ? stream.parsedFile.audioTags : [];
  if (tags.length || parsed.length) return [...tags, ...parsed];
  const audio = Array.isArray(stream.audioList) ? stream.audioList : [];
  const parsedAudio = Array.isArray(stream.parsedFile?.audioList) ? stream.parsedFile.audioList : [];
  return [...audio, ...parsedAudio];
}

function getStreamAudioChannels(stream) {
  if (!stream) return [];
  return Array.isArray(stream.audioChannels) ? stream.audioChannels : [];
}

function getStreamLanguages(stream) {
  if (!stream) return [];
  const direct = Array.isArray(stream.languages) ? stream.languages : [];
  const inferred = Array.isArray(stream.inferredLanguages) ? stream.inferredLanguages : [];
  return [...direct, ...inferred];
}

function getStreamBitrate(stream) {
  if (!stream) return null;
  const value = stream.bitrate ?? stream.parsedFile?.bitrate;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function getStreamSize(stream) {
  if (!stream) return 0;
  if (Number.isFinite(stream.estimatedEpisodeSize)) return stream.estimatedEpisodeSize;
  return Number.isFinite(stream.size) ? stream.size : 0;
}

function getStreamAgeMs(stream) {
  if (!stream) return null;
  const ms = stream.publishDateMs;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Date.now() - ms;
}

function getStreamFileCount(stream) {
  if (!stream) return null;
  const n = stream.files;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Build the comparison value for a single sort criterion. The caller applies
// the direction multiplier and lexicographically compares the array of values.
function valueForCriterion(criterion, stream, context = {}) {
  const key = criterion?.key;
  if (!key) return 0;

  const preferred = context.preferred || {};

  switch (key) {
    case 'size':
      return getStreamSize(stream);

    case 'age': {
      // Returns the age in ms (older = larger value). With direction `desc`
      // (multiplier -1) older items sort first; with `asc`, newer first.
      // Users flip via the direction toggle.
      const ageMs = getStreamAgeMs(stream);
      return ageMs ?? 0;
    }

    case 'files': {
      // Returns file count. With `desc` (default), MORE files first (matches
      // size convention). Users who want fewer first should set direction `asc`.
      // Note: legacy migration sets direction='asc' so the old "fewer first"
      // behavior is preserved for migrated configs.
      const n = getStreamFileCount(stream);
      return n ?? 0;
    }

    case 'resolution': {
      const list = preferred.resolutions || [];
      const idx = listIndex(list, getStreamResolution(stream), RESOLUTION_SYNONYMS);
      return indexScore(idx);
    }

    case 'quality': {
      const list = preferred.qualities || [];
      const idx = listIndex(list, getStreamQuality(stream), QUALITY_SYNONYMS);
      return indexScore(idx);
    }

    case 'encode': {
      const list = preferred.encodes || [];
      const idx = listIndex(list, getStreamEncode(stream), ENCODE_SYNONYMS);
      return indexScore(idx);
    }

    case 'releaseGroup': {
      const list = preferred.releaseGroups || [];
      const idx = listIndex(list, getStreamReleaseGroup(stream));
      return indexScore(idx);
    }

    case 'visualTag': {
      const list = preferred.visualTags || [];
      const idx = bestListIndex(list, getStreamVisualTags(stream));
      return indexScore(idx);
    }

    case 'audioTag': {
      const list = preferred.audioTags || [];
      const idx = bestListIndex(list, getStreamAudioTags(stream), AUDIO_SYNONYMS);
      return indexScore(idx);
    }

    case 'audioChannel': {
      const list = preferred.audioChannels || [];
      const idx = bestListIndex(list, getStreamAudioChannels(stream), AUDIO_CHANNEL_SYNONYMS);
      return indexScore(idx);
    }

    case 'language': {
      const list = preferred.languages || [];
      const idx = bestListIndex(list, getStreamLanguages(stream), LANGUAGE_SYNONYMS);
      return indexScore(idx);
    }

    case 'keyword': {
      // Pattern-based keyword match (precomputed). 1 if match, 0 otherwise.
      return stream._keywordMatched ? 1 : 0;
    }

    // Not relevant for our addon — kept here so an imported config that lists
    // these keys doesn't blow up. Always returns 0 so the criterion is a no-op.
    // `bitrate` lives here too: it's still supported as a numeric *filter*
    // (Max Bitrate), but NOT as a sort key — for a single requested title all
    // candidates share one TMDb runtime, so bitrate sort is identical to size
    // sort (bitrate = size × constant). It's dropped from the sort builder and
    // warned-and-dropped on import; this no-op guards any leftover config.
    case 'bitrate':
    case 'cached':
    case 'library':
    case 'service':
    case 'seeders':
    case 'private':
    case 'addon':
    case 'subtitle':
    case 'seadex':
    case 'streamType':
    case 'regexPatterns':
    case 'regexScore':
    case 'streamExpressionScore':
    case 'streamExpressionMatched':
      return 0;

    default:
      return 0;
  }
}

module.exports = {
  valueForCriterion,
  // Exported for tests / regex precomputers
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
  getStreamFileCount,
  listIndex,
  bestListIndex,
  indexScore,
  // Synonym maps exported so filter.js can canonicalize values before
  // membership checks (e.g. user excludes "Stereo" — stream has "2.0";
  // excludes "english" — stream has "en"; excludes "4k" — stream has "2160p").
  AUDIO_CHANNEL_SYNONYMS,
  AUDIO_SYNONYMS,
  ENCODE_SYNONYMS,
  QUALITY_SYNONYMS,
  RESOLUTION_SYNONYMS,
  LANGUAGE_SYNONYMS,
};
