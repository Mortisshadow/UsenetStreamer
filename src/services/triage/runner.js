const axios = require('axios');
const { triageNzbs } = require('./index');
const { getDefaultDownloadUserAgent } = require('../../utils/userAgent');
const { getDownloadUserAgentForIndexer, getProxyForIndexer } = require('../newznab');
const { getManagerProxy } = require('../indexer');
const { proxiedGet } = require('../../utils/proxyAgent');
const diskNzbCache = require('../../cache/diskNzbCache');
const {
  buildExactEvidenceKey,
  runWithExactHealthEvidence,
} = require('../../cache/healthEvidenceCache');
const { sanitizeLogValue } = require('../../utils/logSanitizer');

const DEFAULT_TIME_BUDGET_MS = 40000;
const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_DOWNLOAD_CONCURRENCY = 8;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15000;
const LARGE_NZB_DOWNLOAD_TIMEOUT_MS = 15000;
const LARGE_NZB_SIZE_THRESHOLD = 30 * 1024 * 1024 * 1024; // 30 GB
const TIMEOUT_ERROR_CODE = 'TRIAGE_TIMEOUT';
// Shared across requests so configured rate-sensitive indexers cannot be hit
// concurrently by separate background/blocking triage sessions.
const serializedIndexerChains = new Map();
const nzbDownloadFlights = new Map();

async function runNzbDownloadSingleFlight(downloadUrl, task) {
  if (!downloadUrl) return task();
  const existing = nzbDownloadFlights.get(downloadUrl);
  if (existing) return existing;
  const flight = Promise.resolve().then(task);
  nzbDownloadFlights.set(downloadUrl, flight);
  try {
    return await flight;
  } finally {
    if (nzbDownloadFlights.get(downloadUrl) === flight) {
      nzbDownloadFlights.delete(downloadUrl);
    }
  }
}

async function runWithIndexerSerialization(indexerKey, enabled, task) {
  if (!enabled || !indexerKey) return task();
  const previous = serializedIndexerChains.get(indexerKey) || Promise.resolve();
  let releaseCurrent;
  const currentGate = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(() => currentGate);
  serializedIndexerChains.set(indexerKey, chained);
  await previous;
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (serializedIndexerChains.get(indexerKey) === chained) {
      serializedIndexerChains.delete(indexerKey);
    }
  }
}

