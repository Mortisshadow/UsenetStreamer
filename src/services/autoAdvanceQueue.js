// Auto-Advance Queue Service
// Manages a per-content queue of NZB candidates for NZBDav.
//
// Sessions always start idle — nothing queued to NZBDav at creation time.
// Activation happens when:
//   - User clicks a stream → waitForReady() activates
//   - A URL is marked failed → markFailed() activates
//   - External trigger → activate() (e.g. pre-cache success with faster failover)
//
// backupCount controls how many NZBDav slots are kept ready:
//   backupCount === 0 ("slower failover"): queue 1 at a time
//   backupCount >= 1 ("faster failover"): keep 1 + N ready in NZBDav
//
// Usage:
//   const session = autoAdvanceQueue.createSession(contentKey, candidates, options);
//   const readySlot = await session.waitForReady(timeoutMs);
//   // On failure:
//   session.markFailed(readySlot.downloadUrl);
//   const nextSlot = await session.waitForReady(timeoutMs);

const EventEmitter = require('events');
const { redactSensitiveString } = require('../utils/logSanitizer');

const POLL_INTERVAL_MS = 200;
const DEFAULT_READY_TIMEOUT_MS = 240000;
// Failover sessions are kept as long as the streams they point at stay valid.
// Default 30 days (env AUTO_ADVANCE_SESSION_TTL_MINUTES); aligned with the
// stream/NZBDav/disk caches so a session never outlives its backing data.
const SESSION_TTL_MS = (() => {
  const raw = Number(process.env.AUTO_ADVANCE_SESSION_TTL_MINUTES);
  if (Number.isFinite(raw) && raw > 0) return raw * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000; // 30 days
})();
// Hard cap on concurrent sessions so the in-memory map can't grow unbounded
// between prunes (each session is small, but there was previously no limit).
const MAX_SESSIONS = (() => {
  const raw = Number(process.env.AUTO_ADVANCE_MAX_SESSIONS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 500;
})();
const DEFAULT_MAX_ATTEMPTS = 12;

// Active sessions keyed by contentKey (e.g., "movie:tt1234567" or "series:tt1234567:1:1")
const activeSessions = new Map();

// --- Session class ---

class AutoAdvanceSession extends EventEmitter {
  /**
   * @param {string} contentKey - Unique key for this content request
   * @param {Array} candidates - Ordered list of NZB candidates: [{ downloadUrl, title, category, size, triageStatus }]
   * @param {object} options
   * @param {function} options.queueToNzbdav - async (candidate) => { nzoId, jobName, category, viewPath, size, fileName }
   * @param {function} options.getCachedEntry - (downloadUrl) => cachedEntry | null
   * @param {number} options.backupCount - How many backups to keep ready (default: 1)
   */
  constructor(contentKey, candidates, options = {}) {
    super();
    // Stremio sends many concurrent range requests, each calling waitForReady()
    // which adds a slot-ready listener — raise limit to avoid false warnings
    this.setMaxListeners(30);
    this.contentKey = contentKey;
    this.candidates = candidates.slice(); // defensive copy
    this.queueToNzbdav = options.queueToNzbdav;
    this.getCachedEntry = options.getCachedEntry || (() => null);
    this.backupCount = options.backupCount ?? 0;
    this.maxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, Math.floor(options.maxAttempts)) : DEFAULT_MAX_ATTEMPTS;
    this.requestedEpisode = options.requestedEpisode || null;

    // State
    this.cursor = 0;              // Next candidate index to process
    this.slots = new Map();       // downloadUrl → { status, data, error }
    this.readyQueue = [];         // Ordered list of downloadUrls that are ready (queued to NZBDav)
    this.failedUrls = new Set();  // URLs that have been marked failed
    this.processing = new Set();  // URLs currently being queued to NZBDav
    this.closed = false;
    this.createdAt = Date.now();
    this.activated = false;       // nothing queued until activated
    this.attemptedCount = 0;      // how many candidates have been queued for NZBDav processing
    this.activeWaiters = 0;       // in-flight waitForReady() calls — never evict while > 0
  }

  get activeCount() {
    return this.readyQueue.filter((url) => !this.failedUrls.has(url)).length;
  }

  /**
   * Wait for the next ready NZB slot. Returns the first non-failed ready slot.
   * Resolves with { downloadUrl, nzoId, jobName, category, viewPath, size, fileName }
   * Rejects if timeout reached or all candidates exhausted.
   */
  async waitForReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
    // Mark in-use so the session-cap janitor won't evict this session out from
    // under an active stream. Decremented in finally on every exit path.
    this.activeWaiters += 1;
    try {
      // Activate on first user interaction
      if (!this.activated) {
        this.activated = true;
        this._fillPipeline();
      }

      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline && !this.closed) {
        const slot = this._getFirstReadySlot();
        if (slot) return slot;

        // Check if all candidates are exhausted
        if (this._allExhausted()) {
          throw new Error('All NZB candidates exhausted — no more auto-advance options available');
        }

        await new Promise((resolve) => {
          const timer = setTimeout(resolve, POLL_INTERVAL_MS);
          const onReady = () => { clearTimeout(timer); resolve(); };
          this.once('slot-ready', onReady);
          // Also resolve on timeout to re-check
          setTimeout(() => { this.removeListener('slot-ready', onReady); }, POLL_INTERVAL_MS);
        });
      }

      if (this.closed) {
        throw new Error('Auto-Advance session closed');
      }
      throw new Error('Timed out waiting for a ready NZB');
    } finally {
      this.activeWaiters -= 1;
    }
  }

  /**
   * Mark a URL as failed. Triggers pipeline to fill the next backup.
   * @param {string} downloadUrl
   * @param {object} [options]
   * @param {boolean} [options.activate=true] - Whether to activate the session and fill pipeline.
   *   Set to false for background failures (e.g. prefetch timeout) where no user
   *   has clicked — avoids cascading through candidates when nobody is watching.
   */
  markFailed(downloadUrl, { activate = true } = {}) {
    this.failedUrls.add(downloadUrl);
    const slot = this.slots.get(downloadUrl);
    if (slot) slot.status = 'failed';
    this.processing.delete(downloadUrl);
    console.log(`[AUTO-ADVANCE] Marked as failed: ${redactSensitiveString(downloadUrl)}`);

    if (activate) {
      // Activate on failure (user clicked, NZB failed, need next)
      if (!this.activated) {
        this.activated = true;
      }
      this._fillPipeline();
    }
  }

  /**
   * Dynamically add a new verified candidate to the queue.
   * Triggers pipeline fill if we need more ready slots.
   */
  addCandidate(candidate) {
    if (this.closed) return;
    // Avoid duplicates
    if (this.candidates.some((c) => c.downloadUrl === candidate.downloadUrl)) return;
    this.candidates.push(candidate);
    console.log(`[AUTO-ADVANCE] Added verified candidate: ${redactSensitiveString(candidate.title || candidate.downloadUrl)}`);
    if (this.activated) this._fillPipeline();
  }

  /**
   * Externally activate the session (e.g. after pre-cache success).
   * Starts filling the pipeline with 1 + backupCount slots.
   */
  activate() {
    if (this.activated || this.closed) return;
    this.activated = true;
    console.log(`[AUTO-ADVANCE] Session activated externally for ${this.contentKey}`);
    this._fillPipeline();
  }

  /**
   * Move a candidate to the front of the queue (position 0 or cursor position).
   * Used by top-ranked smart play mode to ensure the best-ranked NZB is processed first.
   */
  prioritizeCandidate(downloadUrl) {
    const idx = this.candidates.findIndex((c) => c.downloadUrl === downloadUrl);
    if (idx <= this.cursor) return; // already processed or at front
    const [candidate] = this.candidates.splice(idx, 1);
    this.candidates.splice(this.cursor, 0, candidate);
  }

  /**
   * Mark a URL as being processed externally (e.g. prefetch queued to NZBDav).
   * The pipeline will skip this URL but waitForReady won't return it yet.
   */
  markExternallyProcessing(downloadUrl) {
    const existing = this.slots.get(downloadUrl);
    if (existing && existing.status !== 'processing') return; // already in final state
    this.slots.set(downloadUrl, { status: 'processing', data: { downloadUrl, external: true } });
    this.processing.add(downloadUrl);
    // Advance cursor past this candidate if it's next
    while (this.cursor < this.candidates.length && this.candidates[this.cursor].downloadUrl === downloadUrl) {
      this.cursor++;
    }
  }

  /**
   * Mark a URL as already handled externally (e.g. by pre-cache).
   * The pipeline will skip this URL and count it as an active slot.
   */
  markExternallyReady(downloadUrl) {
    const existing = this.slots.get(downloadUrl);
    if (existing && existing.status === 'ready') return; // already ready
    this.processing.delete(downloadUrl);
    this.slots.set(downloadUrl, { status: 'ready', data: { downloadUrl, external: true } });
    if (!this.readyQueue.includes(downloadUrl)) {
      this.readyQueue.push(downloadUrl);
    }
    // Advance cursor past this candidate if it's next
    while (this.cursor < this.candidates.length && this.candidates[this.cursor].downloadUrl === downloadUrl) {
      this.cursor++;
    }
  }

  /**
   * Get the triage status of a candidate by download URL.
   * Returns 'blocked', 'verified', 'not-run', etc. or null if not found.
   */
  getTriageStatus(downloadUrl) {
    const candidate = this.candidates.find((c) => c.downloadUrl === downloadUrl);
    return candidate?.triageStatus || null;
  }

  /**
   * Close this session and clean up.
   */
  close() {
    this.closed = true;
    this.removeAllListeners();
  }

  /**
   * Non-blocking peek: returns the first ready slot data or null.
   * Does NOT activate the pipeline or wait.
   */
  peekReady() {
    return this._getFirstReadySlot();
  }

  // --- Internal ---

  _getFirstReadySlot() {
    for (const url of this.readyQueue) {
      if (this.failedUrls.has(url)) continue;
      const slot = this.slots.get(url);
      if (slot && slot.status === 'ready') return slot.data;
    }
    return null;
  }

  _allExhausted() {
    if (this.attemptedCount >= this.maxAttempts && this.processing.size === 0) {
      // Reached processing cap and nothing in flight.
      for (const url of this.readyQueue) {
        if (!this.failedUrls.has(url)) return false;
      }
      return true;
    }
    if (this.cursor < this.candidates.length) return false;
    if (this.processing.size > 0) return false;
    // All queued, none processing — check if any non-failed ready slots remain
    for (const url of this.readyQueue) {
      if (!this.failedUrls.has(url)) return false;
    }
    return true;
  }

  _fillPipeline() {
    if (this.closed || !this.activated) return;

    // Keep 1 + backupCount slots ready in NZBDav
    const targetReady = 1 + this.backupCount;
    const currentActive = this.activeCount;
    const inFlight = this.processing.size;
    const needed = targetReady - currentActive - inFlight;

    for (let i = 0; i < needed; i++) {
      this._queueNext();
    }
  }

  _queueNext() {
    if (this.closed) return;
    if (this.attemptedCount >= this.maxAttempts) return;
    if (this.cursor >= this.candidates.length) return;

    const candidate = this.candidates[this.cursor];
    this.cursor++;

    // Skip already processed or failed URLs
    if (this.slots.has(candidate.downloadUrl) || this.failedUrls.has(candidate.downloadUrl)) {
      this._queueNext(); // try next
      return;
    }

    this.processing.add(candidate.downloadUrl);
    this.slots.set(candidate.downloadUrl, { status: 'processing' });
    this.attemptedCount += 1;

    this._processCandidate(candidate).then((data) => {
      this.processing.delete(candidate.downloadUrl);
      if (this.closed) return;
      this.slots.set(candidate.downloadUrl, { status: 'ready', data });
      this.readyQueue.push(candidate.downloadUrl);
      console.log(`[AUTO-ADVANCE] Slot ready: ${redactSensitiveString(candidate.title || candidate.downloadUrl)}`);
      this.emit('slot-ready', data);
      this._fillPipeline();
    }).catch((err) => {
      this.processing.delete(candidate.downloadUrl);
      if (this.closed) return;
      this.slots.set(candidate.downloadUrl, { status: 'error', error: err });
      this.failedUrls.add(candidate.downloadUrl);
      console.warn(`[AUTO-ADVANCE] Queue failed for ${redactSensitiveString(candidate.title || candidate.downloadUrl)}: ${redactSensitiveString(err.message)}`);
      // Only keep trying to fill backup slots if no ready slot exists yet.
      // Once the primary is ready, stop cascading through failures for backup.
      if (this.activeCount === 0) {
        this._fillPipeline();
      }
    });
  }

  async _processCandidate(candidate) {
    if (!this.queueToNzbdav) {
      throw new Error('No queueToNzbdav handler configured');
    }
    const result = await this.queueToNzbdav(candidate);
    return {
      downloadUrl: candidate.downloadUrl,
      title: candidate.title,
      ...result,
    };
  }
}

