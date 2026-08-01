'use strict';

const LANGUAGE_ALIASES = {
  de: 'german', deu: 'german', ger: 'german', deutsch: 'german', german: 'german',
  en: 'english', eng: 'english', english: 'english', englisch: 'english',
  ja: 'japanese', jpn: 'japanese', japanese: 'japanese', japanisch: 'japanese',
  fr: 'french', fra: 'french', fre: 'french', french: 'french',
  es: 'spanish', spa: 'spanish', spanish: 'spanish',
};
const normal = (value) => String(value ?? '').trim().toLowerCase();
const languageNormal = (value) => LANGUAGE_ALIASES[normal(value)] || normal(value);
const streamsFrom = (value) => Array.isArray(value) ? value : [];
function stringArgs(args, start = 1) {
  return args.slice(start).flatMap((value) => Array.isArray(value) ? value : [value]).filter((value) => typeof value === 'string' && value);
}
function attributeValues(stream, attr) {
  const value = stream.attrs?.[attr];
  return Array.isArray(value) ? value : value == null ? [] : [value];
}
function filterAttribute(args, attr, normalize = normal, contains = false) {
  const streams = streamsFrom(args[0]);
  const wanted = stringArgs(args).map(normalize);
  if (!wanted.length) return streams.filter((stream) => attributeValues(stream, attr).some((value) => normal(value) && normal(value) !== 'unknown'));
  return streams.filter((stream) => attributeValues(stream, attr).some((raw) => {
    const value = normalize(raw);
    if (wanted.includes(value)) return true;
    if (!contains) return false;
    const tokens = value.split(/[(),/+]+/).map((part) => part.trim()).filter(Boolean);
    return wanted.some((needle) => tokens.includes(needle));
  }));
}
function parseSized(value, binary = true) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt])?(?:b|bps|b\/s|bit\/s)?$/i);
  if (!match) return null;
  const base = binary ? 1024 : 1000;
  const powers = { k: 1, m: 2, g: 3, t: 4 };
  return Number(match[1]) * (match[2] ? base ** powers[match[2].toLowerCase()] : 1);
}
function numericRange(args, attr, binary) {
  const min = parseSized(args[1], binary); const max = parseSized(args[2], binary);
  return streamsFrom(args[0]).filter((stream) => {
    const value = stream.attrs?.[attr];
    return typeof value === 'number' && (min === null || value >= min) && (max === null || value <= max);
  });
}

const BUILTIN_FUNCTIONS = {
  regexMatched: (args) => {
    const names = stringArgs(args).map(normal); const streams = streamsFrom(args[0]);
    return names.length ? streams.filter((stream) => stream.tags.some((tag) => names.includes(normal(tag)))) : streams.filter((stream) => stream.tags.length);
  },
  rseMatched: (args) => {
    const names = stringArgs(args).map(normal); const streams = streamsFrom(args[0]);
    return names.length ? streams.filter((stream) => stream.rseTags.some((tag) => names.includes(normal(tag)))) : streams.filter((stream) => stream.rseTags.length);
  },
  resolution: (args) => filterAttribute([args[0], ...stringArgs(args).flatMap((value) => ['4k', '2160p'].includes(normal(value)) ? ['4k', '2160p'] : [value])], 'resolution'),
  quality: (args) => filterAttribute(args, 'videoTag'),
  encode: (args) => filterAttribute(args, 'codec'),
  visualTag: (args) => filterAttribute(args, 'visualTag', normal, true),
  audioTag: (args) => filterAttribute(args, 'audioTag', normal, true),
  releaseGroup: (args) => filterAttribute(args, 'releaseGroup'),
  language: (args) => filterAttribute(args, 'language', languageNormal),
  indexer: (args) => filterAttribute(args, 'indexer'),
  size: (args) => numericRange(args, 'size', true),
  age: (args) => numericRange(args, 'age', true),
  bitrate: (args) => numericRange(args, 'bitrate', false),
  seasonPack: (args) => streamsFrom(args[0]).filter((stream) => stream.attrs?.seasonPack === true),
  packType: (args) => filterAttribute(args, 'packType'),
  negate: (args) => { const excluded = new Set(streamsFrom(args[0]).map((stream) => stream.ref)); return streamsFrom(args[1]).filter((stream) => !excluded.has(stream.ref)); },
  merge: (args) => { const seen = new Set(); return args.flatMap(streamsFrom).filter((stream) => !seen.has(stream.ref) && seen.add(stream.ref)); },
  slice: (args) => streamsFrom(args[0]).slice(Number(args[1]) || 0, args.length > 2 ? Number(args[2]) : undefined),
  count: (args) => streamsFrom(args[0]).length,
};

module.exports = { BUILTIN_FUNCTIONS, languageNormal };