function normalizeTitle(title) {
  if (title === undefined || title === null) return '';
  const raw = title.toString().trim();
  if (!raw) return '';

  let working = raw.replace(/\.(nzb|zip)$/i, '');
  working = working
    .replace(/[._-]+/g, ' ')
    .replace(/['"`]+/g, ' ')
    .replace(/[()\[\]{}]/g, ' ')
    .replace(/[^a-z0-9\s]+/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase();

  return working;
}

function logEvent(logger, level, message, context) {
  if (!logger) return;
  const payload = context && Object.keys(context).length > 0 ? sanitizeLogValue(context) : undefined;
  if (typeof logger === 'function') {
    logger(level, message, payload);
    return;
  }
  const fn = typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
  if (fn) fn(message, payload);
}

function normalizeIndexerToken(value) {
  if (value === undefined || value === null) return null;
  const token = String(value).trim().toLowerCase();
  return token.length > 0 ? token : null;
}

function normalizeIndexerSet(indexers) {
  if (!Array.isArray(indexers)) return new Set();
  return new Set(indexers.map((entry) => normalizeIndexerToken(entry)).filter(Boolean));
}

function candidateMatchesIndexerSet(candidate, tokenSet) {
  if (!tokenSet || tokenSet.size === 0) return true;
  const idToken = normalizeIndexerToken(candidate?.indexerId);
  if (idToken && tokenSet.has(idToken)) return true;
  const nameToken = normalizeIndexerToken(candidate?.indexerName);
  if (nameToken && tokenSet.has(nameToken)) return true;
  return false;
}

function buildCandidates(nzbResults) {
  const seen = new Set();
  const candidates = [];
  nzbResults.forEach((result, index) => {
    const downloadUrl = result?.downloadUrl;
    if (!downloadUrl || seen.has(downloadUrl)) {
      return;
    }
    seen.add(downloadUrl);
    const size = Number(result?.size ?? 0);
    const title = typeof result?.title === 'string' ? result.title : null;
    candidates.push({
      result,
      index,
      size: Number.isFinite(size) ? size : 0,
      indexerId: result?.indexerId !== undefined ? String(result.indexerId) : null,
      indexerName: typeof result?.indexer === 'string' ? result.indexer : null,
      downloadUrl,
      title,
      normalizedTitle: normalizeTitle(title),
    });
  });
  return candidates;
}

function rankCandidates(candidates, preferredSizeBytes) {
  // Simple ranking by size preference only (no indexer-based priority)
  const comparator = Number.isFinite(preferredSizeBytes)
    ? (a, b) => {
        const deltaA = Math.abs((a.size || 0) - preferredSizeBytes);
        const deltaB = Math.abs((b.size || 0) - preferredSizeBytes);
        if (deltaA !== deltaB) return deltaA - deltaB;
        return (b.size || 0) - (a.size || 0);
      }
    : (a, b) => (b.size || 0) - (a.size || 0);

  return candidates.slice().sort(comparator);
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Triage timed out');
      error.code = TIMEOUT_ERROR_CODE;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function summarizeDecision(decision) {
  const blockers = Array.isArray(decision?.blockers) ? decision.blockers : [];
  const warnings = Array.isArray(decision?.warnings) ? decision.warnings : [];
  const archiveFindings = Array.isArray(decision?.archiveFindings) ? decision.archiveFindings : [];

  // Check if any 7z finding is present, and whether a verified 7z (sevenzip-stored) was found
  const hasSevenZipFinding = archiveFindings.some((finding) => {
    const label = String(finding?.status || '').toLowerCase();
    return label.startsWith('sevenzip');
  }) || warnings.some((warning) => String(warning || '').toLowerCase().startsWith('sevenzip'));

  const hasSevenZipStored = archiveFindings.some((finding) => {
    const label = String(finding?.status || '').toLowerCase();
    return label === 'sevenzip-stored';
  });

  let status = 'blocked';
  if (decision?.decision === 'accept' && blockers.length === 0) {
    const positiveFinding = archiveFindings.some((finding) => {
      const label = String(finding?.status || '').toLowerCase();
      return label === 'rar-stored' || label === 'sevenzip-stored' || label === 'segment-ok';
    });
    if (positiveFinding) {
      status = 'verified';
    } else if (hasSevenZipFinding) {
      status = 'unverified_7z';
    } else {
      status = 'unverified';
    }
  }

  // Downgrade verified to unverified_7z if 7z finding present but none were sevenzip-stored
  if (status === 'verified' && hasSevenZipFinding && !hasSevenZipStored) {
    status = 'unverified_7z';
  }

  // Flag other unverified outcomes that are 7z-only
  if (status === 'unverified' && hasSevenZipFinding) {
    status = 'unverified_7z';
  }

  const releaseStatus = status;
  const episodeCoverage = decision?.episodeCoverage ?? null;
  if (episodeCoverage?.status === 'missing') {
    status = 'blocked';
    if (!blockers.includes('requested-episode-missing')) blockers.push('requested-episode-missing');
  } else if (episodeCoverage?.status === 'unknown' && status === 'verified') {
    status = 'unverified';
  }

  return {
    status,
    releaseStatus,
    blockers,
    warnings,
    nzbIndex: decision?.nzbIndex ?? null,
    fileCount: decision?.fileCount ?? null,
    archiveFindings,
    episodeCoverage,
  };
}

async function triageAndRank(nzbResults, options = {}) {
  const startTs = Date.now();
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const preferredSizeBytes = Number.isFinite(options.preferredSizeBytes) ? options.preferredSizeBytes : null;
  const preferredIndexerSet = normalizeIndexerSet(options.preferredIndexerIds);
  const serializedIndexerSet = normalizeIndexerSet(options.serializedIndexerIds);
  const allowedIndexerSet = normalizeIndexerSet(options.allowedIndexerIds);
  const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  const logger = options.logger;
  const triageOptions = { ...(options.triageOptions || {}) };
  const captureNzbPayloads = Boolean(options.captureNzbPayloads);
  const onDecisionCb = typeof options.onDecision === 'function' ? options.onDecision : null;
  // Optional in-memory cache of NZB payloads to avoid re-downloading on retries
  // Accepts any Map-like object with get(url) and set(url, payload) methods
  const nzbPayloadCache = options.nzbPayloadCache && typeof options.nzbPayloadCache.get === 'function' && typeof options.nzbPayloadCache.set === 'function'
    ? options.nzbPayloadCache
    : null;

  const builtCandidates = buildCandidates(nzbResults);
  const constrainedCandidates = allowedIndexerSet.size > 0
    ? builtCandidates.filter((candidate) => candidateMatchesIndexerSet(candidate, allowedIndexerSet))
    : builtCandidates;
  // The caller already supplies its authoritative SEL/sort order. Racing mode
  // must preserve that order so rank 1 starts first instead of being silently
  // re-sorted by file size inside the health runner.
  const candidates = options.preserveInputOrder
    ? constrainedCandidates.slice()
    : rankCandidates(constrainedCandidates, preferredSizeBytes, preferredIndexerSet);
  const uniqueCandidates = [];
  const seenTitles = new Set();
  candidates.forEach((candidate) => {
    const titleKey = candidate.normalizedTitle;
    if (titleKey) {
      if (seenTitles.has(titleKey)) return;
      seenTitles.add(titleKey);
    }
    uniqueCandidates.push(candidate);
  });

  const selectedCandidates = uniqueCandidates.slice(0, Math.min(maxCandidates, uniqueCandidates.length));
  if (selectedCandidates.length === 0) {
    return {
      decisions: new Map(),
      elapsedMs: Date.now() - startTs,
      timedOut: false,
      candidatesConsidered: 0,
      evaluatedCount: 0,
      fetchFailures: 0,
      summary: null,
    };
  }

  const candidateByUrl = new Map();
  selectedCandidates.forEach((candidate) => {
    candidateByUrl.set(candidate.downloadUrl, candidate);
  });

  const decisionMap = new Map();

  const attachMetadata = (url, decision) => {
    const candidateInfo = candidateByUrl.get(url);
    if (candidateInfo) {
      decision.title = candidateInfo.title || null;
      decision.normalizedTitle = candidateInfo.normalizedTitle || null;
      decision.indexerId = candidateInfo.indexerId || null;
      decision.indexerName = candidateInfo.indexerName || null;
      if (candidateInfo.result) {
        decision.publishDateMs = candidateInfo.result.publishDateMs ?? decision.publishDateMs ?? null;
        decision.publishDateIso = candidateInfo.result.publishDateIso ?? decision.publishDateIso ?? null;
        decision.ageDays = candidateInfo.result.ageDays ?? decision.ageDays ?? null;
      }
    } else {
      decision.title = decision.title ?? null;
      decision.normalizedTitle = decision.normalizedTitle ?? null;
    }
    return decision;
  };
  const downloadConcurrency = Math.max(
    1,
    Math.min(options.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY, selectedCandidates.length),
  );
  const baseDownloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  // If any candidate is >40 GB, use the larger timeout for all downloads
  const hasLargeCandidate = selectedCandidates.some((c) => (c.size || 0) > LARGE_NZB_SIZE_THRESHOLD);
  const downloadTimeoutMs = hasLargeCandidate
    ? Math.max(baseDownloadTimeoutMs, LARGE_NZB_DOWNLOAD_TIMEOUT_MS)
    : baseDownloadTimeoutMs;
  // Honour the caller's reuse flag (NZB_TRIAGE_REUSE_POOL). Default is reuse
  // (undefined/true → true); only an explicit false builds a fresh one-shot pool
  // per run and closes it — which is what the flag is documented to do. Hardcoding
  // true here made the setting a no-op for actual triage runs.
  const triageConfig = { ...triageOptions, reuseNntpPool: triageOptions.reuseNntpPool !== false };
  let cursor = 0;
  let timedOut = false;
  let evaluatedCount = 0;
  let fetchFailures = 0;
  const returnOnFirstVerified = Boolean(options.returnOnFirstVerified);
  const hedgeDelayMs = Math.max(0, Number(options.hedgeDelayMs) || 0);
  let verifiedWinner = null;
  let resolveVerifiedWinner;
  const verifiedWinnerPromise = new Promise((resolve) => {
    resolveVerifiedWinner = resolve;
  });

  const publishVerifiedWinner = (candidate, decision) => {
    if (!returnOnFirstVerified || verifiedWinner || decision?.status !== 'verified') return;
    verifiedWinner = {
      title: candidate.title,
      index: candidate.index,
    };
    resolveVerifiedWinner(verifiedWinner);
  };

  const makeTimeoutDecision = (url) => attachMetadata(url, {
    status: 'error',
    blockers: ['triage-error'],
    warnings: ['Triage timed out'],
    archiveFindings: [],
    nzbIndex: null,
    fileCount: null,
  });

  const workers = Array.from({ length: downloadConcurrency }, async () => {
    while (true) {
      if (timedOut) return;
      const index = cursor;
      if (index >= selectedCandidates.length) return;
      cursor += 1;

      const candidate = selectedCandidates[index];
      const { downloadUrl } = candidate;

      if (returnOnFirstVerified && verifiedWinner) return;
      const hedgeRemainingMs = (startTs + (index * hedgeDelayMs)) - Date.now();
      if (hedgeRemainingMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, hedgeRemainingMs);
          if (typeof timer.unref === 'function') timer.unref();
        });
      }
      if (returnOnFirstVerified && verifiedWinner) return;

      if (decisionMap.has(downloadUrl)) continue;

      const indexerIdKey = normalizeIndexerToken(candidate.indexerId);
      const indexerNameKey = normalizeIndexerToken(candidate.indexerName);
      const indexerKey = indexerIdKey || indexerNameKey;
      const serializedIndexerKey = [indexerIdKey, indexerNameKey]
        .find((key) => key && serializedIndexerSet.has(key)) || null;

      if (Date.now() - startTs >= timeBudgetMs) {
        timedOut = true;
        const timeoutDecision = makeTimeoutDecision(downloadUrl);
        decisionMap.set(downloadUrl, timeoutDecision);
        if (onDecisionCb) try { onDecisionCb(downloadUrl, timeoutDecision); } catch { /* ignore */ }
        continue;
      }

      const downloadStart = Date.now();

      let nzbPayload;

      // 1. In-session RAM cache — avoids re-downloading on retries this pass.
      const cachedPayload = nzbPayloadCache ? nzbPayloadCache.get(downloadUrl) : null;
      // 2. On-disk verified-payload cache — a previously-verified NZB is already
      //    saved to disk, so reuse it and skip the indexer re-download (saves
      //    indexer / Cloudflare-WAF hits). The NNTP health check still runs on it
      //    below, so freshness of article availability is unaffected.
      let diskPayload = null;
      if (!cachedPayload) {
        try {
          const diskEntry = diskNzbCache.getFromDisk(downloadUrl);
          if (diskEntry && diskEntry.payloadBuffer) {
            diskPayload = diskEntry.payloadBuffer.toString('utf8');
          }
        } catch { /* ignore — fall through to a normal download */ }
      }
      if (cachedPayload) {
        nzbPayload = cachedPayload;
        logEvent(logger, 'info', 'NZB download:cache-hit', {
          downloadUrl,
          indexerId: candidate.indexerId,
          indexerName: candidate.indexerName,
          title: candidate.title,
          bytes: typeof nzbPayload === 'string' ? nzbPayload.length : null,
        });
      } else if (diskPayload) {
        nzbPayload = diskPayload;
        // Keep it in the RAM cache so retries this pass don't re-read disk.
        if (nzbPayloadCache) nzbPayloadCache.set(downloadUrl, nzbPayload);
        logEvent(logger, 'info', 'NZB download:disk-hit', {
          downloadUrl,
          indexerId: candidate.indexerId,
          indexerName: candidate.indexerName,
          title: candidate.title,
          bytes: typeof nzbPayload === 'string' ? nzbPayload.length : null,
        });
      } else {
        try {
          nzbPayload = await runNzbDownloadSingleFlight(
            downloadUrl,
            () => runWithIndexerSerialization(
              serializedIndexerKey || indexerKey,
              Boolean(serializedIndexerKey),
              async () => {
                if (Date.now() - startTs >= timeBudgetMs) {
                  const error = new Error('Triage timed out while waiting for serialized indexer access');
                  error.code = TIMEOUT_ERROR_CODE;
                  throw error;
                }
                const abortController = new AbortController();
                const hardTimeoutTimer = setTimeout(() => {
                  abortController.abort();
                }, downloadTimeoutMs);

                const downloadUa = getDownloadUserAgentForIndexer(candidate.indexerId || candidate.indexerName)
                  || getDefaultDownloadUserAgent();
                // Same proxy resolution as the NZBDav grab: matched Direct Newznab
                // indexer uses its own proxy (null vs '' matters), non-match is
                // manager-origin and uses the manager proxy.
                const rowProxy = getProxyForIndexer(candidate.indexerId || candidate.indexerName);
                const resolvedProxy = rowProxy === null ? getManagerProxy() : rowProxy;
                const dlConfig = {
                  responseType: 'text',
                  timeout: downloadTimeoutMs,
                  signal: abortController.signal,
                  headers: {
                    Accept: 'application/x-nzb,text/xml;q=0.9,*/*;q=0.8',
                    'User-Agent': downloadUa,
                  },
                  transitional: { silentJSONParsing: true, forcedJSONParsing: false },
                  proxy: false,
                };
                // Proxy configured => follow redirects manually, re-evaluating the
                // proxy per hop (a manager 301 to the real indexer must ride the
                // proxy, not leak direct); fail-closed on a bad proxy. No proxy =>
                // normal auto-follow.
                const response = await (resolvedProxy
                  ? proxiedGet(downloadUrl, resolvedProxy, dlConfig)
                  : axios.get(downloadUrl, dlConfig)
                ).finally(() => {
                  clearTimeout(hardTimeoutTimer);
                });
                if (typeof response.data !== 'string' || response.data.length === 0) {
                  throw new Error('Empty NZB payload');
                }
                return response.data;
              },
            ),
          );
          const elapsed = Date.now() - downloadStart;
          // Cache the downloaded payload for potential retries. Coalesced
          // callers populate their own per-session cache from the shared value.
          if (nzbPayloadCache) {
            nzbPayloadCache.set(downloadUrl, nzbPayload);
          }
          logEvent(logger, 'info', 'NZB download:success', {
            downloadUrl,
            indexerId: candidate.indexerId,
            indexerName: candidate.indexerName,
            title: candidate.title,
            durationMs: elapsed,
            bytes: typeof nzbPayload === 'string' ? nzbPayload.length : null,
          });
        } catch (err) {
          fetchFailures += 1;
          const elapsed = Date.now() - downloadStart;
          const fetchErrDecision = attachMetadata(downloadUrl, {
            status: 'fetch-error',
            error: err?.code === 'ERR_CANCELED' || err?.message === 'canceled'
              ? 'NZB download exceeded timeout'
              : err?.message || 'Failed to fetch NZB payload',
            blockers: ['fetch-error'],
            warnings: [],
            archiveFindings: [],
            nzbIndex: null,
            fileCount: null,
          });
          decisionMap.set(downloadUrl, fetchErrDecision);
          if (onDecisionCb) try { onDecisionCb(downloadUrl, fetchErrDecision); } catch { /* ignore */ }
          logEvent(logger, 'warn', 'NZB download:failed', {
            downloadUrl,
            message: err?.code === 'ERR_CANCELED' || err?.message === 'canceled'
              ? 'NZB download exceeded timeout'
              : err?.message,
            indexerId: candidate.indexerId,
            indexerName: candidate.indexerName,
            title: candidate.title,
            durationMs: elapsed,
            timeoutMs: downloadTimeoutMs,
            reason: err?.code === 'ERR_CANCELED' || err?.message === 'canceled'
              ? 'download-timeout'
              : 'download-error',
          });
          continue;
        }
      }

      if (!nzbPayload) {
        continue;
      }

      const triageTask = async () => {
        const remaining = timeBudgetMs - (Date.now() - startTs);
        if (remaining <= 0) {
          const timeoutError = new Error('Triage timed out');
          timeoutError.code = TIMEOUT_ERROR_CODE;
          throw timeoutError;
        }
        const candidateTriageConfig = {
          ...triageConfig,
          requestedEpisode: options.requestedEpisode || null,
          isSeasonPack: candidate.result?.isSeasonPack === true,
        };
        return withTimeout(triageNzbs([nzbPayload], candidateTriageConfig), remaining);
      };

      try {
        const evidenceKey = buildExactEvidenceKey({
          nzbPayload,
          triageConfig,
          requestedEpisode: options.requestedEpisode || null,
          isSeasonPack: candidate.result?.isSeasonPack === true,
        });
        const evidenceResult = await runWithExactHealthEvidence(evidenceKey, async () => {
          const summary = await triageTask();
          const firstDecision = summary?.decisions?.[0];
          return firstDecision ? summarizeDecision(firstDecision) : null;
        });
        if (evidenceResult.value) {
          const summarized = evidenceResult.value;
          summarized.healthEvidenceSource = evidenceResult.source;
          summarized.healthEvidenceAgeMs = evidenceResult.ageMs;
          if (evidenceResult.source !== 'live') {
            logEvent(logger, 'info', `Health evidence:${evidenceResult.source}-hit`, {
              indexerId: candidate.indexerId,
              indexerName: candidate.indexerName,
              title: candidate.title,
              ageMs: evidenceResult.ageMs,
            });
          }
          if (captureNzbPayloads && summarized.status === 'verified') {
            summarized.nzbPayload = nzbPayload;
          }
          const finalDecision = attachMetadata(downloadUrl, summarized);
          decisionMap.set(downloadUrl, finalDecision);
          evaluatedCount += 1;
          if (onDecisionCb) try { onDecisionCb(downloadUrl, finalDecision); } catch { /* ignore */ }
          publishVerifiedWinner(candidate, finalDecision);
        } else {
          const noResultDecision = attachMetadata(downloadUrl, {
            status: 'error',
            blockers: ['triage-error'],
            warnings: ['No decision returned'],
            archiveFindings: [],
            nzbIndex: null,
            fileCount: null,
          });
          decisionMap.set(downloadUrl, noResultDecision);
          if (onDecisionCb) try { onDecisionCb(downloadUrl, noResultDecision); } catch { /* ignore */ }
        }
      } catch (err) {
        if (err?.code === TIMEOUT_ERROR_CODE) {
          timedOut = true;
          const toDecision = makeTimeoutDecision(downloadUrl);
          decisionMap.set(downloadUrl, toDecision);
          if (onDecisionCb) try { onDecisionCb(downloadUrl, toDecision); } catch { /* ignore */ }
        } else {
          const errDecision = attachMetadata(downloadUrl, {
            status: 'error',
            blockers: ['triage-error'],
            warnings: err?.message ? [err.message] : [],
            archiveFindings: [],
            nzbIndex: null,
            fileCount: null,
          });
          decisionMap.set(downloadUrl, errDecision);
          if (onDecisionCb) try { onDecisionCb(downloadUrl, errDecision); } catch { /* ignore */ }
        }
        logEvent(logger, 'warn', 'NZB triage failed', { message: err?.message });
      }
    }
  });

  const workersDone = Promise.all(workers).then(
    () => ({ reason: 'complete' }),
    (error) => {
      logEvent(logger, 'warn', 'Racing ladder worker failed', { message: error?.message || error });
      return { reason: 'worker-error' };
    },
  );
  let ladderExit = { reason: 'complete' };
  if (returnOnFirstVerified) {
    ladderExit = await Promise.race([
      workersDone,
      verifiedWinnerPromise.then((winner) => ({ reason: 'verified-winner', winner })),
    ]);
  } else {
    ladderExit = await workersDone;
  }

  selectedCandidates.forEach((candidate) => {
    if (!decisionMap.has(candidate.downloadUrl)) {
      decisionMap.set(candidate.downloadUrl, attachMetadata(candidate.downloadUrl, {
        status: timedOut || ladderExit.reason === 'verified-winner' ? 'pending' : 'skipped',
        blockers: [],
        warnings: [],
        archiveFindings: [],
        nzbIndex: null,
        fileCount: null,
      }));
    }
  });

  // In-flight hedged checks may finish after a verified winner releases the
  // blocking request. Return an immutable snapshot; late work only warms the
  // exact-evidence/payload caches and cannot mutate the response in flight.
  const returnedDecisionMap = new Map(decisionMap);

  return {
    decisions: returnedDecisionMap,
    elapsedMs: Date.now() - startTs,
    timedOut,
    candidatesConsidered: selectedCandidates.length,
    evaluatedCount,
    fetchFailures,
    summary: null,
    racingLadder: {
      enabled: returnOnFirstVerified,
      hedgeDelayMs,
      reason: ladderExit.reason,
      winner: ladderExit.winner || verifiedWinner,
    },
  };
}

module.exports = {
  triageAndRank,
  runWithIndexerSerialization,
  runNzbDownloadSingleFlight,
};
