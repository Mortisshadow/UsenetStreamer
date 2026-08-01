const crypto = require('crypto');

const POLICY_VERSION = 'exact-payload-health-v1';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

const evidenceCache = new Map();
const evidenceFlights = new Map();

function configuredTtlMs() {
  const minutes = Number(process.env.NZB_HEALTH_EVIDENCE_TTL_MINUTES);
  if (Number.isFinite(minutes) && minutes >= 0) return minutes * 60 * 1000;
  return DEFAULT_TTL_MS;
}

function configuredMaxEntries() {
  const value = Number(process.env.NZB_HEALTH_EVIDENCE_MAX_ENTRIES);
  if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  return DEFAULT_MAX_ENTRIES;
}

function stableSerialize(value, seen = new WeakSet()) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString('base64'));
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`;
  if (typeof value === 'object') {
    if (seen.has(value)) return JSON.stringify('[Circular]');
    seen.add(value);
    const serialized = Object.keys(value)
      .sort()
      .filter((key) => typeof value[key] !== 'undefined' && typeof value[key] !== 'function')
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`)
      .join(',');
    seen.delete(value);
    return `{${serialized}}`;
  }
  return JSON.stringify(String(value));
}

function cloneDecision(decision) {
  return decision ? JSON.parse(JSON.stringify(decision)) : decision;
}

function buildExactEvidenceKey({ nzbPayload, triageConfig, requestedEpisode, isSeasonPack }) {
  if (typeof nzbPayload !== 'string' || nzbPayload.length === 0) return null;
  const payloadHash = crypto.createHash('sha256').update(nzbPayload, 'utf8').digest('hex');
  const policyHash = crypto.createHash('sha256').update(stableSerialize({
    version: POLICY_VERSION,
    triageConfig: triageConfig || {},
    requestedEpisode: requestedEpisode || null,
    isSeasonPack: Boolean(isSeasonPack),
  })).digest('hex');
  return `${POLICY_VERSION}:${payloadHash}:${policyHash}`;
}

function getCachedEvidence(key) {
  if (!key) return null;
  const entry = evidenceCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now) {
    evidenceCache.delete(key);
    return null;
  }
  // Refresh insertion order so the bounded map behaves as an LRU cache.
  evidenceCache.delete(key);
  evidenceCache.set(key, entry);
  return {
    decision: cloneDecision(entry.decision),
    ageMs: Math.max(0, now - entry.createdAt),
  };
}

function storePositiveEvidence(key, decision) {
  const ttlMs = configuredTtlMs();
  const maxEntries = configuredMaxEntries();
  if (!key || ttlMs <= 0 || maxEntries <= 0 || decision?.status !== 'verified') return;
  const now = Date.now();
  const cachedDecision = cloneDecision(decision);
  delete cachedDecision.nzbPayload;
  evidenceCache.delete(key);
  evidenceCache.set(key, {
    decision: cachedDecision,
    createdAt: now,
    expiresAt: now + ttlMs,
  });
  while (evidenceCache.size > maxEntries) {
    const oldestKey = evidenceCache.keys().next().value;
    if (oldestKey === undefined) break;
    evidenceCache.delete(oldestKey);
  }
}

async function runWithExactHealthEvidence(key, task) {
  const cached = getCachedEvidence(key);
  if (cached) {
    return { value: cached.decision, source: 'cache', ageMs: cached.ageMs };
  }

  const existing = key ? evidenceFlights.get(key) : null;
  if (existing) {
    return { value: cloneDecision(await existing), source: 'flight', ageMs: 0 };
  }

  const flight = Promise.resolve().then(task);
  if (key) evidenceFlights.set(key, flight);
  try {
    const value = await flight;
    storePositiveEvidence(key, value);
    return { value: cloneDecision(value), source: 'live', ageMs: 0 };
  } finally {
    if (key && evidenceFlights.get(key) === flight) evidenceFlights.delete(key);
  }
}

function clearHealthEvidenceCache() {
  evidenceCache.clear();
  evidenceFlights.clear();
}

function getHealthEvidenceCacheStats() {
  return {
    entries: evidenceCache.size,
    inFlight: evidenceFlights.size,
    ttlMs: configuredTtlMs(),
    maxEntries: configuredMaxEntries(),
    policyVersion: POLICY_VERSION,
  };
}

module.exports = {
  buildExactEvidenceKey,
  runWithExactHealthEvidence,
  clearHealthEvidenceCache,
  getHealthEvidenceCacheStats,
};
