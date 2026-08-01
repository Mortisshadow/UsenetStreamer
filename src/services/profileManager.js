// Profile manager — multi-profile support (Phase 0 scaffolding; no callers yet).
//
// Profiles are named override sets that share all global config (creds, indexers,
// NZBDav, NNTP, TMDb/TVDB, proxy, caches) but each override a small fixed set of
// categories: addon name, stream-protection mode, sorting, filtering, naming,
// and Stremio catalog limit.
//
// Storage: flat numbered-slot keys in runtime-env.json (mirrors the per-indexer
// NEWZNAB_<FIELD>_<NN> pattern, but number-first for readability so a profile's
// keys group together when the file is sorted):
//
//     NZB_PROFILE_01_NAME              = "kids"          // URL slug + identifier
//     NZB_PROFILE_01_ADDON_NAME        = "Streamer — Kids"
//     NZB_PROFILE_01_STREAM_PROTECTION = "smart-play"
//     NZB_PROFILE_01_SORT_ORDER_MOVIES = "..."
//     ...
//
// A slot is "active" when its NAME field is non-empty; NAME is the URL segment.
// An empty/absent field = inherit the global value.

const MAX_PROFILES = 50;

// Per-profile field suffix -> the global env key it overrides.
// NAME is the identifier/URL slug and has no global counterpart (handled separately).
// Covers addon name, streaming mode, protection, and the full sort/filter surface
// (sort order/mode, preferred/excluded sets, allowed resolutions, size/bitrate,
// regex, naming, catalog limit) so a profile can override any of them. The map is
// extensible — add a suffix here and it flows through getEffectiveConfig + sortSource.
const PROFILE_OVERRIDES = {
  ADDON_NAME: 'ADDON_NAME',
  STREAMING_MODE: 'STREAMING_MODE',
  STREAM_PROTECTION: 'NZB_STREAM_PROTECTION',
  SORT_ORDER: 'NZB_SORT_ORDER',
  SORT_ORDER_MOVIES: 'NZB_SORT_ORDER_MOVIES',
  SORT_ORDER_SERIES: 'NZB_SORT_ORDER_SERIES',
  SORT_ORDER_ANIME: 'NZB_SORT_ORDER_ANIME',
  AIO_SORT_CONFIG: 'NZB_AIO_SORT_CONFIG',
  RANKED_RULES: 'NZB_RANKED_RULES',
  DEDUP_MODE: 'NZB_DEDUP_MODE',
  SEASON_PACK_MODE: 'NZB_SEASON_PACK_MODE',
  PREFERRED_AUDIO_CHANNELS: 'NZB_PREFERRED_AUDIO_CHANNELS',
  RESOLUTION_LIMIT: 'NZB_RESOLUTION_LIMIT_PER_QUALITY',
  MIN_SIZE_GB: 'NZB_MIN_RESULT_SIZE_GB',
  MAX_SIZE_GB: 'NZB_MAX_RESULT_SIZE_GB',
  MAX_BITRATE: 'NZB_MAX_BITRATE_MBPS',
  EXCLUDED_AUDIO_TAGS: 'NZB_EXCLUDED_AUDIO_TAGS',
  SORT_MODE: 'NZB_SORT_MODE',
  PREFERRED_LANGUAGE: 'NZB_PREFERRED_LANGUAGE',
  PREFERRED_QUALITIES: 'NZB_PREFERRED_QUALITIES',
  PREFERRED_ENCODES: 'NZB_PREFERRED_ENCODES',
  PREFERRED_RELEASE_GROUPS: 'NZB_PREFERRED_RELEASE_GROUPS',
  PREFERRED_VISUAL_TAGS: 'NZB_PREFERRED_VISUAL_TAGS',
  PREFERRED_AUDIO_TAGS: 'NZB_PREFERRED_AUDIO_TAGS',
  PREFERRED_KEYWORDS: 'NZB_PREFERRED_KEYWORDS',
  ALLOWED_RESOLUTIONS: 'NZB_ALLOWED_RESOLUTIONS',
  RELEASE_EXCLUSIONS: 'NZB_RELEASE_EXCLUSIONS',
  EXCLUDED_QUALITIES: 'NZB_EXCLUDED_QUALITIES',
  EXCLUDED_ENCODES: 'NZB_EXCLUDED_ENCODES',
  EXCLUDED_VISUAL_TAGS: 'NZB_EXCLUDED_VISUAL_TAGS',
  EXCLUDED_AUDIO_CHANNELS: 'NZB_EXCLUDED_AUDIO_CHANNELS',
  EXCLUDED_LANGUAGES: 'NZB_EXCLUDED_LANGUAGES',
  EXCLUDED_RELEASE_GROUPS: 'NZB_EXCLUDED_RELEASE_GROUPS',
  EXCLUDED_REGEX_PATTERNS: 'NZB_EXCLUDED_REGEX_PATTERNS',
  REQUIRED_REGEX_PATTERNS: 'NZB_REQUIRED_REGEX_PATTERNS',
  NAMING_PATTERN: 'NZB_NAMING_PATTERN',
  DISPLAY_NAME_PATTERN: 'NZB_DISPLAY_NAME_PATTERN',
  CATALOG_LIMIT: 'NZBDAV_HISTORY_CATALOG_LIMIT',
};

