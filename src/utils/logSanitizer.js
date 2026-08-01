const SENSITIVE_QUERY_VALUE = /((?:[?&]|&amp;)(?:api[-_]?key|apikey|access[-_]?token|token|link)=)[^&#\s]*/gi;
const URL_CREDENTIALS = /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const SENSITIVE_OBJECT_KEY = /^(?:api[-_]?key|access[-_]?token|token|link|password|pass)$/i;

function redactSensitiveString(value) {
  return String(value || '')
    .replace(SENSITIVE_QUERY_VALUE, '$1[REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@');
}

function sanitizeLogValue(value, depth = 0) {
  if (typeof value === 'string') return redactSensitiveString(value);
  if (value === null || value === undefined || depth >= 5) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeLogValue(entry, depth + 1));
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_OBJECT_KEY.test(key) ? '[REDACTED]' : sanitizeLogValue(entry, depth + 1),
  ]));
}

module.exports = { redactSensitiveString, sanitizeLogValue };
