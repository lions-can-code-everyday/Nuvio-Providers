// Cineby v1.9.4 — Multi-server movie/TV + HiAnime anime dub/sub via Videasy
// v1.1.0: Add HiAnime path for anime
// v1.1.1: Fix titleScore() containment-first scoring
// v1.2.0: Route HiAnime m3u8 URLs through backend proxy (fixes web-player flash / .html segments)
// v1.2.1: Fix stream display on TV — encode quality+dub/sub into name field, remove size 'Unknown'
// v1.2.2: Fix JoJo/multi-part anime wrong episode — findHiAnimeId is now season-aware:
//         passes seasonName (e.g. "Golden Wind") as tiebreaker when multiple entries score 1.0
// v1.3.0: Route regular Videasy streams through backend videasy-proxy (fixes Android: CDN requires
//         Referer/Origin headers and returns obfuscated segment extensions causing ExoPlayer failures)
// v1.3.1: Fix JoJo S1 wrong entry — season tiebreaker now factors in episode count so entries with
//         far fewer episodes than the TMDB season cannot win over a better-populated entry
// v1.4.0: Performance — TMDB + server fetches in parallel, tighter timeouts, parallel HiAnime search
// v1.5.0: Fix icon (cineby.png added to Assets); fix manifest version; per-server stream names
// v1.6.0: Fix HiAnime title match — prefer entry whose word count equals query over shorter subsets
//         (e.g. "Hellsing Ultimate" must beat "Hellsing" when both score 1.0)
// v1.7.0: Switch backend to HTTPS via Cloudflare Tunnel (reverted in v1.8.0)
// v1.8.0: Revert to direct IP backend — tunnel was unnecessary (app allows cleartext HTTP)
// v1.8.1: Fail faster when backend decryption hangs so Nuvio provider loading is not blocked.
// v1.8.2: Try Hydrogen first; only wait for backup servers if Hydrogen fails.
// v1.8.3: Send stable episode cache key to backend for concurrent-request dedupe.
// v1.8.4: Sort highest quality first and trim subtitles to Arabic/English for faster TV picker load.
// v1.8.5: Add direct 4K stream before proxied fallback to avoid Oracle proxy bottleneck.
// v1.8.6: Make fast direct 4K the default label; keep proxied 4K as fallback.
// v1.8.7: Remove subtitles entirely to reduce picker payload and loading time.
// v1.8.8: Add Vidlink HLS fallback while Videasy source API is session-gated.
// v1.8.9: Hide fallback label source and add proxied backup for reliability.
// v1.9.0: Backend fallback exposes all available HLS quality variants.
// v1.9.1: Restore real Cineby/Videasy API through backend session proxy.
// v1.9.2: Fix stream ordering: quality first, direct before fallback, preferred server order.
// v1.9.3: Use maintained Videasy player origin for real Cineby playback headers; keep MP4 sources direct.
// v1.9.4: Use current Videasy metadata domain db.videasy.to.

var BACKEND = 'http://145.241.158.129:3113';
var VIDEASY_API = 'https://api.videasy.to';
var VIDEASY_DB = 'https://db.videasy.to/3';
var ANIME_DB = 'https://anime-db.videasy.net/api/v2/hianime';

var SERVERS = [
    { name: 'Oxygen', endpoint: 'myflixerzupcloud/sources-with-title' },
    { name: 'Hydrogen', endpoint: 'cdn/sources-with-title' },
    { name: 'Lithium', endpoint: 'moviebox/sources-with-title' },
    { name: 'Helium', endpoint: '1movies/sources-with-title' },
    { name: 'Titanium', endpoint: 'primesrcme/sources-with-title' },
];

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var PLAY_HEADERS = {
    'User-Agent': UA,
    'Referer': 'https://player.videasy.to/',
    'Origin': 'https://player.videasy.to',
};
var VIDLINK_HEADERS = {
    'User-Agent': UA,
    'Referer': 'https://vidlink.pro/',
    'Origin': 'https://vidlink.pro',
};
var SERVER_ORDER = { Hydrogen: 0, Cypher: 1, Neon: 2, Helium: 3, Vidlink: 9 };

