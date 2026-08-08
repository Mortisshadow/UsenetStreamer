'use strict';

// Two-pass ranked-rule engine adapted from Usenet Ultimate (MIT). Regex rules
// tag/score/filter first; SEL rules then score sets from the visible pool.
const crypto = require('node:crypto');
const { compile: compileSel, evaluate: evaluateSel } = require('./sel');
const { BUILTIN_FUNCTIONS } = require('./selFunctions');
const { validateSafeRegex } = require('../../utils/safeRegex');

const MAX_RULES_PER_KIND = 500;
const REGEX_BUDGET_MS = 500;
const TITLE_CAP = 1000;
const RULE_SCORE_CAP = 10_000;
const TOTAL_SCORE_CAP = 100_000;
const CACHE_LIMIT = 16;
const compileCache = new Map();

function clamp(value, limit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-limit, Math.min(limit, number));
}
function idFor(kind, index, entry) {
  return typeof entry.id === 'string' && entry.id ? entry.id : `${kind}-${index + 1}`;
}
function splitRegexLiteral(pattern, explicitFlags) {
  const literal = typeof pattern === 'string' ? pattern.match(/^\/([\s\S]*)\/([a-z]*)$/i) : null;
  const source = literal ? literal[1] : pattern;
  const flags = typeof explicitFlags === 'string' ? explicitFlags : (literal?.[2] || 'i');
  // Stateful regex flags make repeated candidate tests order-dependent.
  return { source, flags: flags.replace(/[gy]/gi, '') };
}
function normalizeRules(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const regexSource = Array.isArray(raw.rankedRegexPatterns) ? raw.rankedRegexPatterns : [];
  const selSource = Array.isArray(raw.rankedStreamExpressions) ? raw.rankedStreamExpressions : [];
  if (regexSource.length > MAX_RULES_PER_KIND || selSource.length > MAX_RULES_PER_KIND) {
    throw new Error(`At most ${MAX_RULES_PER_KIND} ranked rules per kind are allowed`);
  }
  const rankedRegexPatterns = regexSource.map((entry, index) => {
    const literal = splitRegexLiteral(typeof entry?.pattern === 'string' ? entry.pattern : '', entry?.flags);
    return {
      id: idFor('regex', index, entry || {}),
      name: typeof entry?.name === 'string' && entry.name ? entry.name : `Regex ${index + 1}`,
      pattern: literal.source,
      flags: literal.flags,
      score: clamp(entry?.score, RULE_SCORE_CAP),
      enabled: entry?.enabled !== false,
      mode: entry?.mode === 'keep' || entry?.mode === 'drop' ? entry.mode : 'score',
    };
  }).filter((entry) => entry.pattern);
  const rankedStreamExpressions = selSource.map((entry, index) => ({
    id: idFor('sel', index, entry || {}),
    name: typeof entry?.name === 'string' && entry.name ? entry.name : `SEL ${index + 1}`,
    expression: typeof entry?.expression === 'string' ? entry.expression : '',
    score: clamp(entry?.score, RULE_SCORE_CAP),
    enabled: entry?.enabled !== false,
  })).filter((entry) => entry.expression);
  return { rankedRegexPatterns, rankedStreamExpressions };
}
function parseRulesConfig(input) {
  if (input == null || input === '') return normalizeRules({});
  let parsed = input;
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Ranked rules must be a JSON object');
  const nested = parsed.config && typeof parsed.config === 'object' ? parsed.config : null;
  const source = parsed.rules || parsed.filters?.rules || parsed.filterConfig?.rules
    || nested?.rules || nested?.filters?.rules || nested?.filterConfig?.rules
    || nested || parsed;
  return normalizeRules(source);
}
function compileRules(input) {
  const rules = normalizeRules(input);
  const key = crypto.createHash('sha1').update(JSON.stringify(rules)).digest('hex');
  if (compileCache.has(key)) return compileCache.get(key);
  const errors = [];
  const regex = rules.rankedRegexPatterns.map((rule) => {
    try {
      const validationError = validateSafeRegex(rule.pattern, rule.flags || 'i');
      if (validationError) throw new Error(validationError.message);
      return { ...rule, compiled: new RegExp(rule.pattern, rule.flags || 'i') };
    }
    catch (error) { errors.push({ kind: 'regex', ruleId: rule.id, ruleName: rule.name, message: error.message }); return rule; }
  });
  const sel = rules.rankedStreamExpressions.map((rule) => {
    try { return { ...rule, compiled: compileSel(rule.expression) }; }
    catch (error) { errors.push({ kind: 'sel', ruleId: rule.id, ruleName: rule.name, message: error.message }); return rule; }
  });
  const compiled = { regex, sel, errors };
  if (compileCache.size >= CACHE_LIMIT) compileCache.delete(compileCache.keys().next().value);
  compileCache.set(key, compiled);
  return compiled;
}
function buildStreamContext(result) {
  const languages = [...(result.languages || []), ...(result.inferredLanguages || [])].filter(Boolean);
  const visualTags = Array.isArray(result.visualTags) ? result.visualTags : [];
  const hdrTags = Array.isArray(result.hdrList) ? result.hdrList : [];
  const audioTags = Array.isArray(result.audioTags) ? result.audioTags : [];
  const audioList = Array.isArray(result.audioList) ? result.audioList : [];
  const dateMs = Number.isFinite(result.publishDateMs) ? result.publishDateMs : (result.pubDate ? new Date(result.pubDate).getTime() : NaN);
  return {
    title: String(result.title || result.name || ''),
    filename: String(result.filename || result.title || result.name || ''),
    size: Number.isFinite(result.estimatedEpisodeSize) ? result.estimatedEpisodeSize : (Number.isFinite(result.size) ? result.size : 0),
    indexer: String(result.indexer || result.indexerName || ''),
    age: Number.isFinite(dateMs) ? Math.max(0, (Date.now() - dateMs) / 3_600_000) : 0,
    resolution: String(result.resolution || result.parsedFile?.resolution || ''),
    codec: String(result.encode || result.codec || result.parsedFile?.encode || ''),
    releaseGroup: String(result.group || result.releaseGroup || result.parsedFile?.releaseGroup || ''),
    visualTag: [...visualTags, ...hdrTags].filter(Boolean),
    audioTag: [...audioTags, ...audioList].filter(Boolean),
    videoTag: String(result.qualityLabel || result.source || result.parsedFile?.qualityLabel || ''),
    edition: String(result.edition || ''),
    language: languages,
    seeders: null,
    bitrate: Number.isFinite(result.bitrate) ? result.bitrate : null,
    seasonPack: result.isSeasonPack === true,
    packType: String(result.packType || ''),
  };
}
function addScore(current, delta) { return clamp(current + delta, TOTAL_SCORE_CAP); }

