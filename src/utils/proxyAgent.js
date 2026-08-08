// Indexer proxy agent factory.
//
// Builds HTTP/HTTPS/SOCKS proxy agents for routing INDEXER-bound outbound
// traffic through a user-configured proxy — typically Gluetun's HTTP proxy
// (:8888) or its Shadowsocks SOCKS5 proxy (:8388) — so the addon host's IP is
// hidden from indexers. In scope: Direct Newznab search/caps/test + the .nzb
// download, and the indexer-manager's own search/test. NOT in scope: the Usenet
// provider, NNTP triage, NZBDav, TMDb, EasyNews (those never call this).
//
// This is the ONLY place a proxy URL is parsed into agents.
//
// Design rules (locked with the user):
//  - FAIL-CLOSED: a non-empty proxy URL that is unparseable or uses an unknown
//    scheme THROWS, aborting the request rather than silently leaking the host
//    IP through a direct connection.
//  - AUTO-BYPASS-LOCAL: when the TARGET host is loopback / link-local / RFC1918 /
//    *.local, return null (no agent) so LAN targets are reached directly. A
//    local Prowlarr/NZBHydra or a manager-hosted .nzb URL must not be tunnelled
//    (Gluetun can't reach a sibling container's loopback, and it would be
//    pointless anyway since the manager makes the real outbound hop).
//  - Empty/blank proxy URL => null (this indexer simply has no proxy configured;
//    a direct connection is the intended behavior).
//  - Always returns BOTH httpAgent and httpsAgent so neither a plain-http nor an
//    https target can egress directly. axios selects the right one by target
//    scheme; callers also pass `proxy: false` so axios's own HTTP(S)_PROXY env
//    handling can't double-proxy or bypass our agent.

const axios = require('axios');
const crypto = require('crypto');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// Redirect hops to follow before giving up (managers redirect at most once).
const MAX_PROXY_REDIRECTS = 5;

const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);

// Hostname suffixes that are never public — internal/LAN/reserved namespaces.
// A manager/indexer on any of these can't be reached through an external proxy
// and is never a real public indexer, so we connect direct (bypass).
const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.home.arpa', '.corp', '.intranet', '.docker'];

// Cache agents per proxy identity — agents are reusable across targets of the
// same scheme family. The key is a one-way digest so proxy credentials are not
// retained a second time as an inspectable Map/debug identity.
const agentCache = new Map();
const MAX_AGENT_CACHE_ENTRIES = (() => {
  const raw = Number(process.env.INDEXER_PROXY_AGENT_CACHE_MAX_ENTRIES);
  // 20 direct Newznab slots plus the manager fit without evicting an agent
  // that may still be serving an active request.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 32;
})();

function proxyCacheKey(proxyUrl) {
  return crypto.createHash('sha256').update(proxyUrl).digest('hex');
}

function destroyAgents(agents) {
  const unique = new Set([agents?.httpAgent, agents?.httpsAgent].filter(Boolean));
  for (const agent of unique) {
    try { agent.destroy?.(); } catch { /* best-effort socket cleanup */ }
  }
}

function evictProxyAgentCacheEntry(key) {
  const entry = agentCache.get(key);
  if (!entry) return;
  agentCache.delete(key);
  destroyAgents(entry.agents);
}

function enforceProxyAgentCacheLimit() {
  while (agentCache.size > MAX_AGENT_CACHE_ENTRIES) {
    evictProxyAgentCacheEntry(agentCache.keys().next().value);
  }
}

// Call on a proxy configuration reload. Agents for removed/changed proxy URLs
// are destroyed immediately instead of waiting for LRU pressure.
function pruneProxyAgentCache(activeProxyUrls = []) {
  const activeKeys = new Set(activeProxyUrls
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => proxyCacheKey(value.trim())));
  for (const key of Array.from(agentCache.keys())) {
    if (!activeKeys.has(key)) evictProxyAgentCacheEntry(key);
  }
}

function clearProxyAgentCache() {
  for (const key of Array.from(agentCache.keys())) evictProxyAgentCacheEntry(key);
}

function getProxyAgentCacheStats() {
  return { entries: agentCache.size, maxEntries: MAX_AGENT_CACHE_ENTRIES };
}