// All per-slot field suffixes (NAME first, then the overridable categories).
const PROFILE_FIELD_SUFFIXES = ['NAME', ...Object.keys(PROFILE_OVERRIDES)];

// Flat numbered keys, for later registration with the config save/load layer
// (Phase 5). Number-first: NZB_PROFILE_<NN>_<FIELD>.
const PROFILE_NUMBERED_KEYS = [];
for (let i = 1; i <= MAX_PROFILES; i += 1) {
  const idx = String(i).padStart(2, '0');
  PROFILE_FIELD_SUFFIXES.forEach((suffix) => {
    PROFILE_NUMBERED_KEYS.push(`NZB_PROFILE_${idx}_${suffix}`);
  });
}

// Names that would collide with routes/resources and must never be a profile.
const RESERVED_PROFILE_NAMES = new Set([
  'admin', 'manifest.json', 'manifest', 'stream', 'catalog', 'meta',
  'nzb', 'easynews', 'subtitles', 'assets', 'configure', 'default',
]);
const PROFILE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function slugifyProfileName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Valid as a URL segment AND not a reserved word.
function isValidProfileName(name) {
  const s = String(name || '');
  return PROFILE_NAME_RE.test(s) && !RESERVED_PROFILE_NAMES.has(s.toLowerCase());
}

function normalizeStreamingMode(m) {
  return String(m || 'nzbdav').trim().toLowerCase() === 'native' ? 'native' : 'nzbdav';
}

// Each profile freely chooses its streaming mode, or inherits the default when
// unset. There is NO cross-default constraint — an nzbdav profile just needs
// NZBDav creds (shared) configured, and a native profile uses newznab-only; both
// are surfaced as UI hints, not enforced rules.
function resolveStreamingMode(profileMode, defaultMode) {
  const p = String(profileMode || '').trim().toLowerCase();
  if (p === 'native' || p === 'nzbdav') return p;
  return normalizeStreamingMode(defaultMode); // inherit default
}

// Parse all active profile slots from a source (defaults to process.env).
// Returns Map<slug, { name, slug, slot, overrides: { <SUFFIX>: value } }>.
function getProfiles(source = process.env) {
  const profiles = new Map();
  for (let i = 1; i <= MAX_PROFILES; i += 1) {
    const idx = String(i).padStart(2, '0');
    const rawName = String(source[`NZB_PROFILE_${idx}_NAME`] || '').trim();
    if (!rawName) continue;
    const slug = slugifyProfileName(rawName);
    if (!slug) continue;
    const overrides = {};
    Object.keys(PROFILE_OVERRIDES).forEach((suffix) => {
      const v = source[`NZB_PROFILE_${idx}_${suffix}`];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        overrides[suffix] = String(v);
      }
    });
    profiles.set(slug, { name: rawName, slug, slot: idx, overrides });
  }
  return profiles;
}

// Effective config for a profile: { <globalKey>: override ?? currentGlobal } for
// every per-profile key. For no profileName, returns the globals unchanged.
// Returns null if a profileName is given but no matching active profile exists
// (callers treat that as a 404 in later phases).
function getEffectiveConfig(profileName, source = process.env) {
  const config = {};
  Object.values(PROFILE_OVERRIDES).forEach((globalKey) => {
    config[globalKey] = source[globalKey];
  });
  if (!profileName) return { profile: null, config };

  const slug = slugifyProfileName(profileName);
  const profile = getProfiles(source).get(slug);
  if (!profile) return null; // unknown profile

  Object.entries(profile.overrides).forEach(([suffix, value]) => {
    const globalKey = PROFILE_OVERRIDES[suffix];
    if (globalKey) config[globalKey] = value;
  });
  // Use the profile's streaming mode, or inherit the default when unset.
  config.STREAMING_MODE = resolveStreamingMode(config.STREAMING_MODE, source.STREAMING_MODE);
  return { profile, config };
}

module.exports = {
  MAX_PROFILES,
  PROFILE_OVERRIDES,
  PROFILE_FIELD_SUFFIXES,
  PROFILE_NUMBERED_KEYS,
  RESERVED_PROFILE_NAMES,
  slugifyProfileName,
  isValidProfileName,
  resolveStreamingMode,
  getProfiles,
  getEffectiveConfig,
};
