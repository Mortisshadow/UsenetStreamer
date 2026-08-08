// Disk-backed NZB payload cache
// Stores verified NZB payloads on disk so they survive container restarts.
// Only a tiny index (url -> metadata) is kept in RAM; payloads live on disk
// and are read on demand. Eviction is size-budget-first (LRU), with a 30-day
// TTL backstop — i.e. payloads are kept as long as possible and only removed
// when the on-disk budget is exceeded (least-recently-used go first).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CACHE_DIR = path.join(process.cwd(), 'cache', 'nzb_payloads');
const INDEX_FILE = 'index.json';

let cacheDir = (process.env.NZB_CACHE_DIR || '').trim() || DEFAULT_CACHE_DIR;
let indexPath = path.join(cacheDir, INDEX_FILE);

// In-memory index: url → { hash, title, sizeBytes, fileName, bytes, createdAt, lastAccessedAt, expiresAt }
// `bytes` = actual on-disk .nzb size (for the budget); `sizeBytes` = media size metadata.
let index = new Map();
let initialized = false;
const pendingPayloads = new Map();
let indexSaveTimer = null;
let maintenanceTimer = null;
let indexWriteChain = Promise.resolve();
let cacheGeneration = 0;
let indexRevision = 0;
let pendingWriteSequence = 0;

// 30-day TTL backstop (the size budget below is the primary control).
const CACHE_TTL_MS = (() => {
  const raw = Number(process.env.VERIFIED_NZB_CACHE_TTL_MINUTES);
  if (Number.isFinite(raw) && raw >= 0) return raw * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000; // 30 days
})();

// Primary control: total on-disk payload budget. Default 1.5 GB. 0 = unlimited.
const MAX_BYTES = (() => {
  const raw = Number(process.env.NZB_CACHE_MAX_SIZE_GB);
  if (Number.isFinite(raw) && raw >= 0) return Math.round(raw * 1024 * 1024 * 1024);
  return Math.round(1.5 * 1024 * 1024 * 1024); // 1.5 GB
})();

// Safety cap on index size (the byte budget is the real limiter). 0 = unlimited.
const MAX_ENTRIES = (() => {
  const raw = Number(process.env.NZB_CACHE_MAX_ENTRIES);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 5000;
})();

// --- Helpers ---

function urlHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
}

function payloadPath(hash) {
  return path.join(cacheDir, `${hash}.nzb`);
}

function ensureDir() {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

function entryLastUse(entry) {
  return entry.lastAccessedAt || entry.createdAt || 0;
}

function totalBytes() {
  let total = 0;
  for (const entry of index.values()) total += entry.bytes || 0;
  return total;
}

// --- Init / Load ---

function loadIndex() {
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) {
      index = new Map();
      const now = Date.now();
      let migratedCredentialUrls = false;
      for (const entry of entries) {
        if (entry.expiresAt && entry.expiresAt <= now) continue;
        // Legacy indexes contained the complete credential-bearing download
        // URL. Migrate in memory to the existing SHA-256 payload key and never
        // persist the URL again.
        const hash = entry.hash || (entry.url ? urlHash(entry.url) : null);
        if (!hash) continue;
        const { url: _legacyUrl, ...safeEntry } = entry;
        if (_legacyUrl) migratedCredentialUrls = true;
        index.set(hash, { ...safeEntry, hash });
      }
      if (migratedCredentialUrls) saveIndex();
    }
  } catch {
    index = new Map();
  }
}