// Strip any credentials from a proxy URL for safe logging/echoing.
function maskProxyUrl(raw) {
  const s = String(raw || '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      return u.toString();
    }
    return s;
  } catch (_) {
    return s.replace(/\/\/[^@/]+@/, '//***@');
  }
}

// True when a proxy URL string carries inline credentials (user[:pass]@host).
function proxyUrlHasCredentials(raw) {
  const s = String(raw || '');
  if (!s) return false;
  try {
    const u = new URL(s);
    return Boolean(u.username || u.password);
  } catch (_) {
    return /\/\/[^@/]+@/.test(s);
  }
}

// True when a target host should bypass the proxy and connect directly.
// Covers loopback / link-local / RFC1918 (v4) + loopback/ULA/link-local (v6),
// common local suffixes, AND single-label hostnames (Docker/Compose service
// names like "prowlarr"). An external proxy can't reach any of these, and none
// of them is ever a real public indexer — so we connect direct instead of
// tunnelling. Public FQDNs and public IPs return false (proxy applies).
function isPrivateOrLocalHost(host) {
  if (!host) return true; // unknown/unparseable host — don't risk tunnelling it
  const h = String(host).toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true;

  // IPv6 literal (contains a colon). Check prefixes ONLY here so a hostname
  // like "fdn.example.com" can't be mistaken for an fc/fd ULA address.
  if (h.includes(':')) {
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true; // loopback
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
    return false; // any other IPv6 => public
  }

  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true;                 // 127.0.0.0/8 loopback
    if (a === 10) return true;                   // 10.0.0.0/8
    if (a === 192 && b === 168) return true;     // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true;     // 169.254.0.0/16 link-local
    return false;                                // any other IPv4 => public
  }

  // Single-label hostname (no dot) => an internal name: a Docker/Compose service
  // ("prowlarr", "nzbhydra"), a container alias, or a bare LAN host. Public
  // indexers are always FQDNs, so a dotless name is never a real indexer — and
  // an external proxy couldn't resolve it anyway. Connect direct.
  if (!h.includes('.')) return true;

  return false; // dotted FQDN => treat as public/internet => proxy applies
}

function hostFromUrl(targetUrl) {
  try {
    return new URL(targetUrl).hostname;
  } catch (_) {
    return null;
  }
}

// Build (and memoize) the {httpAgent, httpsAgent} pair for a proxy URL.
// Throws (fail-closed) on an unparseable URL or unsupported scheme.
function buildAgentsForProxy(proxyUrl) {
  const cacheKey = proxyCacheKey(proxyUrl);
  const cached = agentCache.get(cacheKey);
  if (cached) {
    // Touch insertion order for LRU eviction.
    agentCache.delete(cacheKey);
    agentCache.set(cacheKey, cached);
    return cached.agents;
  }

  let scheme;
  try {
    scheme = new URL(proxyUrl).protocol.replace(/:$/, '').toLowerCase();
  } catch (_) {
    throw new Error(`[INDEXER PROXY] Invalid proxy URL: ${maskProxyUrl(proxyUrl)}`);
  }

  let agents;
  if (scheme === 'http' || scheme === 'https') {
    // http-proxy-agent serves http targets, https-proxy-agent serves https
    // targets (CONNECT tunnel). Both accept an http:// or https:// proxy URL.
    agents = {
      httpAgent: new HttpProxyAgent(proxyUrl),
      httpsAgent: new HttpsProxyAgent(proxyUrl),
    };
  } else if (SOCKS_SCHEMES.has(scheme)) {
    // One SOCKS agent handles both target schemes. Use socks5h:// for DNS
    // resolution at the proxy (avoids leaking an indexer hostname lookup).
    const socks = new SocksProxyAgent(proxyUrl);
    agents = { httpAgent: socks, httpsAgent: socks };
  } else {
    throw new Error(`[INDEXER PROXY] Unsupported proxy scheme "${scheme}://" (use http://, https://, or socks5://)`);
  }

  agentCache.set(cacheKey, { agents });
  enforceProxyAgentCacheLimit();
  return agents;
}

/**
 * Resolve proxy agents for an indexer-bound request.
 * @param {string} proxyUrl  The configured proxy URL (per-indexer or manager). Blank => no proxy.
 * @param {string} targetUrl The final request URL (search/caps/.nzb/manager endpoint).
 * @returns {{httpAgent: object, httpsAgent: object} | null}
 *   null  => attach nothing (no proxy configured, or LAN target bypassed) => direct request.
 *   throws => proxy configured but invalid (fail-closed; request must abort, never leak).
 */