function safeFetch(url, opts, ms) {
    ms = ms || 15000;
    var controller;
    var tid;
    try {
        controller = new AbortController();
        tid = setTimeout(function () { controller.abort(); }, ms);
    } catch (e) { controller = null; }
    var o = Object.assign({ method: 'GET' }, opts || {});
    if (controller) o.signal = controller.signal;
    return fetch(url, o)
        .then(function (r) { if (tid) clearTimeout(tid); return r; })
        .catch(function (e) { if (tid) clearTimeout(tid); throw e; });
}

async function getTmdbMeta(mediaType, tmdbId, season) {
    var url = VIDEASY_DB + '/' + mediaType + '/' + tmdbId + '?append_to_response=external_ids,genres';
    var resp = await safeFetch(url, {}, 8000);
    if (!resp.ok) throw new Error('TMDB ' + resp.status);
    var data = await resp.json();
    var title, year, imdbId, isAnime;
    if (mediaType === 'movie') {
        title = data.title;
        year = data.release_date ? new Date(data.release_date).getFullYear() : '';
    } else {
        title = data.name;
        year = data.first_air_date ? new Date(data.first_air_date).getFullYear() : '';
    }
    imdbId = (data.external_ids && data.external_ids.imdb_id) || '';
    var genres = (data.genres || []).map(function (g) { return g.id; });
    var isAnimation = genres.indexOf(16) !== -1;
    var isJapanese = data.original_language === 'ja';
    isAnime = mediaType === 'tv' && isAnimation && isJapanese;
    var seasonName = null;
    var seasonEpisodeCount = 0;
    if (season && data.seasons) {
        var seasonInt = parseInt(season, 10);
        for (var i = 0; i < data.seasons.length; i++) {
            if (data.seasons[i].season_number === seasonInt) {
                seasonName = data.seasons[i].name;
                seasonEpisodeCount = data.seasons[i].episode_count || 0;
                break;
            }
        }
    }
    return { title: title, year: year, imdbId: imdbId, isAnime: isAnime, originalTitle: data.original_name || data.original_title || '', seasonName: seasonName, seasonEpisodeCount: seasonEpisodeCount };
}

async function fetchEncrypted(serverEndpoint, params) {
    var url = VIDEASY_API + '/' + serverEndpoint +
        '?title=' + encodeURIComponent(params.title) +
        '&mediaType=' + params.mediaType +
        '&year=' + params.year +
        '&episodeId=' + (params.episodeId || '1') +
        '&seasonId=' + (params.seasonId || '1') +
        '&tmdbId=' + params.tmdbId +
        '&imdbId=' + encodeURIComponent(params.imdbId || '') +
        '&_t=' + Date.now();
    var resp = await safeFetch(url, {
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
    }, 12000);
    if (!resp.ok) throw new Error('API ' + resp.status);
    return resp.text();
}

async function decryptItems(items, tmdbId, cacheKey) {
    var resp = await safeFetch(BACKEND + '/decrypt-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items, tmdbId: String(tmdbId), cacheKey: cacheKey }),
    }, 10000);

    if (!resp.ok) {
        console.log('[Cineby] Backend returned ' + resp.status);
        return null;
    }

    var data = await resp.json();
    if (data.error) {
        console.log('[Cineby] Backend error: ' + data.error);
        return null;
    }
    return data;
}

async function fetchVidlinkFallback(params) {
    var url = BACKEND + '/vidlink-streams?tmdbId=' + encodeURIComponent(params.tmdbId) +
        '&mediaType=' + encodeURIComponent(params.mediaType) +
        '&season=' + encodeURIComponent(params.seasonId || '1') +
        '&episode=' + encodeURIComponent(params.episodeId || '1');
    var resp = await safeFetch(url, {}, 22000);
    if (!resp.ok) throw new Error('Vidlink ' + resp.status);
    return resp.json();
}

