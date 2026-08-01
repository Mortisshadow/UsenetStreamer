// Pure helpers for validating episode releases and recognising season packs.
// Keep these independent from the torrent-title parser so they can be used on
// raw indexer titles before the full annotation/sort pipeline runs.

function normalizeRequestedEpisode(requestedEpisode) {
  const season = Number(requestedEpisode?.season);
  const episode = Number(requestedEpisode?.episode);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  return { season, episode };
}

function extractSeasonEpisodePairs(title) {
  const raw = String(title || '');
  const pairs = [];
  const seen = new Set();
  const add = (season, episode) => {
    const s = Number(season);
    const e = Number(episode);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    const key = `${s}:${e}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ season: s, episode: e });
  };

  // S02E05, S02.E05, S02E05E06 and S02 E05.
  for (const match of raw.matchAll(/(?:^|[^a-z0-9])s(\d{1,3})((?:[\s._-]*e\d{1,4})+)/gi)) {
    const season = Number(match[1]);
    for (const episodeMatch of match[2].matchAll(/e(\d{1,4})/gi)) {
      add(season, episodeMatch[1]);
    }
  }

  // 2x05 and 02x05.
  for (const match of raw.matchAll(/(?:^|[^a-z0-9])(\d{1,3})x(\d{1,4})(?!\d)/gi)) {
    add(match[1], match[2]);
  }

  // Anime releases also commonly omit the E token: "S2 - 07". Require a
  // visible separator and reject resolution-like suffixes such as S2-1080p.
  for (const match of raw.matchAll(/(?:^|[^a-z0-9])s(\d{1,3})[\s._–—-]+(\d{1,3})(?!\d|p\b)/gi)) {
    add(match[1], match[2]);
  }

  return pairs;
}

// Batch releases commonly encode a contiguous range rather than listing each
// episode: S02E01-E25, S02E01-25, S02E01-S02E25, or
// "Season 2 Episodes 1-25". These are multi-file/combined packs from the
// addon's perspective and may serve any requested episode inside the range.
function extractSeasonEpisodeRanges(title) {
  const raw = String(title || '');
  const ranges = [];
  const seen = new Set();
  const add = (season, startEpisode, endEpisode, endSeason = season) => {
    const s = Number(season);
    const endS = Number(endSeason);
    const a = Number(startEpisode);
    const b = Number(endEpisode);
    if (![s, endS, a, b].every(Number.isFinite) || s !== endS || a < 0 || b < 0 || a === b) return;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    const key = `${s}:${start}-${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    ranges.push({ season: s, startEpisode: start, endEpisode: end });
  };

  // S02E01-E25 / S02E01-25 / S02E01-S02E25 (also en/em dash).
  for (const match of raw.matchAll(/(?:^|[^a-z0-9])s(\d{1,3})[\s._-]*e(\d{1,4})[\s._-]*(?:to|through|[-–—])[\s._-]*(?:s(\d{1,3})[\s._-]*)?e?(\d{1,4})(?!\d)/gi)) {
    add(match[1], match[2], match[4], match[3] || match[1]);
  }

  // S02 Episodes 01-25 / Season 2 Ep 1 through 25.
  for (const match of raw.matchAll(/(?:^|[^a-z0-9])(?:s|season[\s._-]*)(\d{1,3})[\s._-]*(?:episodes?|eps?)[\s._-]*(\d{1,4})[\s._-]*(?:to|through|[-–—])[\s._-]*(\d{1,4})(?!\d)/gi)) {
    add(match[1], match[2], match[3]);
  }

  // Anime batches often use a tilde and omit E: S2 - 00~25.
  for (const match of raw.matchAll(/(?:^|[^a-z0-9])s(\d{1,3})[\s._–—-]+(\d{1,3})\s*~\s*(\d{1,3})(?!\d)/gi)) {
    add(match[1], match[2], match[3]);
  }

  return ranges;
}

function getEpisodeMatchState(title, requestedEpisode, metadata = null) {
  const requested = normalizeRequestedEpisode(requestedEpisode);
  if (!requested) return 'none';

  const ranges = extractSeasonEpisodeRanges(title);
  if (ranges.length > 0) {
    return ranges.some((range) => range.season === requested.season
      && requested.episode >= range.startEpisode
      && requested.episode <= range.endEpisode)
      ? 'exact'
      : 'mismatch';
  }

  const pairs = extractSeasonEpisodePairs(title);
  const parsedSeason = Number(metadata?.season);
  const parsedEpisode = Number(metadata?.episode);
  if (Number.isFinite(parsedSeason) && Number.isFinite(parsedEpisode)) {
    pairs.push({ season: parsedSeason, episode: parsedEpisode });
  }
  if (pairs.length === 0) return 'none';
  return pairs.some((pair) => pair.season === requested.season && pair.episode === requested.episode)
    ? 'exact'
    : 'mismatch';
}

// Playback file selection must be stricter than release-title matching. A
// release called S02E01-E25 can be a useful pack candidate, but a single video
// file with that name is not necessarily seekable to E07. Only explicit
// episode tokens make an inner video file an exact match.
function getEpisodeFileMatchState(fileName, requestedEpisode) {
  const requested = normalizeRequestedEpisode(requestedEpisode);
  if (!requested) return 'none';

  const pairs = extractSeasonEpisodePairs(fileName);
  if (pairs.length === 0) return 'none';
  return pairs.some((pair) => pair.season === requested.season && pair.episode === requested.episode)
    ? 'exact'
    : 'mismatch';
}

function extractSeasonTokens(title) {
  const raw = String(title || '');
  const seasons = new Set();
  for (const match of raw.matchAll(/(?:^|[^a-z0-9])s(\d{1,3})(?![a-z0-9])/gi)) {
    seasons.add(Number(match[1]));
  }
  for (const match of raw.matchAll(/\bseason[\s._-]*(\d{1,3})\b/gi)) {
    seasons.add(Number(match[1]));
  }
  return [...seasons].filter(Number.isFinite);
}

function rangeContainsSeason(title, requestedSeason) {
  const raw = String(title || '');
  const rangePatterns = [
    /(?:^|[^a-z0-9])s(\d{1,3})[\s._-]*(?:to|through|-)[\s._-]*s?(\d{1,3})(?![a-z0-9])/gi,
    /\bseasons?[\s._-]*(\d{1,3})[\s._-]*(?:to|through|-)[\s._-]*(\d{1,3})\b/gi,
  ];
  for (const pattern of rangePatterns) {
    for (const match of raw.matchAll(pattern)) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (Math.min(start, end) <= requestedSeason && requestedSeason <= Math.max(start, end)) {
        return true;
      }
    }
  }
  return false;
}

