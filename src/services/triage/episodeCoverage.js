const path = require('path');
const { isVideoFileName, fileMatchesEpisode } = require('../../utils/parsers');
const { getEpisodeFileMatchState } = require('../../utils/episodeMatching');

const ARCHIVE_EXTENSIONS = new Set(['.rar', '.7z', '.zip']);

function fileNameOf(file) {
  return String(file?.filename || file?.subject || '');
}

function isArchive(file) {
  const name = fileNameOf(file).toLowerCase();
  const ext = path.posix.extname(name);
  return ARCHIVE_EXTENSIONS.has(ext)
    || /\.r\d{2}(?:\b|$)/i.test(name)
    || /\.part\d+\.rar(?:\b|$)/i.test(name)
    || /\.7z\.\d{3}(?:\b|$)/i.test(name);
}

function analyzeManifestEpisodeCoverage(files, options = {}) {
  if (!options.isSeasonPack) return null;
  const season = Number(options.requestedEpisode?.season);
  const episode = Number(options.requestedEpisode?.episode);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;

  const requestedEpisode = { season, episode };
  const items = (Array.isArray(files) ? files : []).map((file) => ({ file, name: fileNameOf(file) }));
  const matchingVideos = items
    .filter(({ name }) => isVideoFileName(name) && fileMatchesEpisode(name, requestedEpisode))
    .map(({ file }) => file);
  if (matchingVideos.length > 0) {
    return { status: 'confirmed', source: 'video-subject', season, episode, targetFiles: matchingVideos };
  }

  const matchingArchives = items
    .filter(({ file, name }) => isArchive(file) && fileMatchesEpisode(name, requestedEpisode))
    .map(({ file }) => file);
  if (matchingArchives.length > 0) {
    return { status: 'confirmed', source: 'archive-subject', season, episode, targetFiles: matchingArchives };
  }

  const explicitVideos = items.filter(({ name }) => (
    isVideoFileName(name) && getEpisodeFileMatchState(name, requestedEpisode) !== 'none'
  ));
  if (!items.some(({ file }) => isArchive(file)) && explicitVideos.length >= 2) {
    return { status: 'missing', source: 'video-inventory', season, episode, targetFiles: [] };
  }

  return { status: 'unknown', source: 'nzb-manifest', season, episode, targetFiles: [] };
}

module.exports = { analyzeManifestEpisodeCoverage };