function applyRankedRules(results, rulesInput, context = {}) {
  if (!Array.isArray(results)) return [];
  const compiled = compileRules(rulesInput);
  if (!compiled.regex.length && !compiled.sel.length) return { results, errors: compiled.errors, active: false };
  const decorations = new Map();
  const refs = results.map((result) => {
    const decoration = { regexScore: 0, selScore: 0, totalScore: 0, tags: [], rseTags: [], matched: [], excludedBy: null };
    decorations.set(result, decoration);
    return { ref: result, attrs: buildStreamContext(result), tags: decoration.tags, rseTags: decoration.rseTags };
  });
  const hasKeep = compiled.regex.some((rule) => rule.enabled && rule.compiled && rule.mode === 'keep');
  let spentMs = 0;
  let budgetExceeded = false;
  for (const streamRef of refs) {
    const decoration = decorations.get(streamRef.ref);
    let kept = false;
    for (const rule of compiled.regex) {
      if (!rule.enabled || !rule.compiled || budgetExceeded) continue;
      const start = Date.now();
      const matched = rule.compiled.test(streamRef.attrs.title.slice(0, TITLE_CAP));
      spentMs += Date.now() - start;
      if (spentMs > REGEX_BUDGET_MS) { budgetExceeded = true; break; }
      if (!matched) continue;
      decoration.tags.push(rule.name);
      decoration.matched.push({ kind: 'regex', name: rule.name, score: rule.mode === 'score' ? rule.score : 0, mode: rule.mode });
      if (rule.mode === 'drop') { decoration.excludedBy = rule.name; break; }
      if (rule.mode === 'keep') { kept = true; continue; }
      decoration.regexScore = addScore(decoration.regexScore, rule.score);
    }
    if (!decoration.excludedBy && hasKeep && !kept) decoration.excludedBy = '(no keep match)';
  }
  const visible = refs.filter((streamRef) => !decorations.get(streamRef.ref).excludedBy);
  const constants = { queryType: context.queryType || '', isAnime: false, ...(context.constants || {}) };
  const runtimeErrors = [...compiled.errors];
  if (budgetExceeded) runtimeErrors.push({ kind: 'regex', ruleName: '(budget)', message: `Regex evaluation exceeded ${REGEX_BUDGET_MS}ms` });
  for (const rule of compiled.sel) {
    if (!rule.enabled || !rule.compiled) continue;
    let matched;
    try { matched = evaluateSel(rule.compiled, { streams: visible, constants, functions: BUILTIN_FUNCTIONS }); }
    catch (error) { runtimeErrors.push({ kind: 'sel', ruleId: rule.id, ruleName: rule.name, message: error.message }); continue; }
    if (!Array.isArray(matched)) continue;
    for (const streamRef of matched) {
      const decoration = decorations.get(streamRef?.ref);
      if (!decoration || decoration.excludedBy) continue;
      decoration.rseTags.push(rule.name);
      decoration.selScore = addScore(decoration.selScore, rule.score);
      decoration.matched.push({ kind: 'sel', name: rule.name, score: rule.score });
    }
  }
  const visibleResults = [];
  for (const result of results) {
    const decoration = decorations.get(result);
    decoration.totalScore = addScore(decoration.regexScore, decoration.selScore);
    result._rankRegexScore = decoration.regexScore;
    result._rankSeScore = decoration.selScore;
    result._rankTotalScore = decoration.totalScore;
    result._rankMatched = decoration.matched;
    result._rankRegexTags = decoration.tags;
    result._rankExcluded = Boolean(decoration.excludedBy);
    result._rankExcludedBy = decoration.excludedBy || undefined;
    if (!decoration.excludedBy) visibleResults.push(result);
  }
  return { results: visibleResults, errors: runtimeErrors, active: true };
}

module.exports = { applyRankedRules, buildStreamContext, compileRules, normalizeRules, parseRulesConfig };
