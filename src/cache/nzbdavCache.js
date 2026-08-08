// NZBDav stream mount cache module
// Holds tiny mount descriptors (nzoId, viewPath, …) keyed by download+category.
// Kept in RAM but bounded by both a TTL (default 30 days for successes) and an
// LRU entry-count cap so it can't grow without limit.
const nzbdavStreamCache = new Map();
let cacheGeneration = 0;

// Mount descriptors point at NZBDav mounts that rotate out over time, so this
// stays at 72h (original) — an old pointer is likely dead; better to re-resolve
// than to serve a stale mount.
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;

let NZBDAV_CACHE_TTL_MS = DEFAULT_TTL_MS;

// Entry-count cap with LRU eviction (0 = unlimited). Entries are ~1-2 KB each.
const MAX_ENTRIES = (() => {
  const raw = Number(process.env.NZBDAV_CACHE_MAX_ENTRIES);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 2000;
})();

function reloadNzbdavCacheConfig() {
  const raw = Number(process.env.NZBDAV_CACHE_TTL_MINUTES);
  if (Number.isFinite(raw) && raw >= 0) {
    NZBDAV_CACHE_TTL_MS = raw * 60 * 1000;
  } else {
    NZBDAV_CACHE_TTL_MS = DEFAULT_TTL_MS;
  }
}

reloadNzbdavCacheConfig();

function cleanupNzbdavCache() {
  const now = Date.now();

  // 1. TTL purge (each entry carries its own expiresAt; failed entries expire
  //    on the short window). Skip purge entirely only if TTL is disabled AND
  //    nothing has a concrete expiresAt.
  for (const [key, entry] of nzbdavStreamCache.entries()) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      nzbdavStreamCache.delete(key);
    }
  }

  // 2. Count cap — evict least-recently-used entries until under the limit.
  //    All entries participate so the cap is always enforceable. 'pending'
  //    entries are created with lastAccessedAt=now (newest), so they sort last
  //    and are only evicted when nothing else is left (extreme burst). Evicting
  //    a pending entry is safe: its in-flight promise still resolves and a
  //    concurrent caller would simply rebuild.
  if (MAX_ENTRIES > 0 && nzbdavStreamCache.size > MAX_ENTRIES) {
    const evictable = Array.from(nzbdavStreamCache.entries())
      .sort((a, b) => (a[1].lastAccessedAt || 0) - (b[1].lastAccessedAt || 0));
    let overBy = nzbdavStreamCache.size - MAX_ENTRIES;
    for (const [key] of evictable) {
      if (overBy <= 0) break;
      nzbdavStreamCache.delete(key);
      overBy -= 1;
    }
  }
}

function clearNzbdavStreamCache(reason = 'manual') {
  if (nzbdavStreamCache.size > 0) {
    console.log('[CACHE] Cleared NZBDav stream cache', { reason, entries: nzbdavStreamCache.size });
  }
  cacheGeneration += 1;
  nzbdavStreamCache.clear();
}

/**
 * Return a cached 'ready' NZBDav stream entry without triggering a build.
 * Returns null if not cached or not ready.
 */
function getCachedNzbdavStream(cacheKey) {
  cleanupNzbdavCache();
  const existing = nzbdavStreamCache.get(cacheKey);
  if (existing && existing.status === 'ready') {
    existing.lastAccessedAt = Date.now();
    return existing.data;
  }
  return null;
}

async function getOrCreateNzbdavStream(cacheKey, builder) {
  cleanupNzbdavCache();
  const existing = nzbdavStreamCache.get(cacheKey);

  if (existing) {
    if (existing.status === 'ready') {
      existing.lastAccessedAt = Date.now();
      return existing.data;
    }
    if (existing.status === 'pending') {
      return existing.promise;
    }
    if (existing.status === 'failed') {
      throw existing.error;
    }
  }

  const generation = cacheGeneration;
  const pendingEntry = {
    status: 'pending',
    promise: null,
    lastAccessedAt: Date.now(),
    generation,
  };
  const promise = (async () => {
    const data = await builder();
    // A clear, LRU eviction, or direct replacement revokes this builder's
    // ownership. Its caller still receives the result, but stale work must not
    // repopulate the shared cache.
    if (cacheGeneration === generation && nzbdavStreamCache.get(cacheKey) === pendingEntry) {
      nzbdavStreamCache.set(cacheKey, {
        status: 'ready',
        data,
        lastAccessedAt: Date.now(),
        expiresAt: NZBDAV_CACHE_TTL_MS > 0 ? Date.now() + NZBDAV_CACHE_TTL_MS : null
      });
    }
    return data;
  })();
  pendingEntry.promise = promise;
  nzbdavStreamCache.set(cacheKey, pendingEntry);

  try {
    return await promise;
  } catch (error) {
    if (cacheGeneration !== generation || nzbdavStreamCache.get(cacheKey) !== pendingEntry) {
      throw error;
    }
    if (error?.isNzbdavFailure) {
      nzbdavStreamCache.set(cacheKey, {
        status: 'failed',
        error,
        lastAccessedAt: Date.now(),
        expiresAt: NZBDAV_CACHE_TTL_MS > 0 ? Date.now() + NZBDAV_CACHE_TTL_MS : null
      });
    } else {
      nzbdavStreamCache.delete(cacheKey);
    }
    throw error;
  }
}

function buildNzbdavCacheKey(downloadUrl, category, requestedEpisode = null, profileName = null) {
  const parts = [downloadUrl, category];
  if (requestedEpisode) {
    parts.push(`S${requestedEpisode.season}E${requestedEpisode.episode}`);
  }
  // Appended only when set, so default (no-profile) keys stay byte-identical.
  if (profileName) parts.push(`p:${profileName}`);
  return parts.join('::');
}

function getNzbdavCacheStats() {
  const stats = {
    entries: nzbdavStreamCache.size,
    ttlMs: NZBDAV_CACHE_TTL_MS,
    maxEntries: MAX_ENTRIES,
    byStatus: { ready: 0, pending: 0, failed: 0 },
  };

  for (const entry of nzbdavStreamCache.values()) {
    if (entry.status) {
      stats.byStatus[entry.status] = (stats.byStatus[entry.status] || 0) + 1;
    }
  }

  return stats;
}

/**
 * Directly cache a stream result (e.g. from a successful auto-advance).
 * Overwrites any existing entry (including failed ones) for this key.
 */
function cacheNzbdavStreamResult(cacheKey, data) {
  nzbdavStreamCache.set(cacheKey, {
    status: 'ready',
    data,
    lastAccessedAt: Date.now(),
    expiresAt: NZBDAV_CACHE_TTL_MS > 0 ? Date.now() + NZBDAV_CACHE_TTL_MS : null,
  });
  cleanupNzbdavCache();
}

module.exports = {
  cleanupNzbdavCache,
  clearNzbdavStreamCache,
  getCachedNzbdavStream,
  getOrCreateNzbdavStream,
  cacheNzbdavStreamResult,
  buildNzbdavCacheKey,
  getNzbdavCacheStats,
  reloadNzbdavCacheConfig,
};