function buildProxyAgents(proxyUrl, targetUrl) {
  const url = typeof proxyUrl === 'string' ? proxyUrl.trim() : '';
  if (!url) return null; // no proxy configured for this indexer => direct
  if (isPrivateOrLocalHost(hostFromUrl(targetUrl))) return null; // LAN target => bypass
  return buildAgentsForProxy(url); // throws on bad scheme/URL (fail-closed)
}

/**
 * Redirect-aware GET that keeps a proxy applied across hops.
 *
 * Indexer managers (notably Prowlarr, which now FORCES it for Usenet) answer a
 * download request with a 301/302 whose Location is the REAL public indexer URL.
 * axios's built-in redirect follower freezes the agent chosen for the original
 * URL — so a grab that starts at a bypassed localhost manager URL would follow
 * the redirect to the public indexer with NO proxy and leak the host IP.
 *
 * This follows redirects manually with maxRedirects:0 and re-runs
 * buildProxyAgents against EACH hop's host, so the localhost hop goes direct
 * (bypassed) while the redirected public-indexer hop rides the proxy. A
 * misconfigured proxy throws (fail-closed) at the hop that needs it, aborting
 * the grab rather than connecting directly.
 *
 * Only call this when a proxy is actually configured for the indexer; with no
 * proxy, a plain axios.get (normal auto-follow) is fine.
 *
 * @param {string} url        initial request URL
 * @param {string} proxyUrl   the resolved proxy for this indexer/manager
 * @param {object} axiosConfig caller's axios options (responseType, timeout,
 *   headers, signal, validateStatus, …) — applied to every hop
 * @returns {Promise<import('axios').AxiosResponse>} the final (non-3xx) response
 */
async function proxiedGet(url, proxyUrl, axiosConfig = {}) {
  const { validateHop, ...requestConfig } = axiosConfig;
  const callerValidate = typeof axiosConfig.validateStatus === 'function'
    ? axiosConfig.validateStatus
    : (s) => s >= 200 && s < 300;
  let currentUrl = url;
  let previousUrl = null;
  let hopHeaders = { ...(requestConfig.headers || {}) };
  for (let hop = 0; hop <= MAX_PROXY_REDIRECTS; hop += 1) {
    if (typeof validateHop === 'function') {
      const validation = await validateHop(currentUrl, previousUrl);
      if (validation?.stripSensitiveHeaders) {
        hopHeaders = Object.fromEntries(Object.entries(hopHeaders).filter(([name]) => ![
          'authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token',
        ].includes(String(name).toLowerCase())));
      }
    }
    const agents = buildProxyAgents(proxyUrl, currentUrl); // throws fail-closed on a bad proxy URL
    const resp = await axios.get(currentUrl, {
      ...requestConfig,
      headers: hopHeaders,
      maxRedirects: 0, // we follow manually so the proxy is re-evaluated per hop
      proxy: false,
      ...(agents || {}),
      // Accept 3xx so we can read Location; otherwise defer to the caller's rule.
      validateStatus: (s) => (s >= 300 && s < 400 ? true : callerValidate(s)),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers && (resp.headers.location || resp.headers.Location);
      if (!loc) return resp; // redirect with no target — hand back as-is
      previousUrl = currentUrl;
      try { currentUrl = new URL(loc, currentUrl).toString(); } // resolve relative redirects
      catch (_) {
        const error = new Error('Invalid download redirect URL');
        error.code = 'OUTBOUND_URL_BLOCKED';
        throw error;
      }
      continue;
    }
    return resp;
  }
  let host = 'target';
  try { host = new URL(currentUrl).host; } catch (_) { /* keep placeholder */ }
  throw new Error(`[INDEXER PROXY] Exceeded ${MAX_PROXY_REDIRECTS} redirects fetching ${host}`);
}

module.exports = {
  buildProxyAgents,
  proxiedGet,
  maskProxyUrl,
  proxyUrlHasCredentials,
  isPrivateOrLocalHost,
  pruneProxyAgentCache,
  clearProxyAgentCache,
  getProxyAgentCacheStats,
};