function getSeasonMatchState(title, requestedSeason) {
  const season = Number(requestedSeason);
  if (!Number.isFinite(season)) return 'none';
  const raw = String(title || '');
  if (rangeContainsSeason(raw, season)) return 'exact';
  const seasonTokens = extractSeasonTokens(raw);
  if (seasonTokens.length === 0) return 'none';
  return seasonTokens.includes(season) ? 'exact' : 'mismatch';
}

function titleContainsSeasonPack(title, requestedSeason, requestedEpisode = null) {
  const season = Number(requestedSeason);
  if (!Number.isFinite(season)) return false;
  const raw = String(title || '');

  const episode = Number(requestedEpisode);
  const episodeRanges = extractSeasonEpisodeRanges(raw);
  if (episodeRanges.length > 0) {
    return episodeRanges.some((range) => range.season === season
      && (!Number.isFinite(episode)
        || (episode >= range.startEpisode && episode <= range.endEpisode)));
  }

  // A release carrying an episode marker is an episode/multi-episode release,
  // not a season pack. It must go through exact episode validation instead.
  if (extractSeasonEpisodePairs(raw).length > 0) return false;
  if (rangeContainsSeason(raw, season)) return true;

  const seasonTokens = extractSeasonTokens(raw);
  if (seasonTokens.includes(season)) return true;

  // "Complete Series"-style packs without explicit season tokens cover the
  // requested season. If another explicit season is present, do not let the
  // generic keyword override that contradiction.
  const completeSeries = /\b(complete[\s._-]*(?:series|collection|seasons?)|all[\s._-]*seasons|full[\s._-]*series|box[\s._-]*set|anthology)\b/i.test(raw);
  return completeSeries && seasonTokens.length === 0;
}

module.exports = {
  extractSeasonEpisodePairs,
  extractSeasonEpisodeRanges,
  getEpisodeMatchState,
  getEpisodeFileMatchState,
  getSeasonMatchState,
  titleContainsSeasonPack,
};