async function fetchRealBackend(params) {
    var url = BACKEND + '/real-streams?title=' + encodeURIComponent(params.title) +
        '&mediaType=' + encodeURIComponent(params.mediaType) +
        '&year=' + encodeURIComponent(params.year || '') +
        '&episodeId=' + encodeURIComponent(params.episodeId || '1') +
        '&seasonId=' + encodeURIComponent(params.seasonId || '1') +
        '&tmdbId=' + encodeURIComponent(params.tmdbId) +
        '&imdbId=' + encodeURIComponent(params.imdbId || '');
    var resp = await safeFetch(url, {}, 30000);
    if (!resp.ok) throw new Error('Real backend ' + resp.status);
    return resp.json();
}

function formatVidlinkStreams(data) {
    var sources = data.sources || [];
    var streams = [];
    for (var i = 0; i < sources.length; i++) {
        var src = sources[i];
        if (!src.url) continue;
        var quality = normalizeQuality(src.quality || 'auto');
        var proxyUrl = BACKEND + '/vidlink-proxy?url=' + encodeURIComponent(src.url);
        streams.push({
            name: 'Cineby',
            title: quality + ' [Cineby]',
            url: src.url,
            quality: quality,
            size: '',
            headers: VIDLINK_HEADERS,
            subtitles: [],
            provider: 'cineby',
        });
        streams.push({
            name: 'Cineby',
            title: quality + ' Fallback [Cineby]',
            url: proxyUrl,
            quality: quality,
            size: '',
            headers: {},
            subtitles: [],
            provider: 'cineby',
        });
    }
    streams.sort(compareStreams);
    return streams;
}

function formatRegularStreams(data) {
    var sources = data.sources || [];

    var streams = [];
    for (var j = 0; j < sources.length; j++) {
        var src = sources[j];
        if (!src.url) continue;

        var quality = normalizeQuality(src.quality);
        var serverTag = src.server ? ' [' + src.server + ']' : '';
        var proxyUrl = BACKEND + '/videasy-proxy?url=' + encodeURIComponent(src.url);
        var isHls = String(src.url).indexOf('.m3u8') !== -1;

        if (!isHls) {
            streams.push({
                name: src.server ? 'Cineby ' + src.server : 'Cineby',
                title: quality + serverTag,
                url: src.url,
                quality: quality,
                size: '',
                headers: PLAY_HEADERS,
                subtitles: [],
                provider: 'cineby',
            });
            continue;
        }

        if (quality === '4K') {
            streams.push({
                name: src.server ? 'Cineby ' + src.server : 'Cineby',
                title: quality + serverTag,
                url: src.url,
                quality: quality,
                size: '',
                headers: PLAY_HEADERS,
                subtitles: [],
                provider: 'cineby',
            });
        }

        streams.push({
            name: src.server ? 'Cineby ' + src.server : 'Cineby',
            title: quality === '4K' ? quality + ' Fallback' + serverTag : quality + serverTag,
            url: proxyUrl,
            quality: quality,
            size: '',
            headers: {},
            subtitles: [],
            provider: 'cineby',
        });
    }
    streams.sort(compareStreams);
    return streams;
}

function compareStreams(a, b) {
    var qr = qualityRank(b && b.quality) - qualityRank(a && a.quality);
    if (qr) return qr;
    var direct = directRank(b) - directRank(a);
    if (direct) return direct;
    var sr = serverRank(a) - serverRank(b);
    if (sr) return sr;
    return String(a && a.title || '').localeCompare(String(b && b.title || ''));
}

function directRank(stream) {
    return stream && stream.title && String(stream.title).indexOf('Fallback') !== -1 ? 0 : 1;
}

function serverRank(stream) {
    var title = String(stream && stream.title || '');
    var match = title.match(/\[([^\]]+)\]/);
    var name = match ? match[1] : '';
    return SERVER_ORDER.hasOwnProperty(name) ? SERVER_ORDER[name] : 99;
}

