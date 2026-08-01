// Staffelweiter Cache und SingleFlight-Koordinator für zusätzliche Pack-Suchen.
// Der Koordinator kennt keine Indexer- oder Health-Logik: Der Aufrufer liefert
// einen Search-Task, und nur dessen vollständig validierter Snapshot wird
// atomar veröffentlicht.

const DEFAULT_POSITIVE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PARTIAL_TTL_MS = 60 * 60 * 1000;
const DEFAULT_ERROR_RETRY_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_QUEUED = 50;
const DEFAULT_JOB_TIMEOUT_MS = 45 * 1000;
const { classifyPackTitle } = require('../utils/episodeMatching');

const snapshots = new Map();
const pendingJobs = [];
let activeJobs = 0;
let generation = 0;

function resolveMode(source, streamingMode) {
  if (streamingMode === 'native') return 'off';
  const explicit = String(source?.NZB_SEASON_PACK_MODE || '').trim().toLowerCase();
  if (explicit === 'background' || explicit === 'wait' || explicit === 'off') return explicit;
  if (explicit === 'sync' || explicit === 'synchronous') return 'wait';
  const legacy = String(source?.NZB_INCLUDE_SEASON_PACKS ?? 'true').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(legacy)) return 'off';
  return 'background';
}

function mergeSnapshotResults(baseResults, snapshotResults, requestedEpisode) {
  const season = Number(requestedEpisode?.season);
  const episode = Number(requestedEpisode?.episode);
  if (!Number.isFinite(season) || !Number.isFinite(episode) || !Array.isArray(snapshotResults)) {
    return Array.isArray(baseResults) ? baseResults.slice() : [];
  }
  const merged = Array.isArray(baseResults) ? baseResults.slice() : [];
  const seen = new Set(merged.map((item) => [
    item?.downloadUrl || '',
    item?.title || item?.Title || '',
    item?.size || item?.Size || 0,
  ].join('|')));
  snapshotResults.forEach((source) => {
    if (!source || typeof source !== 'object' || !source.downloadUrl) return;
    const identity = [
      source.downloadUrl,
      source.title || source.Title || '',
      source.size || source.Size || 0,
    ].join('|');
    if (seen.has(identity)) return;
    const packInfo = classifyPackTitle(source.title || source.Title || '', season, episode);
    if (!packInfo) return;
    seen.add(identity);
    merged.push({
      ...source,
      isSeasonPack: true,
      packType: packInfo.type || null,
      packLabel: packInfo.label || null,
      packRange: packInfo.range || null,
      packStartEpisode: packInfo.startEpisode ?? null,
      packEndEpisode: packInfo.endEpisode ?? null,
      packStartSeason: packInfo.startSeason ?? null,
      packEndSeason: packInfo.endSeason ?? null,
    });
  });
  return merged;
}

function envNumber(name, fallback, { min = 0, integer = true } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < min) return fallback;
  return integer ? Math.floor(value) : value;
}

function positiveTtlMs() {
  return envNumber('NZB_SEASON_PACK_CACHE_TTL_MINUTES', DEFAULT_POSITIVE_TTL_MS / 60000) * 60000;
}

function negativeTtlMs() {
  return envNumber('NZB_SEASON_PACK_NEGATIVE_TTL_MINUTES', DEFAULT_NEGATIVE_TTL_MS / 60000) * 60000;
}

function partialTtlMs() {
  return envNumber('NZB_SEASON_PACK_PARTIAL_TTL_MINUTES', DEFAULT_PARTIAL_TTL_MS / 60000) * 60000;
}

function errorRetryMs() {
  return envNumber('NZB_SEASON_PACK_ERROR_RETRY_SECONDS', DEFAULT_ERROR_RETRY_MS / 1000) * 1000;
}