function saveIndex() {
  let tempPath = null;
  try {
    ensureDir();
    const entries = Array.from(index.values());
    tempPath = `${indexPath}.${process.pid}.${++pendingWriteSequence}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(tempPath, indexPath);
  } catch (err) {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
    console.warn('[DISK-CACHE] Failed to save index:', err.message);
  }
}

function saveIndexAsync() {
  ensureDir();
  const snapshot = JSON.stringify(Array.from(index.values()));
  const writeIndexPath = indexPath;
  const tempPath = `${writeIndexPath}.${process.pid}.${++pendingWriteSequence}.tmp`;
  const writeGeneration = cacheGeneration;
  const writeRevision = indexRevision;
  indexWriteChain = indexWriteChain
    .catch(() => undefined)
    .then(async () => {
      if (writeGeneration !== cacheGeneration || writeRevision !== indexRevision) return;
      await fs.promises.writeFile(tempPath, snapshot, 'utf8');
      if (writeGeneration !== cacheGeneration || writeRevision !== indexRevision) {
        try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
        return;
      }
      // The synchronous rename makes the last ownership check + publication
      // indivisible with respect to clearDiskCache()/reloadConfig() in this
      // process. A clear cannot interleave after the check and resurrect an
      // old index snapshot.
      fs.renameSync(tempPath, writeIndexPath);
    })
    .catch(async (err) => {
      try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
      console.warn('[DISK-CACHE] Failed to save index asynchronously:', err.message);
    });
  return indexWriteChain;
}

function scheduleIndexSave(delayMs = 250) {
  if (indexSaveTimer) clearTimeout(indexSaveTimer);
  indexSaveTimer = setTimeout(() => {
    indexSaveTimer = null;
    saveIndexAsync();
  }, delayMs);
  if (typeof indexSaveTimer.unref === 'function') indexSaveTimer.unref();
}

function scheduleMaintenance() {
  if (maintenanceTimer) return;
  maintenanceTimer = setTimeout(() => {
    maintenanceTimer = null;
    cleanup({ deferredSave: true });
  }, 1000);
  if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();
}

// Reconcile the index against what is actually on disk:
//  - drop index entries whose .nzb file is gone, and backfill missing byte sizes;
//  - delete orphaned .nzb files that nothing in the index references (the only
//    code path that ever reclaims leaked payloads).
function reconcile() {
  let changed = false;
  for (const [url, entry] of index) {
    const p = payloadPath(entry.hash);
    try {
      const stat = fs.statSync(p);
      if (!entry.bytes) { entry.bytes = stat.size; changed = true; }
    } catch {
      index.delete(url);
      changed = true;
    }
  }

  let files = [];
  try { files = fs.readdirSync(cacheDir); } catch { return changed; }
  const referenced = new Set(Array.from(index.values()).map((e) => `${e.hash}.nzb`));
  let removed = 0;
  let removedBytes = 0;
  for (const file of files) {
    const isOrphanedPayload = file.endsWith('.nzb') && !referenced.has(file);
    // Atomic writers use cache-local .tmp files. None can legitimately survive
    // process startup/reconciliation; reclaim crash leftovers as well.
    const isStaleTemp = file.endsWith('.tmp');
    if (!isOrphanedPayload && !isStaleTemp) continue;
    try {
      const p = path.join(cacheDir, file);
      removedBytes += fs.statSync(p).size;
      fs.unlinkSync(p);
      removed += 1;
    } catch { /* ignore */ }
  }
  if (removed > 0) {
    console.log(`[DISK-CACHE] Reclaimed ${removed} orphaned payload(s) (${(removedBytes / 1024 / 1024).toFixed(1)} MB)`);
  }
  if (changed) indexRevision += 1;
  return changed;
}

function init() {
  if (initialized) return;
  ensureDir();
  loadIndex();
  reconcile();
  cleanup();
  initialized = true;
}

// --- Cleanup / eviction ---

function evictLeastRecentlyUsed(shouldContinue) {
  const lru = Array.from(index.entries()).sort((a, b) => entryLastUse(a[1]) - entryLastUse(b[1]));
  let changed = false;
  while (lru.length && shouldContinue()) {
    const [url, entry] = lru.shift();
    tryDeleteFile(entry.hash);
    index.delete(url);
    changed = true;
  }
  return changed;
}

function cleanup({ deferredSave = false } = {}) {
  const now = Date.now();
  let changed = false;

  // 1. TTL backstop — purge anything past its 30-day window.
  for (const [url, entry] of index) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      tryDeleteFile(entry.hash);
      index.delete(url);
      changed = true;
    }
  }

  // 2. Size budget (primary control) — evict LRU until under MAX_BYTES.
  if (MAX_BYTES > 0 && totalBytes() > MAX_BYTES) {
    let remaining = totalBytes();
    const lru = Array.from(index.entries()).sort((a, b) => entryLastUse(a[1]) - entryLastUse(b[1]));
    while (remaining > MAX_BYTES && lru.length) {
      const [url, entry] = lru.shift();
      tryDeleteFile(entry.hash);
      index.delete(url);
      remaining -= entry.bytes || 0;
      changed = true;
    }
  }

  // 3. Count safety cap — evict LRU if the index grows unexpectedly large.
  if (MAX_ENTRIES > 0 && index.size > MAX_ENTRIES) {
    changed = evictLeastRecentlyUsed(() => index.size > MAX_ENTRIES) || changed;
  }

  if (changed) {
    indexRevision += 1;
    if (deferredSave) scheduleIndexSave();
    else saveIndex();
  }
}

function tryDeleteFile(hash) {
  try {
    const p = payloadPath(hash);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

// --- Public API ---

function cacheToDisk(downloadUrl, nzbPayload, metadata = {}) {
  if (!downloadUrl || typeof nzbPayload !== 'string' || nzbPayload.length === 0) return;
  init();
  const hash = urlHash(downloadUrl);
  const now = Date.now();
  const expiresAt = CACHE_TTL_MS > 0 ? now + CACHE_TTL_MS : null;
  const payloadBuffer = Buffer.from(nzbPayload, 'utf8');
  const entry = {
    hash,
    title: metadata.title || null,
    sizeBytes: metadata.size || null,
    fileName: metadata.fileName || null,
    bytes: payloadBuffer.length,
    createdAt: now,
    lastAccessedAt: now,
    expiresAt,
  };
  // Make the payload immediately reusable by NZBDav/auto-advance while the
  // actual disk write proceeds outside the request's critical path.
  const writeGeneration = cacheGeneration;
  const writeCacheDir = cacheDir;
  const targetPath = path.join(writeCacheDir, `${hash}.nzb`);
  pendingWriteSequence += 1;
  const tempPath = `${targetPath}.${process.pid}.${now}.${pendingWriteSequence}.tmp`;
  const ownership = { generation: writeGeneration, sequence: pendingWriteSequence };
  const pendingEntry = { payloadBuffer, entry, ownership };
  pendingPayloads.set(hash, pendingEntry);
  const writePromise = (async () => {
    try {
      await fs.promises.mkdir(writeCacheDir, { recursive: true });
      await fs.promises.writeFile(tempPath, payloadBuffer);
      // A newer writer for this URL, a clear, or a directory reload revokes
      // ownership. Never let the stale writer replace its payload.
      if (writeGeneration !== cacheGeneration || pendingPayloads.get(hash) !== pendingEntry) {
        try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
        return;
      }
      // Keep ownership validation and publication atomic relative to the
      // synchronous cache lifecycle methods in this process.
      fs.renameSync(tempPath, targetPath);
      index.set(hash, entry);
      indexRevision += 1;
      scheduleIndexSave();
      scheduleMaintenance();
    } catch (err) {
      try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
      console.warn('[DISK-CACHE] Failed to write NZB payload:', err.message);
    } finally {
      if (pendingPayloads.get(hash) === pendingEntry) pendingPayloads.delete(hash);
    }
  })();
  return writePromise;
}

function getFromDisk(downloadUrl) {
  if (!downloadUrl) return null;
  init();
  const hash = urlHash(downloadUrl);
  const pending = pendingPayloads.get(hash);
  if (pending) {
    return {
      downloadUrl,
      payloadBuffer: pending.payloadBuffer,
      size: pending.payloadBuffer.length,
      metadata: {
        title: pending.entry.title || null,
        sizeBytes: pending.entry.sizeBytes || null,
        fileName: pending.entry.fileName || null,
      },
      createdAt: pending.entry.createdAt,
    };
  }
  const entry = index.get(hash);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    tryDeleteFile(entry.hash);
    index.delete(hash);
    indexRevision += 1;
    return null;
  }
  try {
    const p = payloadPath(entry.hash);
    if (!fs.existsSync(p)) {
      index.delete(hash);
      indexRevision += 1;
      return null;
    }
    const payload = fs.readFileSync(p, 'utf8');
    const payloadBuffer = Buffer.from(payload, 'utf8');
    // Bump LRU recency in memory only (persisted lazily by cleanup/cacheToDisk)
    // so reads stay disk-read-only and don't rewrite the index every hit.
    entry.lastAccessedAt = Date.now();
    return {
      downloadUrl,
      payloadBuffer,
      size: payloadBuffer.length,
      metadata: {
        title: entry.title || null,
        sizeBytes: entry.sizeBytes || null,
        fileName: entry.fileName || null,
      },
      createdAt: entry.createdAt,
    };
  } catch (err) {
    console.warn('[DISK-CACHE] Failed to read NZB payload:', err.message);
    return null;
  }
}

function hasCachedPayload(downloadUrl) {
  if (!downloadUrl) return false;
  init();
  const hash = urlHash(downloadUrl);
  if (pendingPayloads.has(hash)) return true;
  const entry = index.get(hash);
  if (!entry) return false;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) return false;
  return fs.existsSync(payloadPath(entry.hash));
}

function clearDiskCache(reason = 'manual') {
  init();
  const count = index.size + pendingPayloads.size;
  cacheGeneration += 1;
  if (indexSaveTimer) clearTimeout(indexSaveTimer);
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  indexSaveTimer = null;
  maintenanceTimer = null;
  pendingPayloads.clear();
  for (const entry of index.values()) {
    tryDeleteFile(entry.hash);
  }
  index.clear();
  indexRevision += 1;
  saveIndex();
  // Also sweep any stray files so a clear truly empties the directory.
  reconcile();
  if (count > 0) {
    console.log('[DISK-CACHE] Cleared', { reason, entries: count });
  }
}

// Periodic maintenance hook for the central janitor — enforces TTL + budget
// between writes (and persists any lazily-updated LRU recency).
function runMaintenance() {
  init();
  cleanup({ deferredSave: true });
}

function getDiskCacheStats() {
  init();
  return {
    entries: index.size,
    cacheDir,
    maxEntries: MAX_ENTRIES,
    ttlMs: CACHE_TTL_MS,
    totalBytes: totalBytes(),
    maxBytes: MAX_BYTES,
  };
}

function reloadConfig() {
  const newDir = (process.env.NZB_CACHE_DIR || '').trim() || DEFAULT_CACHE_DIR;
  if (newDir !== cacheDir) {
    cacheGeneration += 1;
    if (indexSaveTimer) clearTimeout(indexSaveTimer);
    if (maintenanceTimer) clearTimeout(maintenanceTimer);
    indexSaveTimer = null;
    maintenanceTimer = null;
    pendingPayloads.clear();
    index = new Map();
    indexRevision += 1;
    cacheDir = newDir;
    indexPath = path.join(cacheDir, INDEX_FILE);
    initialized = false;
  }
}

module.exports = {
  cacheToDisk,
  getFromDisk,
  hasCachedPayload,
  clearDiskCache,
  runMaintenance,
  getDiskCacheStats,
  reloadConfig,
};
