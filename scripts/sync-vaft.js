#!/usr/bin/env node
/**
 * Download upstream VAFT from TwitchAdSolutions and write src/core/vaft.js
 * (userscript header stripped), then apply the ReYohoho local patches.
 *
 * The patches live HERE (not as manual edits in vaft.js) so that re-running
 * this script keeps them — running it always regenerates vaft.js as
 * "upstream + ReYohoho patches". If an anchor stops matching after an
 * upstream change, the script throws so the patch can be updated.
 *
 * ReYohoho patches:
 *   1. Add 'picture-by-picture' (pbp) to BackupPlayerTypes — an ad-free
 *      mini-player stream (capped at 360p) used ONLY during ad breaks as a
 *      fallback after the full-quality Source-tier backups. The main stream
 *      stays at full quality; VAFT swaps to a clean backup during an ad and
 *      auto-recovers when the ad clears (its native behaviour).
 *   2. Stall-recovery watchdog: forces a reload when the playhead freezes with
 *      a drained buffer (black screen + Play button after a contaminated ad
 *      break), with verbose [ReYohoho WD] diagnostics.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'core', 'vaft.js');
const URL = 'https://github.com/ryanbr/TwitchAdSolutions/raw/refs/heads/master/vaft/vaft.user.js';

function fetch(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetch(res.headers.location).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject);
    });
}

function stripUserscriptHeader(raw) {
    const lines = raw.split('\n');
    if (!lines[0].includes('UserScript')) {
        return raw.trim() + '\n';
    }
    const end = lines.findIndex((l) => l.includes('==/UserScript=='));
    if (end === -1) {
        throw new Error('Malformed userscript: missing ==/UserScript==');
    }
    let start = end + 1;
    while (start < lines.length && lines[start].trim() === '') start++;
    return lines.slice(start).join('\n').trim() + '\n';
}

// Replace exactly one occurrence of `find` (a literal string) with `repl`.
// Throws if the anchor is missing or not unique so patches fail loudly.
function replaceOnce(code, find, repl, name) {
    const idx = code.indexOf(find);
    if (idx === -1) {
        throw new Error(`ReYohoho patch anchor NOT FOUND: ${name}`);
    }
    if (code.indexOf(find, idx + find.length) !== -1) {
        throw new Error(`ReYohoho patch anchor NOT UNIQUE: ${name}`);
    }
    return code.slice(0, idx) + repl + code.slice(idx + find.length);
}

// Stall-recovery watchdog, inserted just before the hooks are installed.
// Uses only single-quoted strings / concatenation (no backticks or ${}) so it
// can live inside this template literal unescaped.
const STALL_WATCHDOG = `    // === ReYohoho: stall-recovery watchdog + verbose diagnostics ===
    // Backup-swap during a heavily-contaminated ad break can leave the player
    // stalled at the buffer end (all playable segments consumed, no recovery),
    // showing a black screen + Play button. VAFT's buffer monitor skips the
    // paused state, so this watchdog catches a frozen playhead with a drained
    // buffer and forces a recovery reload. Verbose by default for debugging.
    // Toggles: reyohoho_stall_watchdog=false, reyohoho_stall_verbose=false,
    // reyohoho_stall_seconds=<n>, reyohoho_stall_hard=false.
    (function reyohohoStallWatchdog() {
        var enabled = true, verbose = true, hardReload = true;
        try { enabled = localStorage.getItem('reyohoho_stall_watchdog') !== 'false'; } catch (e) {}
        try { verbose = localStorage.getItem('reyohoho_stall_verbose') !== 'false'; } catch (e) {}
        try { hardReload = localStorage.getItem('reyohoho_stall_hard') !== 'false'; } catch (e) {}
        if (!enabled) return;
        var STALL_SECONDS = 8;// steady-playback stall threshold
        try { var sv = parseInt(localStorage.getItem('reyohoho_stall_seconds'), 10); if (!isNaN(sv) && sv >= 2) STALL_SECONDS = sv; } catch (e) {}
        var STALL_INITIAL_SECONDS = 18;// grace while not-yet-started / mid ad-break / just reloaded (backup search legitimately takes ~5-10s)
        try { var siv = parseInt(localStorage.getItem('reyohoho_stall_initial_seconds'), 10); if (!isNaN(siv) && siv >= 5) STALL_INITIAL_SECONDS = siv; } catch (e) {}
        var POLL_MS = 1000;
        var RECOVERY_COOLDOWN_MS = 15000;
        var MAX_RECOVERIES = 6;
        var RECOVERY_WINDOW_MS = 5 * 60 * 1000;
        var lastTime = -1;
        var frozenSinceTs = 0;
        var lastLogTs = 0;
        var lastRecoveryTs = 0;
        var recoveryTimes = [];
        var everPlayed = false;// has the stream ever advanced this session (vs a never-started black screen)
        var lastChannel = null;
        function currentChannelKey() {
            try {
                var p = (location.pathname || '').split('?')[0].split('#')[0];
                var seg = p.split('/')[1] || null;
                return seg ? seg.toLowerCase() : null;
            } catch (e) { return null; }
        }
        function ctx() {
            var ps = (typeof getPlayerAndState === 'function') ? getPlayerAndState() : null;
            var player = ps && ps.player;
            var video = player && player.getHTMLVideoElement ? player.getHTMLVideoElement() : null;
            return { ps: ps, player: player, video: video };
        }
        function isLive(ps) {
            try { return !!(ps && ps.state && ps.state.props && ps.state.props.content && ps.state.props.content.type === 'live'); } catch (e) { return false; }
        }
        function snap(reason, c) {
            try {
                var video = c.video, player = c.player;
                var bufEnd = (video && video.buffered && video.buffered.length) ? video.buffered.end(video.buffered.length - 1) : 0;
                var ct = video ? video.currentTime : 0;
                console.log('[ReYohoho WD] ' + reason
                    + ' | t=' + ct.toFixed(2)
                    + ' bufEnd=' + bufEnd.toFixed(2)
                    + ' ahead=' + (bufEnd - ct).toFixed(2)
                    + ' paused=' + (video ? video.paused : '?')
                    + ' readyState=' + (video ? video.readyState : '?')
                    + ' networkState=' + (video ? video.networkState : '?')
                    + ' ended=' + (video ? video.ended : '?')
                    + ' playerState=' + (player && player.getState ? player.getState() : '?')
                    + ' inAdBreak=' + ((typeof playerBufferState !== 'undefined') ? playerBufferState.inAdBreak : '?')
                    + ' stripping=' + ((typeof isActivelyStrippingAds !== 'undefined') ? isActivelyStrippingAds : '?')
                    + ' userPause=' + ((typeof playerBufferState !== 'undefined') ? playerBufferState.userPauseIntent : '?')
                    + ' hidden=' + document.hidden);
            } catch (e) {}
        }
        function recover(c) {
            var now = Date.now();
            recoveryTimes = recoveryTimes.filter(function (t) { return now - t < RECOVERY_WINDOW_MS; });
            if (recoveryTimes.length >= MAX_RECOVERIES) {
                console.log('[ReYohoho WD] recovery SUPPRESSED — cap reached (' + recoveryTimes.length + ' in 5min); leaving player as-is');
                return;
            }
            recoveryTimes.push(now);
            lastRecoveryTs = now;
            snap('RECOVERY ' + (hardReload ? 'hard' : 'soft') + ' reload (forced)', c);
            try {
                if (typeof playerBufferState !== 'undefined') {
                    playerBufferState.userPauseIntent = false;
                    playerBufferState.loggedPauseIntent = false;
                }
                if (!c.ps || !c.ps.state) { console.log('[ReYohoho WD] recovery aborted — no player state'); return; }
                var video = c.video;
                var wasUnmuted = video && !video.muted;
                if (video && wasUnmuted) { video.muted = true; }
                c.ps.state.setSrc({ isNewMediaPlayerInstance: hardReload, refreshAccessToken: true });
                if (c.player && c.player.play) { c.player.play()?.catch?.(function () {}); }
                if (video && wasUnmuted) {
                    var done = false;
                    var restore = function () {
                        if (done) return; done = true;
                        document.removeEventListener('canplay', lis, true);
                        document.removeEventListener('playing', lis, true);
                        document.removeEventListener('loadeddata', lis, true);
                        try { var cur = document.querySelector('video'); if (cur) cur.muted = false; } catch (e) {}
                    };
                    var lis = function (e) { if (e.target && e.target.tagName === 'VIDEO') restore(); };
                    document.addEventListener('canplay', lis, true);
                    document.addEventListener('playing', lis, true);
                    document.addEventListener('loadeddata', lis, true);
                    setTimeout(restore, 4000);
                }
            } catch (e) { console.log('[ReYohoho WD] recovery error: ' + (e && e.message)); }
        }
        setInterval(function () {
            try {
                var now = Date.now();
                var c = ctx();
                if (!c.player || !c.video) { lastTime = -1; frozenSinceTs = 0; return; }
                if (!isLive(c.ps)) { lastTime = -1; frozenSinceTs = 0; return; }
                var chan = currentChannelKey();
                if (chan !== lastChannel) { lastChannel = chan; everPlayed = false; frozenSinceTs = 0; lastTime = -1; }
                var video = c.video;
                var ct = video.currentTime;
                var bufEnd = (video.buffered && video.buffered.length) ? video.buffered.end(video.buffered.length - 1) : 0;
                var ahead = bufEnd - ct;
                var advancing = (lastTime >= 0) && Math.abs(ct - lastTime) > 0.05;
                lastTime = ct;
                if (advancing || video.ended) {
                    if (advancing) everPlayed = true;
                    if (frozenSinceTs !== 0 && verbose) {
                        console.log('[ReYohoho WD] recovered (advancing) after ' + ((now - frozenSinceTs) / 1000).toFixed(1) + 's, t=' + ct.toFixed(2));
                    }
                    frozenSinceTs = 0;
                    return;
                }
                // User deliberately paused — thin live-edge buffer looks like a stall but isn't.
                if (video.paused && (typeof playerBufferState !== 'undefined') && playerBufferState.userPauseIntent) {
                    frozenSinceTs = 0;
                    return;
                }
                // Frozen playhead. Only a drained buffer counts as a real stall —
                // a user pause keeps buffered content ahead of the playhead.
                if (ahead >= 1.5) { frozenSinceTs = 0; return; }
                if (frozenSinceTs === 0) { frozenSinceTs = now; snap('freeze start (buffer drained)', c); }
                var frozenFor = (now - frozenSinceTs) / 1000;
                // Longer grace while the stream has not started yet, during an ad
                // break, or right after a reload — finding a clean backup legitimately
                // takes ~5-10s and we must not interrupt it. Short threshold applies
                // only to an unexpected stall on already-playing content.
                var inAd = (typeof playerBufferState !== 'undefined' && playerBufferState.inAdBreak) ? true : false;
                var stripping = (typeof isActivelyStrippingAds !== 'undefined' && isActivelyStrippingAds) ? true : false;
                var recentReload = (typeof playerBufferState !== 'undefined' && playerBufferState.lastReloadAt && (now - playerBufferState.lastReloadAt) < 12000) ? true : false;
                var settling = (!everPlayed) || inAd || stripping || recentReload;
                var threshold = settling ? STALL_INITIAL_SECONDS : STALL_SECONDS;
                if (verbose && now - lastLogTs >= 2000) {
                    lastLogTs = now;
                    snap('frozen ' + frozenFor.toFixed(1) + 's (need ' + threshold + 's, everPlayed=' + everPlayed + ', settling=' + settling + ')', c);
                }
                if (frozenFor >= threshold && !document.hidden && (now - lastRecoveryTs) >= RECOVERY_COOLDOWN_MS) {
                    if (video.paused && (typeof playerBufferState !== 'undefined') && playerBufferState.userPauseIntent) {
                        frozenSinceTs = 0;
                        return;
                    }
                    frozenSinceTs = 0;
                    recover(c);
                }
            } catch (e) {}
        }, POLL_MS);
        console.log('[ReYohoho WD] stall watchdog active (stall=' + STALL_SECONDS + 's, hard=' + hardReload + ', verbose=' + verbose + ')');
    })();
`;

function applyReyohohoPatches(code) {
    // Patch 1: add picture-by-picture (pbp) as an ad-break backup player type.
    // Placed AFTER the Source-tier backups so full-quality backups win first;
    // pbp is a 360p ad-free fallback tried before autoplay. VAFT's own backup
    // requests go through window.realFetch, so the upstream pbp nuke/rewrite in
    // the window fetch hook does not affect them.
    code = replaceOnce(
        code,
        "            'embed',//Source (unreliable — see note above)",
        "            'embed',//Source (unreliable — see note above)\n            'picture-by-picture',//ReYohoho: ad-free mini-player (360p) — only used during ad breaks, auto-recovers to full quality",
        'add pbp backup'
    );

    // Patch 2: insert the stall-recovery watchdog before the hooks are installed.
    code = replaceOnce(
        code,
        '    hookWindowWorker();',
        STALL_WATCHDOG + '\n    hookWindowWorker();',
        'stall watchdog insertion'
    );

    return code;
}

async function main() {
    const raw = await fetch(URL);
    const versionMatch = raw.match(/@version\s+(\S+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    const header = [
        `// Upstream TwitchAdSolutions VAFT v${version}`,
        `// Source: ${URL}`,
        '// Do not edit manually — run: node scripts/sync-vaft.js',
        '// (this file = upstream + ReYohoho patches; patches are defined in scripts/sync-vaft.js)',
        ''
    ].join('\n');
    const body = applyReyohohoPatches(stripUserscriptHeader(raw));
    fs.writeFileSync(OUT, header + body);
    console.log(`Synced VAFT v${version} (+ ReYohoho pbp-backup patch) -> ${OUT}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
