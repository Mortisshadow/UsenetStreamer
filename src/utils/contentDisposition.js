// Build a header-safe Content-Disposition value.
//
// HTTP header values are Latin1, but release filenames routinely contain
// characters beyond Latin1 (CJK, em-dash "—", curly quotes "’", emoji), which
// make res.setHeader throw ERR_INVALID_CHAR and 500 the response. We emit BOTH:
//   - filename="<ascii>"        — an ASCII-only fallback for legacy clients
//   - filename*=UTF-8''<pct>    — the real UTF-8 name, percent-encoded (RFC 5987)
// so the true filename is preserved where supported and nothing ever throws.

// RFC 5987: encodeURIComponent covers most of it, but leaves ' ( ) * which the
// spec requires encoded. Over-encoding the other allowed chars is harmless.
function encodeRfc5987(value) {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * @param {string} fileName  desired filename (may contain any Unicode)
 * @param {string} [disposition='inline']  'inline' | 'attachment'
 * @returns {string} a Content-Disposition value safe to pass to res.setHeader
 */
function buildContentDisposition(fileName, disposition = 'inline') {
  const raw = String(fileName == null ? '' : fileName).trim();
  // Drop filesystem-illegal chars (existing behaviour), keep a non-empty base.
  const base = raw.replace(/[\\/:*?"<>|]+/g, '_') || 'stream';
  // ASCII-only fallback: printable ASCII only (the fs strip above already
  // removed " and \, which would otherwise break the quoted string).
  const asciiFallback = base.replace(/[^\x20-\x7E]/g, '-') || 'stream';
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(base)}`;
}

module.exports = { buildContentDisposition, encodeRfc5987 };
