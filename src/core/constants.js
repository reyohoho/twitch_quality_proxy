// ============================================
// ReYohoho Twitch Proxy - Constants
// ============================================

const VERSION = '2.4.5';

const PROXY_SERVERS = [
    "https://proxy4.rte.net.ru/",
    "https://proxy7.rte.net.ru/",
    "https://proxy5.rte.net.ru/",
    "https://proxy6.rte.net.ru/"
];

const TEST_MODE_PARAM = "&proxymode=adblock";

const MODES = {
    OLD: 'old',      // Макс 1440p (возможна реклама)
    TEST: 'test'     // Макс 1080p (возможно без рекламы)
};

const PROXY_CHECK_TIMEOUT = 3000;
const CHECK_INTERVAL = 5000;

const RUSSIA_ONLY_ENDPOINT_PATH = 'russia-only-channels';
const RUSSIA_ONLY_STORAGE_KEY = 'russiaOnlyChannels';
const RUSSIA_ONLY_LS_KEY = 'reyohoho_russia_only_channels';
const RUSSIA_ONLY_FETCH_INTERVAL = 5 * 60 * 1000; // 5 минут
const RUSSIA_ONLY_FETCH_TIMEOUT = 4000;

function extractTwitchChannelFromUsherUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.match(/usher\.ttvnw\.net\/api\/v[12]\/channel\/hls\/([^\/.?&#]+)\.m3u8/i);
    return m ? m[1].toLowerCase() : null;
}

async function fetchRussiaOnlyChannels(servers) {
    if (!Array.isArray(servers) || servers.length === 0) return null;
    for (const base of servers) {
        const url = String(base || '').replace(/\/?$/, '/') + RUSSIA_ONLY_ENDPOINT_PATH;
        try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), RUSSIA_ONLY_FETCH_TIMEOUT);
            const res = await fetch(url, {
                method: 'GET',
                cache: 'no-store',
                mode: 'cors',
                signal: ctrl.signal
            });
            clearTimeout(tid);
            if (!res.ok) {
                console.warn(`[ReYohoho] russia-only fetch ${url} -> HTTP ${res.status}`);
                continue;
            }
            const data = await res.json();
            if (data && Array.isArray(data.channels)) {
                return data.channels
                    .map(c => String(c || '').toLowerCase().trim())
                    .filter(c => c.length > 0);
            }
            console.warn(`[ReYohoho] russia-only fetch ${url}: invalid response shape`);
        } catch (e) {
            console.warn(`[ReYohoho] russia-only fetch ${url} failed:`, e.name || e.message);
        }
    }
    return null;
}

// IRC chat WebSocket proxy
const IRC_PROXY_HOST = 'https://ext.rte.net.ru:8443';
const IRC_PROXY_TARGET_URL = 'wss://ext.rte.net.ru:8443/tw-irc-proxy';
const IRC_PROXY_SOURCE_PREFIX = 'wss://irc-ws.chat.twitch.tv';
const IRC_PROXY_CHECK_INTERVAL = 30000; // 30 seconds
const IRC_PROXY_CHECK_TIMEOUT = 3000;

// VAFT Configuration (synced with TwitchAdSolutions/vaft v65.3.0)
const VAFT_CONFIG = {
    // 'twitch-stitched' is a prefix (catches -ad / -mid / -pod / etc.). Twitch-prefixed
    // so we don't re-introduce false-positive from a bare 'stitched' substring match.
    AdSignifiers: ['stitched-ad', 'EXT-X-CUE-OUT', 'twitch-stitched', 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"'],
    AdSegmentURLPatterns: ['/adsquared/', '/_404/', '/processing'],
    ClientID: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
    // Order matters: first clean type wins. 'embed' moved to end - field-observed Twitch
    // returns GQL "server error" for embed when requested from twitch.tv origin.
    BackupPlayerTypes: ['site', 'popout', 'mobile_web', 'embed'],
    FallbackPlayerType: 'site',
    ForceAccessTokenPlayerType: 'popout',
    PreferLowQualityBackup: true,   // Hybrid safety net: append autoplay (360p) as last-resort backup + sticky CSAI escape hatch
    FastAutoplayFirstTry: false,    // Opt-in: try autoplay first when prior break committed it via escape hatch (SSAI-uniform channels)
    BackupSwapFirst: true,          // On ad detect, immediately swap to a backup player-type m3u8 (TTV-AB-style) instead of strip
    SkipPlayerReloadOnHevc: false,  // Skip reload on 2k/4k streams (avoids #4000/#3000 errors on chromium)
    AlwaysReloadPlayerOnAd: false,
    ReloadPlayerAfterAd: true,      // After the ad finishes do a player reload instead of pause/play
    ReloadCooldownSeconds: 30,      // Min seconds between reloads — breaks CSAI cascades
    DisableReloadCap: false,        // If true, buffer monitor reloads unlimited times (cascade risk)
    DriftCorrectionRate: 1.1,       // Playback rate for catching up to live edge after reload (0 = disable)
    EarlyReloadPollThreshold: 3,    // Consecutive all-stripped polls before triggering early reload (each ~2s)
    PinBackupPlayerType: true,      // Remember which backup player type worked, try it first on next break
    PlayerReloadMinimalRequestsTime: 1500,
    PlayerReloadMinimalRequestsPlayerIndex: 2,
    PlayerBufferingFix: true,
    PlayerBufferingDelay: 600,
    PlayerBufferingSameStateCount: 3,
    PlayerBufferingDangerZone: 1,
    PlayerBufferingDoPlayerReload: false,
    PlayerBufferingMinRepeatDelay: 8000,
    PlayerBufferingPrerollCheckEnabled: false,
    PlayerBufferingPrerollCheckOffset: 5,
    IsAdStrippingEnabled: true,
    StreamInfoMaxAgeMs: 30 * 60 * 1000
};

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VERSION,
        PROXY_SERVERS,
        TEST_MODE_PARAM,
        MODES,
        PROXY_CHECK_TIMEOUT,
        CHECK_INTERVAL,
        IRC_PROXY_HOST,
        IRC_PROXY_TARGET_URL,
        IRC_PROXY_SOURCE_PREFIX,
        IRC_PROXY_CHECK_INTERVAL,
        IRC_PROXY_CHECK_TIMEOUT,
        VAFT_CONFIG,
        RUSSIA_ONLY_ENDPOINT_PATH,
        RUSSIA_ONLY_STORAGE_KEY,
        RUSSIA_ONLY_LS_KEY,
        RUSSIA_ONLY_FETCH_INTERVAL,
        RUSSIA_ONLY_FETCH_TIMEOUT,
        extractTwitchChannelFromUsherUrl,
        fetchRussiaOnlyChannels
    };
}
