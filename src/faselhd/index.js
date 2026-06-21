// FaselHD v16.3.3 — Server-side scraper via Oracle backend
// Backend handles: TMDB → EasyPlex → FaselHD page → VM extraction → m3u8 parsing → proxy
// Client just calls /resolve and gets back ready-to-play 1080p/720p/360p proxied streams
// v16.1.0: Switch to HTTPS tunnel (reverted in v16.2.0)
// v16.2.0: Revert to direct IP backend — tunnel was unnecessary (app allows cleartext HTTP)
// v16.3.0: Shorter client timeout; backend now caches successful resolve results.
// v16.3.1: Allow cold resolves more time; backend no longer waits for redundant subtitles.
// v16.3.2: Use HTTPS backend route for desktop/Android browser playback.
// v16.3.3: Revert DuckDNS route; use direct Oracle backend to avoid DNS/loading delay.

var BACKEND_BASE = 'http://145.241.158.129:3112';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var FETCH_TIMEOUT = 18000;

function safeFetch(url, options, timeout) {
    var ms = timeout || FETCH_TIMEOUT;
    var controller;
    var tid;
    try {
        controller = new AbortController();
        tid = setTimeout(function() { controller.abort(); }, ms);
    } catch (e) { controller = null; }
    var opts = options || {};
    if (controller) opts.signal = controller.signal;
    if (!opts.headers) opts.headers = {};
    if (!opts.headers['User-Agent']) opts.headers['User-Agent'] = UA;
    return fetch(url, opts)
        .then(function(r) { if (tid) clearTimeout(tid); return r; })
        .catch(function(e) { if (tid) clearTimeout(tid); throw e; });
}

async function getStreams(tmdbId, mediaType, season, episode) {
    var t0 = Date.now();
    var type = mediaType === 'movie' ? 'movie' : 'series';
    var idStr;
    if (type === 'movie') {
        idStr = String(tmdbId);
    } else {
        idStr = String(tmdbId) + ':' + String(season || 1) + ':' + String(episode || 1);
    }

    console.log('[FaselHD] === ' + type + '/' + idStr + ' ===');

    try {
        var url = BACKEND_BASE + '/resolve/' + type + '/' + idStr;
        var response = await safeFetch(url);

        if (!response.ok) {
            console.log('[FaselHD] Backend returned ' + response.status);
            return [];
        }

        var data = await response.json();
        var streams = data.streams || [];

        console.log('[FaselHD] === Done: ' + streams.length + ' streams in ' + (Date.now() - t0) + 'ms ===');
        return streams;
    } catch (error) {
        console.log('[FaselHD] Error: ' + error.message);
        return [];
    }
}

module.exports = { getStreams };
