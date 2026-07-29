// Authentication middleware for shared secret / stream token validation
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Rate-limiter: true sliding-window per IP (admin routes only)
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_RATE_LIMIT_MAX = 180;     // max admin requests per window
const rateLimitBuckets = new Map();     // ip → number[] (timestamps)

// Admin rate-limit cap, overridable via the RATE_LIMIT_MAX env var. Read at
// call time so deployments behind a reverse proxy (where many admin sessions
// share one source IP) can raise it without touching code. Invalid/unset →
// default. (This is the admin-route limit only; stream routes are not limited.)
function getRateLimitMax() {
  const n = Number.parseInt(String(process.env.RATE_LIMIT_MAX || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RATE_LIMIT_MAX;
}

// ---------------------------------------------------------------------------
// Failed-login lockout: block IP after repeated auth failures
// ---------------------------------------------------------------------------
const LOCKOUT_THRESHOLD = 10;           // failures before lockout
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15-minute lockout
const failedAttempts = new Map();       // ip → { count, lockedUntil }

function pruneRateLimitBuckets() {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of rateLimitBuckets) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
      rateLimitBuckets.delete(ip);
    }
  }
  for (const [ip, entry] of failedAttempts) {
    if (now > entry.lockedUntil && now - entry.lastAttempt > LOCKOUT_DURATION_MS) {
      failedAttempts.delete(ip);
    }
  }
}
// Periodic cleanup every 5 minutes
setInterval(pruneRateLimitBuckets, 5 * 60 * 1000).unref();

function rateLimitCheck(req) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let timestamps = rateLimitBuckets.get(ip);
  if (!timestamps) {
    timestamps = [];
    rateLimitBuckets.set(ip, timestamps);
  }
  // Evict timestamps outside the sliding window
  let start = 0;
  while (start < timestamps.length && timestamps[start] < cutoff) start++;
  if (start > 0) timestamps.splice(0, start);
  if (timestamps.length >= getRateLimitMax()) return false;
  timestamps.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------
function extractTokenFromRequest(req) {
  const pathMatch = (req.path || '').match(/^\/([^\/]+)\/(manifest\.json|stream|catalog|meta|nzb|easynews)(?:\b|\/)/i);
  if (pathMatch && pathMatch[1]) {
    return pathMatch[1].trim();
  }
  if (req.params && typeof req.params.token === 'string') {
    return req.params.token.trim();
  }
  const authHeader = req.headers['x-addon-token'] || req.headers['authorization'];
  if (typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && /^token$/i.test(parts[0])) {
      return parts[1].trim();
    }
    return authHeader.trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Timing-safe string comparison
// ---------------------------------------------------------------------------
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 && b.length === 0) return true;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Prevent length-based timing leak: compare with self so runtime is constant
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Resolve effective stream token (ADDON_STREAM_TOKEN ?? ADDON_SHARED_SECRET)
// ---------------------------------------------------------------------------
function getEffectiveStreamToken() {
  return (process.env.ADDON_STREAM_TOKEN || '').trim();
}

// ---------------------------------------------------------------------------
// Lockout helpers
// ---------------------------------------------------------------------------
function isLockedOut(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (entry.count >= LOCKOUT_THRESHOLD && Date.now() < entry.lockedUntil) return true;
  // Lockout expired — reset
  if (Date.now() >= entry.lockedUntil) {
    failedAttempts.delete(ip);
  }
  return false;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: 0, lastAttempt: 0 };
  entry.count += 1;
  entry.lastAttempt = now;
  if (entry.count >= LOCKOUT_THRESHOLD) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
  }
  failedAttempts.set(ip, entry);
}

function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

// ---------------------------------------------------------------------------
// Middleware: protect admin API routes (checks ADDON_SHARED_SECRET only)
// Explicitly rejects the stream token if it differs from the admin secret.
// ---------------------------------------------------------------------------
function ensureAdminSecret(req, res, next) {
  const secret = (process.env.ADDON_SHARED_SECRET || '').trim();

  // ADDON_SHARED_SECRET is mandatory since v1.7.6
  if (!secret) {
    res.status(503).json({ error: 'ADDON_SHARED_SECRET is not configured. Set it in your Docker/environment config and restart.' });
    return;
  }
  if (req.method === 'OPTIONS') { next(); return; }

  const ip = req.ip || req.connection?.remoteAddress || 'unknown';

  if (isLockedOut(ip)) {
    res.status(429).json({ error: 'Too many failed attempts — try again in 15 minutes' });
    return;
  }

  if (!rateLimitCheck(req)) {
    res.status(429).json({ error: 'Too many requests — try again later' });
    return;
  }

  // CSRF: reject mutating requests with a mismatched Origin header
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.headers['origin'];
    if (origin) {
      const addonBase = (process.env.ADDON_BASE_URL || '').trim();
      const allowed = addonBase ? [addonBase] : [];
      // Also allow requests from the same host:port
      const host = req.headers['host'];
      if (host) {
        allowed.push(`http://${host}`, `https://${host}`);
      }
      const originMatch = allowed.some((a) => origin === a || origin === a.replace(/\/+$/, ''));
      if (!originMatch) {
        res.status(403).json({ error: 'Forbidden: cross-origin request rejected' });
        return;
      }
    }
  }

  const provided = extractTokenFromRequest(req);

  // Explicitly reject if the caller supplied the stream token instead of the admin secret
  const streamToken = getEffectiveStreamToken();
  if (provided && streamToken && !safeEqual(streamToken, secret) && safeEqual(provided, streamToken)) {
    recordFailedAttempt(ip);
    res.status(403).json({ error: 'Forbidden: stream tokens cannot access the admin panel' });
    return;
  }

  if (!provided || !safeEqual(provided, secret)) {
    recordFailedAttempt(ip);
    res.status(401).json({ error: 'Unauthorized: invalid or missing admin token' });
    return;
  }
  clearFailedAttempts(ip);
  next();
}

// ---------------------------------------------------------------------------
// Middleware: protect stream / manifest routes (checks stream token)
// ---------------------------------------------------------------------------
function ensureStreamToken(req, res, next) {
  const token = getEffectiveStreamToken();

  // No stream token configured — allow through
  if (!token) { next(); return; }
  if (req.method === 'OPTIONS') { next(); return; }

  const provided = extractTokenFromRequest(req);
  if (!provided || !safeEqual(provided, token)) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing stream token' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Legacy alias — routes that haven't been split yet fall back to admin check
// ---------------------------------------------------------------------------
function ensureSharedSecret(req, res, next) {
  return ensureAdminSecret(req, res, next);
}

module.exports = {
  extractTokenFromRequest,
  ensureSharedSecret,
  ensureAdminSecret,
  ensureStreamToken,
  getEffectiveStreamToken,
};
