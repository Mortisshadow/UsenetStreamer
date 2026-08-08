// Zero-width space sentinel — visually invisible, never a real env value.
const CREDENTIAL_MASK_SENTINEL = '​__MASKED_CREDENTIAL__​';

const SENSITIVE_KEYS = new Set([
  'INDEXER_MANAGER_API_KEY',
  'NZBDAV_API_KEY',
  'INFINIDYSK_FRONTEND_API_KEY',
  'NZBDAV_WEBDAV_PASS',
  'NZB_TRIAGE_NNTP_PASS',
  'EASYNEWS_PASSWORD',
  'TMDB_API_KEY',
  'TVDB_API_KEY',
  'SPECIAL_PROVIDER_SECRET',
]);

const SENSITIVE_KEY_PATTERNS = [/^NEWZNAB_API_KEY_\d+$/];

// Indexer proxy URLs (manager + per-row). Unlike API keys these are masked
// CONDITIONALLY — only when the URL embeds credentials (user:pass@host) — so a
// plain proxy like socks5://gluetun:8388 stays visible/editable in the admin UI.
const PROXY_KEYS = new Set(['INDEXER_MANAGER_PROXY']);
const PROXY_KEY_PATTERNS = [/^NEWZNAB_PROXY_\d+$/];

function isProxyKey(key) {
  if (PROXY_KEYS.has(key)) return true;
  return PROXY_KEY_PATTERNS.some((rx) => rx.test(key));
}

// A proxy URL carries credentials when it has a userinfo segment before the host.
function proxyValueHasCredentials(value) {
  return /\/\/[^/@]+@/.test(String(value || ''));
}

function isSensitiveKey(key) {
  if (SENSITIVE_KEYS.has(key)) return true;
  return SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(key));
}

function maskSensitiveValues(values) {
  const masked = { ...values };
  Object.keys(masked).forEach((key) => {
    if (!masked[key]) return;
    if (isProxyKey(key)) {
      // Only hide a proxy URL when it actually contains credentials.
      if (proxyValueHasCredentials(masked[key])) {
        masked[key] = CREDENTIAL_MASK_SENTINEL;
      }
      return;
    }
    if (isSensitiveKey(key)) {
      masked[key] = CREDENTIAL_MASK_SENTINEL;
    }
  });
  return masked;
}

function unsentinelValues(values) {
  if (!values || typeof values !== 'object') return values;
  const resolved = { ...values };
  Object.keys(resolved).forEach((key) => {
    if (resolved[key] === CREDENTIAL_MASK_SENTINEL) {
      resolved[key] = process.env[key] || '';
    }
  });
  return resolved;
}

module.exports = {
  CREDENTIAL_MASK_SENTINEL,
  SENSITIVE_KEYS,
  SENSITIVE_KEY_PATTERNS,
  isSensitiveKey,
  isProxyKey,
  proxyValueHasCredentials,
  maskSensitiveValues,
  unsentinelValues,
};
