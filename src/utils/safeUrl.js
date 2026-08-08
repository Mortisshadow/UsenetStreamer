'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

function urlPolicyError(message) {
  const error = new Error(message);
  error.code = 'OUTBOUND_URL_BLOCKED';
  return error;
}

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2))
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && parts[2] === 100)
      || (a === 203 && b === 0 && parts[2] === 113);
  }
  if (version === 6) {
    const normalized = address.toLowerCase().split('%')[0];
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89abcdef]/.test(normalized)
      || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return true;
    if (normalized.startsWith('::ffff:')) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true;
}

function parseHttpUrl(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch (_) { throw urlPolicyError('Invalid download URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw urlPolicyError('Only HTTP(S) download URLs are allowed');
  if (parsed.username || parsed.password) throw urlPolicyError('Credentials in download URLs are not allowed');
  parsed.hash = '';
  return parsed;
}

async function validateOutboundUrl(value, options = {}) {
  const parsed = parseHttpUrl(value);
  const allowPrivate = options.allowPrivate === true;
  const allowedHosts = new Set((options.allowedHosts || []).map((host) => String(host).toLowerCase()));
  const hostExplicitlyAllowed = allowedHosts.has(parsed.hostname.toLowerCase());
  const directIp = net.isIP(parsed.hostname) ? [{ address: parsed.hostname, family: net.isIP(parsed.hostname) }] : null;
  const timeoutMs = Number.isFinite(options.dnsTimeoutMs) ? Math.max(100, options.dnsTimeoutMs) : 5000;
  let timeout;
  const lookupPromise = directIp
    ? Promise.resolve(directIp)
    : Promise.resolve().then(() => (options.lookup || dns.lookup)(parsed.hostname, { all: true, verbatim: true }));
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Download host DNS lookup timed out')), timeoutMs);
    timeout.unref?.();
  });
  let addresses;
  try {
    addresses = await Promise.race([lookupPromise, timeoutPromise]);
  } catch (error) {
    error.code = 'OUTBOUND_URL_VALIDATION_FAILED';
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw urlPolicyError('Download host did not resolve');
  if (!allowPrivate && !hostExplicitlyAllowed && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw urlPolicyError('Download URL resolves to a private, loopback, or link-local address');
  }
  return { url: parsed.toString(), hostname: parsed.hostname, addresses };
}

function createPinnedLookup(validation) {
  const allowed = Array.isArray(validation?.addresses) ? validation.addresses.slice() : [];
  if (!allowed.length) throw urlPolicyError('Validated addresses are required');
  return (_hostname, options, callback) => {
    const wantsAll = typeof options === 'object' && options.all;
    if (wantsAll) return callback(null, allowed);
    const selected = allowed.find((item) => !options?.family || item.family === options.family) || allowed[0];
    return callback(null, selected.address, selected.family);
  };
}

async function validateRedirect(fromUrl, targetUrl, options = {}) {
  const from = parseHttpUrl(fromUrl);
  let resolved;
  try { resolved = new URL(targetUrl, from).toString(); }
  catch (_) { throw urlPolicyError('Invalid download redirect URL'); }
  const target = parseHttpUrl(resolved);
  if (from.protocol === 'https:' && target.protocol === 'http:' && options.allowInsecureRedirect !== true) {
    throw urlPolicyError('HTTPS to HTTP download redirects are not allowed');
  }
  const validation = await validateOutboundUrl(target.toString(), options);
  return {
    ...validation,
    sameOrigin: from.origin === target.origin,
    // Manual redirect callers must drop API keys/cookies/authorization when
    // following a redirect to another origin.
    stripSensitiveHeaders: from.origin !== target.origin,
  };
}

module.exports = { createPinnedLookup, isPrivateAddress, parseHttpUrl, validateOutboundUrl, validateRedirect };