function maxEntries() {
  return envNumber('NZB_SEASON_PACK_CACHE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES);
}

function maxConcurrent() {
  return Math.max(1, envNumber('NZB_SEASON_PACK_MAX_CONCURRENT_SEARCHES', DEFAULT_MAX_CONCURRENT, { min: 1 }));
}

function maxQueued() {
  return envNumber('NZB_SEASON_PACK_MAX_QUEUED_SEARCHES', DEFAULT_MAX_QUEUED);
}

function jobTimeoutMs() {
  return envNumber('NZB_SEASON_PACK_JOB_TIMEOUT_MS', DEFAULT_JOB_TIMEOUT_MS);
}

function runWithTimeout(task) {
  const timeoutMs = jobTimeoutMs();
  const actual = Promise.resolve().then(task);
  const actualSettled = actual.then(() => undefined, () => undefined);
  if (timeoutMs <= 0) {
    actual.actualSettled = actualSettled;
    return actual;
  }
  const raced = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`Season pack search exceeded ${timeoutMs} ms`);
      error.code = 'SEASON_PACK_SEARCH_TIMEOUT';
      finish(reject, error);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    actual.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
  raced.actualSettled = actualSettled;
  return raced;
}

function cloneResults(results) {
  if (!Array.isArray(results)) return [];
  return results.map((result) => {
    try {
      return JSON.parse(JSON.stringify(result));
    } catch {
      return { ...result };
    }
  });
}

function prune(now = Date.now()) {
  for (const [key, snapshot] of snapshots) {
    if (snapshot.status === 'pending') continue;
    if (snapshot.expiresAt && snapshot.expiresAt <= now) snapshots.delete(key);
  }
  const limit = maxEntries();
  if (limit <= 0) {
    for (const [key, snapshot] of snapshots) {
      if (snapshot.status !== 'pending') snapshots.delete(key);
    }
    return;
  }
  while (snapshots.size > limit) {
    const removable = Array.from(snapshots.entries())
      .filter(([, snapshot]) => snapshot.status !== 'pending')
      .sort((a, b) => (a[1].lastAccessedAt || a[1].createdAt || 0) - (b[1].lastAccessedAt || b[1].createdAt || 0))[0];
    if (!removable) break;
    snapshots.delete(removable[0]);
  }
}

function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    status: snapshot.status,
    generation: snapshot.generation,
    createdAt: snapshot.createdAt,
    completedAt: snapshot.completedAt || null,
    expiresAt: snapshot.expiresAt || null,
    results: cloneResults(snapshot.results),
    sourceOutcomes: Array.isArray(snapshot.sourceOutcomes)
      ? snapshot.sourceOutcomes.map((outcome) => ({ ...outcome }))
      : [],
    error: snapshot.error || null,
    promise: snapshot.promise || null,
  };
}

function getSnapshot(key) {
  if (!key) return null;
  prune();
  const snapshot = snapshots.get(key);
  if (!snapshot) return null;
  snapshot.lastAccessedAt = Date.now();
  return publicSnapshot(snapshot);
}

function drainQueue() {
  while (activeJobs < maxConcurrent() && pendingJobs.length > 0) {
    const queued = pendingJobs.shift();
    const current = snapshots.get(queued.key);
    if (!current || current.generation !== queued.generation || current.status !== 'pending') {
      queued.resolve(null);
      continue;
    }
    activeJobs += 1;
    const runningJob = runWithTimeout(queued.task);
    runningJob
      .then((outcome) => {
        const live = snapshots.get(queued.key);
        if (!live || live.generation !== queued.generation) return null;
        const now = Date.now();
        const results = cloneResults(outcome?.results);
        const hasResults = results.length > 0;
        const isPartial = Boolean(outcome?.partial) && hasResults;
        const ttlMs = hasResults
          ? (isPartial ? partialTtlMs() : positiveTtlMs())
          : negativeTtlMs();
        const completed = {
          status: hasResults ? (isPartial ? 'ready_partial' : 'ready') : 'negative',
          generation: queued.generation,
          createdAt: live.createdAt,
          completedAt: now,
          expiresAt: ttlMs > 0 ? now + ttlMs : now,
          lastAccessedAt: now,
          results,
          sourceOutcomes: Array.isArray(outcome?.sourceOutcomes) ? outcome.sourceOutcomes.map((item) => ({ ...item })) : [],
          error: null,
          promise: null,
        };
        snapshots.set(queued.key, completed);
        prune(now);
        return publicSnapshot(completed);
      })
      .catch((error) => {
        const live = snapshots.get(queued.key);
        if (!live || live.generation !== queued.generation) return null;
        const now = Date.now();
        const retryMs = errorRetryMs();
        const failed = {
          status: 'transient_error',
          generation: queued.generation,
          createdAt: live.createdAt,
          completedAt: now,
          expiresAt: retryMs > 0 ? now + retryMs : now,
          lastAccessedAt: now,
          results: [],
          sourceOutcomes: Array.isArray(error?.sourceOutcomes)
            ? error.sourceOutcomes.map((item) => ({ ...item }))
            : [],
          error: error?.message || 'Season pack search failed',
          promise: null,
        };
        snapshots.set(queued.key, failed);
        return publicSnapshot(failed);
      })
      .then(queued.resolve, queued.reject)
      .finally(async () => {
        // The logical watchdog may publish a retryable timeout, but the real
        // provider request can still be alive because these clients do not yet
        // expose cancellation. Keep the concurrency slot until it actually
        // settles so timed-out calls cannot pile up behind the scenes.
        await runningJob.actualSettled;
        activeJobs = Math.max(0, activeJobs - 1);
        drainQueue();
      });
  }
}

