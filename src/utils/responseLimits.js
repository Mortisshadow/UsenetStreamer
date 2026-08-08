'use strict';

function boundedBytesFromEnv(name, fallback, { min = 64 * 1024, max = 256 * 1024 * 1024 } = {}) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

const RESPONSE_LIMITS = Object.freeze({
  managerSearch: boundedBytesFromEnv('INDEXER_MANAGER_MAX_RESPONSE_BYTES', 16 * 1024 * 1024),
  newznabSearch: boundedBytesFromEnv('NEWZNAB_MAX_SEARCH_RESPONSE_BYTES', 16 * 1024 * 1024),
  newznabCaps: boundedBytesFromEnv('NEWZNAB_MAX_CAPS_RESPONSE_BYTES', 1024 * 1024),
  animeDatabase: boundedBytesFromEnv('ANIME_DB_MAX_RESPONSE_BYTES', 128 * 1024 * 1024),
  nzbDownload: boundedBytesFromEnv('NZB_DOWNLOAD_MAX_RESPONSE_BYTES', 64 * 1024 * 1024),
});

function axiosResponseLimit(maxBytes) {
  return {
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
  };
}

module.exports = { RESPONSE_LIMITS, axiosResponseLimit, boundedBytesFromEnv };