function qualityRank(q) {
    q = normalizeQuality(q);
    if (q === '4K') return 4000;
    var m = String(q || '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

function normalizeQuality(q) {
    if (!q) return 'Unknown';
    var s = String(q).toUpperCase().trim();
    if (s === '4K' || s === '2160P') return '4K';
    if (s === '1080P') return '1080p';
    if (s === '720P') return '720p';
    if (s === '480P') return '480p';
    if (s === '360P') return '360p';
    return q;
}

// ── HiAnime support ─────────────────────────────────────────────────────────

function normTitle(s) {
    return String(s || '').toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleScore(a, b) {
    var wa = normTitle(a).split(' ').filter(Boolean);
    var wb = normTitle(b).split(' ').filter(Boolean);
    var query = wa.length <= wb.length ? wa : wb;
    var result = wa.length <= wb.length ? wb : wa;
    var setResult = {};
    result.forEach(function (w) { setResult[w] = true; });
    var hits = query.filter(function (w) { return setResult[w]; }).length;
    if (hits === query.length) return 1.0;
    return hits / Math.max(wa.length, wb.length, 1);
}

async function findHiAnimeId(title, originalTitle, year, seasonName, seasonEpisodeCount) {
    var queries = [title];
    if (originalTitle && normTitle(originalTitle) !== normTitle(title)) {
        queries.push(originalTitle);
    }

    // Search all queries in parallel instead of sequentially
    var searchResults = await Promise.all(queries.map(function(q) {
        var url = ANIME_DB + '/search?q=' + encodeURIComponent(q);
        return safeFetch(url, {}, 8000)
            .then(function(resp) { return resp.ok ? resp.json() : null; })
            .then(function(data) {
                if (!data) return [];
                return (data.data && data.data.animes) || data.animes || [];
            })
            .catch(function() { return []; });
    }));

    var bestId = null;
    var bestScore = 0;
    var bestHasDub = false;
    var bestWordDiff = Infinity;
    var allResults = [];

    for (var qi = 0; qi < searchResults.length; qi++) {
        var results = searchResults[qi];
        var q = queries[qi];
        var qWords = normTitle(q).split(' ').filter(Boolean).length;
        for (var i = 0; i < results.length; i++) {
            var anime = results[i];
            var score = titleScore(anime.name, q);
            var hasDub = !!(anime.episodes && anime.episodes.dub);
            var wordDiff = Math.abs(normTitle(anime.name).split(' ').filter(Boolean).length - qWords);
            // Prefer: higher score > fewer extra words (exact length match) > has dub
            var better = score > bestScore
                || (score === bestScore && wordDiff < bestWordDiff)
                || (score === bestScore && wordDiff === bestWordDiff && hasDub && !bestHasDub);
            if (better) {
                bestScore = score;
                bestId = anime.id;
                bestHasDub = hasDub;
                bestWordDiff = wordDiff;
            }
            if (score >= 0.8) allResults.push(anime);
        }
    }

    if (bestScore < 0.4) {
        console.log('[Cineby/HiAnime] No match found (best score: ' + bestScore.toFixed(2) + ')');
        return null;
    }

    if (seasonName && allResults.length > 1) {
        var normSeason = normTitle(seasonName);
        var seasonWords = normSeason.split(' ').filter(function(w) { return w.length > 2; });
        if (seasonWords.length > 0) {
            var bestSeasonScore = -1;
            var bestSeasonId = null;
            var bestSeasonHasDub = false;
            for (var i = 0; i < allResults.length; i++) {
                var anime = allResults[i];
                var normName = normTitle(anime.name);
                var hits = 0;
                for (var w = 0; w < seasonWords.length; w++) {
                    if (normName.indexOf(seasonWords[w]) > -1) hits++;
                }
                var snScore = hits / seasonWords.length;
                if (seasonEpisodeCount > 4) {
                    var totalEps = (anime.episodes && (anime.episodes.sub || anime.episodes.dub || 0)) || 0;
                    if (totalEps > 0 && totalEps < seasonEpisodeCount * 0.5) {
                        snScore *= 0.3;
                    }
                }
                var hasDub = !!(anime.episodes && anime.episodes.dub);
                if (snScore > bestSeasonScore || (snScore === bestSeasonScore && hasDub && !bestSeasonHasDub)) {
                    bestSeasonScore = snScore;
                    bestSeasonId = anime.id;
                    bestSeasonHasDub = hasDub;
                }
            }
            if (bestSeasonScore >= 0.5 && bestSeasonId) {
                console.log('[Cineby/HiAnime] Season-name tiebreaker: "' + seasonName + '" -> ' + bestSeasonId);
                return bestSeasonId;
            }
        }
    }

    console.log('[Cineby/HiAnime] Matched: ' + bestId + ' (score: ' + bestScore.toFixed(2) + ')');
    return bestId;
}

async function getHiAnimeStreams(hiAnimeId, episodeNumber) {
    var url = VIDEASY_API + '/hianime/sources-with-id' +
        '?providerId=' + encodeURIComponent(hiAnimeId) +
        '&episodeId=' + episodeNumber +
        '&dub=true';

    var resp = await safeFetch(url, {}, 15000);
    if (!resp.ok) throw new Error('HiAnime API ' + resp.status);

    var data = await resp.json();
    var ms = data.mediaSources;
    if (!ms) throw new Error('No mediaSources in response');

    return {
        sources: ms.sources || [],
        subtitles: ms.subtitles || [],
    };
}

// ── Main getStreams ─────────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
    try {
        var mType = mediaType === 'movie' ? 'movie' : 'tv';
        var seasonId = String(parseInt(season, 10) || 1);
        var episodeId = String(parseInt(episode, 10) || 1);

        console.log('[Cineby] Fetching ' + mType + ' tmdb:' + tmdbId + (mType === 'tv' ? ' S' + seasonId + 'E' + episodeId : ''));

        // Step 1: Get TMDB metadata
        var meta = await getTmdbMeta(mType, tmdbId, mType === 'tv' ? seasonId : null);
        console.log('[Cineby] ' + meta.title + ' (' + meta.year + ')' + (meta.isAnime ? ' [ANIME]' : '') + (meta.seasonName ? ' [' + meta.seasonName + ']' : ''));

        // ── ANIME PATH ────────────────────────────────────────────────────────
        if (meta.isAnime) {
            console.log('[Cineby] Using HiAnime path for anime');
            try {
                var hiAnimeId = await findHiAnimeId(meta.title, meta.originalTitle, meta.year, meta.seasonName, meta.seasonEpisodeCount);
                if (!hiAnimeId) {
                    console.log('[Cineby] HiAnime: no match, falling back to TV path');
                } else {
                    var hiResult = await getHiAnimeStreams(hiAnimeId, episodeId);
                    var hiSources = hiResult.sources;
                    console.log('[Cineby/HiAnime] ' + hiSources.length + ' sources');

                    if (hiSources.length === 0) {
                        console.log('[Cineby] HiAnime: no sources, falling back to TV path');
                    } else {
                        var streams = [];
                        for (var j = 0; j < hiSources.length; j++) {
                            var src = hiSources[j];
                            if (!src.url) continue;

                            var qLabel = src.quality || 'Unknown';
                            var qParts = qLabel.split(' - ');
                            var res = normalizeQuality(qParts[0]);
                            var audioLabel = qParts[1] || '';
                            var displayTitle = audioLabel ? res + ' - ' + audioLabel : res;
                            var proxyUrl = BACKEND + '/hianime-proxy?url=' + encodeURIComponent(src.url);
                            var streamName = audioLabel
                                ? 'Cineby HiAnime ' + res + ' ' + audioLabel
                                : 'Cineby HiAnime ' + res;

                            streams.push({
                                name: streamName,
                                title: displayTitle + ' [HiAnime]',
                                url: proxyUrl,
                                quality: res,
                                size: '',
                                headers: {},
                                subtitles: [],
                                provider: 'cineby',
                            });
                        }

                        streams.sort(compareStreams);
                        console.log('[Cineby/HiAnime] Returning ' + streams.length + ' streams');
                        return streams;
                    }
                }
            } catch (animeErr) {
                console.log('[Cineby/HiAnime] Error: ' + animeErr.message + ' — falling back to TV path');
            }
        }

        // ── REGULAR MOVIE/TV PATH ─────────────────────────────────────────────
        var params = {
            title: meta.title,
            mediaType: mType,
            year: String(meta.year),
            tmdbId: String(tmdbId),
            imdbId: meta.imdbId,
            seasonId: seasonId,
            episodeId: episodeId,
        };
        var cacheKey = mType + ':' + tmdbId + ':' + seasonId + ':' + episodeId;

        try {
            console.log('[Cineby] Trying real Videasy session backend');
            var realData = await fetchRealBackend(params);
            if (realData && realData.sources && realData.sources.length > 0) {
                console.log('[Cineby] Real backend returned ' + realData.sources.length + ' sources from [' + (realData.servers || []).join(', ') + ']');
                return formatRegularStreams(realData);
            }
            console.log('[Cineby] Real backend returned no sources, trying direct/fallback path');
        } catch (realError) {
            console.log('[Cineby] Real backend error: ' + realError.message + ' — trying direct/fallback path');
        }

        // Step 2: Try Hydrogen first so Nuvio can show links without waiting for slow backups.
        var primaryServer = SERVERS[1] || SERVERS[0];
        var primaryItem = await fetchEncrypted(primaryServer.endpoint, params)
            .then(function (text) {
                if (!text || text.length < 10) throw new Error('Empty');
                return { server: primaryServer.name, encrypted: text };
            })
            .catch(function () { return null; });

        if (primaryItem) {
            console.log('[Cineby] Got encrypted data from primary ' + primaryServer.name);
            var primaryData = await decryptItems([primaryItem], tmdbId, cacheKey + ':' + primaryServer.name);
            if (primaryData && primaryData.sources && primaryData.sources.length > 0) {
                console.log('[Cineby] ' + primaryData.sources.length + ' sources from [' + (primaryData.servers || []).join(', ') + ']');
                var primaryStreams = formatRegularStreams(primaryData);
                console.log('[Cineby] Returning ' + primaryStreams.length + ' streams');
                return primaryStreams;
            }
            console.log('[Cineby] Primary ' + primaryServer.name + ' returned no sources, trying backups');
        }

        // Fallback: fetch encrypted sources from backup servers in parallel.
        var backupServers = SERVERS.filter(function (srv) { return srv.name !== primaryServer.name; });
        var encPromises = backupServers.map(function (srv) {
            return fetchEncrypted(srv.endpoint, params)
                .then(function (text) {
                    if (!text || text.length < 10) throw new Error('Empty');
                    return { server: srv.name, encrypted: text };
                })
                .catch(function () { return null; });
        });

        var encResults = await Promise.all(encPromises);
        var items = [];
        for (var i = 0; i < encResults.length; i++) {
            if (encResults[i]) items.push(encResults[i]);
        }

        if (items.length === 0) {
            console.log('[Cineby] No encrypted data from any server');
            try {
                console.log('[Cineby] Trying Vidlink fallback');
                var vidlinkData = await fetchVidlinkFallback(params);
                var vidlinkStreams = formatVidlinkStreams(vidlinkData);
                console.log('[Cineby] Vidlink fallback returning ' + vidlinkStreams.length + ' streams');
                return vidlinkStreams;
            } catch (fallbackError) {
                console.log('[Cineby] Vidlink fallback error: ' + fallbackError.message);
                return [];
            }
        }
        console.log('[Cineby] Got encrypted data from ' + items.length + ' servers');

        // Step 3: Send batch to Oracle backend for decryption
        var data = await decryptItems(items, tmdbId, cacheKey + ':backups');
        if (!data) {
            try {
                console.log('[Cineby] Trying Vidlink fallback after decrypt failure');
                return formatVidlinkStreams(await fetchVidlinkFallback(params));
            } catch (fallbackError) { return []; }
        }

        var sources = data.sources || [];
        console.log('[Cineby] ' + sources.length + ' sources from [' + (data.servers || []).join(', ') + ']');

        // Step 4: Format as Nuvio stream objects
        var streams = formatRegularStreams(data);

        if (streams.length === 0) {
            try {
                console.log('[Cineby] Trying Vidlink fallback after empty source list');
                streams = formatVidlinkStreams(await fetchVidlinkFallback(params));
            } catch (fallbackError) {}
        }

        console.log('[Cineby] Returning ' + streams.length + ' streams');
        return streams;
    } catch (error) {
        console.error('[Cineby] Error: ' + error.message);
        return [];
    }
}

module.exports = { getStreams };