// --- Session Management ---

function createSession(contentKey, candidates, options = {}) {
  // Close any existing session for this key
  const existing = activeSessions.get(contentKey);
  if (existing) {
    existing.close();
  }
  const session = new AutoAdvanceSession(contentKey, candidates, options);
  activeSessions.set(contentKey, session);
  // TTL + cap are enforced by the server's periodic janitor (pruneExpiredSessions),
  // not on the hot create path — and never against a session that is in use.
  return session;
}

function getSession(contentKey) {
  const session = activeSessions.get(contentKey);
  if (!session) return null;
  const expired = Date.now() - session.createdAt > SESSION_TTL_MS;
  // Match the janitor's safety rule: never close a session while a stream is
  // actively waiting on it, even if a concurrent lookup observes TTL expiry.
  if (session.closed || (expired && session.activeWaiters === 0)) {
    session.close();
    activeSessions.delete(contentKey);
    return null;
  }
  return session;
}

function closeSession(contentKey) {
  const session = activeSessions.get(contentKey);
  if (session) {
    session.close();
    activeSessions.delete(contentKey);
  }
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [key, session] of activeSessions) {
    if (session.closed) {
      activeSessions.delete(key);
    } else if ((now - session.createdAt > SESSION_TTL_MS) && session.activeWaiters === 0) {
      session.close();
      activeSessions.delete(key);
    }
  }
  // Enforce the concurrent-session cap — close oldest (by createdAt) first, but
  // NEVER a session with an in-flight waitForReady() (that would 502 an active
  // stream). Sessions in use are skipped and reclaimed on a later pass.
  if (MAX_SESSIONS > 0 && activeSessions.size > MAX_SESSIONS) {
    const oldest = Array.from(activeSessions.entries())
      .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
    let overBy = activeSessions.size - MAX_SESSIONS;
    for (const [key, session] of oldest) {
      if (overBy <= 0) break;
      if (session.activeWaiters > 0) continue; // in use — don't evict
      session.close();
      activeSessions.delete(key);
      overBy -= 1;
    }
  }
}

function getActiveSessionCount() {
  pruneExpiredSessions();
  return activeSessions.size;
}

function closeAllSessions(reason = 'manual') {
  if (activeSessions.size > 0) {
    console.log(`[AUTO-ADVANCE] Closing all ${activeSessions.size} sessions (${reason})`);
  }
  for (const [key, session] of activeSessions) {
    session.close();
  }
  activeSessions.clear();
}

module.exports = {
  createSession,
  getSession,
  closeSession,
  closeAllSessions,
  pruneExpiredSessions,
  getActiveSessionCount,
  AutoAdvanceSession,
};