function getOrStart(key, task) {
  if (!key || typeof task !== 'function') return { snapshot: null, started: false, promise: Promise.resolve(null) };
  const existing = getSnapshot(key);
  if (existing) {
    if (existing.status === 'pending') {
      return { snapshot: existing, started: false, promise: existing.promise };
    }
    return { snapshot: existing, started: false, promise: Promise.resolve(existing) };
  }

  const outstanding = activeJobs + pendingJobs.length;
  const admissionLimit = maxConcurrent() + maxQueued();
  if (outstanding >= admissionLimit) {
    const now = Date.now();
    const overloaded = {
      status: 'overloaded',
      generation: null,
      createdAt: now,
      completedAt: now,
      expiresAt: null,
      results: [],
      sourceOutcomes: [],
      error: 'Season pack search queue is full',
      promise: null,
    };
    return { snapshot: overloaded, started: false, rejected: true, promise: Promise.resolve(overloaded) };
  }

  const createdAt = Date.now();
  generation += 1;
  const jobGeneration = generation;
  let resolveJob;
  let rejectJob;
  const promise = new Promise((resolve, reject) => {
    resolveJob = resolve;
    rejectJob = reject;
  });
  // Prevent an ignored background promise from becoming an unhandled rejection.
  promise.catch(() => undefined);
  const pending = {
    status: 'pending',
    generation: jobGeneration,
    createdAt,
    completedAt: null,
    expiresAt: null,
    lastAccessedAt: createdAt,
    results: [],
    sourceOutcomes: [],
    error: null,
    promise,
  };
  snapshots.set(key, pending);
  pendingJobs.push({ key, generation: jobGeneration, task, resolve: resolveJob, reject: rejectJob });
  drainQueue();
  return { snapshot: publicSnapshot(pending), started: true, promise };
}

async function waitForSnapshot(promise, timeoutMs) {
  if (!promise || typeof promise.then !== 'function') return null;
  const waitMs = Math.max(0, Number(timeoutMs) || 0);
  if (waitMs <= 0) return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(finish, () => finish(null));
  });
}

function clear(reason = 'manual') {
  generation += 1;
  snapshots.clear();
  while (pendingJobs.length > 0) {
    const queued = pendingJobs.shift();
    queued.resolve(null);
  }
  if (reason) console.log('[PACK-CACHE] Cleared season-pack cache', { reason });
}

function getStats() {
  prune();
  const statusCounts = {};
  for (const snapshot of snapshots.values()) {
    statusCounts[snapshot.status] = (statusCounts[snapshot.status] || 0) + 1;
  }
  return {
    entries: snapshots.size,
    activeJobs,
    queuedJobs: pendingJobs.length,
    maxEntries: maxEntries(),
    maxConcurrent: maxConcurrent(),
    maxQueued: maxQueued(),
    jobTimeoutMs: jobTimeoutMs(),
    statusCounts,
  };
}

module.exports = {
  resolveMode,
  mergeSnapshotResults,
  getSnapshot,
  getOrStart,
  waitForSnapshot,
  clear,
  getStats,
};
