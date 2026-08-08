'use strict';

const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const { proxiedGet } = require('./proxyAgent');
const { createPinnedLookup, validateOutboundUrl, validateRedirect } = require('./safeUrl');

const MAX_REDIRECTS = 5;
const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

function withoutSensitiveHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !SENSITIVE_REDIRECT_HEADERS.has(String(name).toLowerCase())));
}

function redirectAwareStatus(callerValidate) {
  return (status) => (status >= 300 && status < 400) || callerValidate(status);
}

/**
 * Fetch a buffered HTTP(S) response after validating and pinning every direct
 * DNS hop. Explicitly configured proxies remain the network trust boundary,
 * but every target/redirect is still checked locally before it is requested.
 */
async function safeBufferedGet(url, options = {}) {
  const {
    allowedHosts = [],
    proxyUrl = '',
    allowInsecureRedirect = false,
    ...axiosConfig
  } = options;
  const callerValidate = typeof axiosConfig.validateStatus === 'function'
    ? axiosConfig.validateStatus
    : (status) => status >= 200 && status < 300;
  const validationOptions = { allowedHosts, allowInsecureRedirect };

  if (proxyUrl) {
    const response = await proxiedGet(url, proxyUrl, {
      ...axiosConfig,
      validateHop: async (currentUrl, previousUrl) => {
        if (previousUrl) return validateRedirect(previousUrl, currentUrl, validationOptions);
        return validateOutboundUrl(currentUrl, validationOptions);
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const error = new Error('Download redirect response did not include a usable Location');
      error.code = 'OUTBOUND_URL_BLOCKED';
      throw error;
    }
    return response;
  }

  let currentUrl = url;
  let previousUrl = null;
  let headers = { ...(axiosConfig.headers || {}) };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const validation = previousUrl
      ? await validateRedirect(previousUrl, currentUrl, validationOptions)
      : await validateOutboundUrl(currentUrl, validationOptions);
    if (validation.stripSensitiveHeaders) headers = withoutSensitiveHeaders(headers);

    const Agent = new URL(validation.url).protocol === 'https:' ? https.Agent : http.Agent;
    const agent = new Agent({ keepAlive: false, lookup: createPinnedLookup(validation) });
    let response;
    try {
      response = await axios.get(validation.url, {
        ...axiosConfig,
        headers,
        maxRedirects: 0,
        proxy: false,
        httpAgent: agent,
        httpsAgent: agent,
        validateStatus: redirectAwareStatus(callerValidate),
      });
    } finally {
      agent.destroy();
    }

    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers?.location || response.headers?.Location;
    if (!location) {
      const error = new Error('Download redirect response did not include a usable Location');
      error.code = 'OUTBOUND_URL_BLOCKED';
      throw error;
    }
    previousUrl = validation.url;
    try { currentUrl = new URL(location, validation.url).toString(); }
    catch (_) {
      const error = new Error('Invalid download redirect URL');
      error.code = 'OUTBOUND_URL_BLOCKED';
      throw error;
    }
  }
  throw new Error(`Exceeded ${MAX_REDIRECTS} redirects fetching NZB`);
}

module.exports = { safeBufferedGet, withoutSensitiveHeaders };
