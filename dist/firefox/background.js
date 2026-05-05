// ============================================
// ReYohoho Twitch Proxy - Firefox Background Script (MV2)
// ============================================

const api = typeof browser !== 'undefined' ? browser : chrome;

// ============================================
// ReYohoho Twitch Proxy - Constants
// ============================================

const VERSION = '2.4.4';

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

// VAFT Configuration
const VAFT_CONFIG = {
    AdSignifier: 'stitched',
    ClientID: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
    BackupPlayerTypes: ['site', 'popout', 'mobile_web', 'embed',],
    FallbackPlayerType: 'site',
    ForceAccessTokenPlayerType: 'popout',
    SkipPlayerReloadOnHevc: false,
    AlwaysReloadPlayerOnAd: false,
    ReloadPlayerAfterAd: true,
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
    IsAdStrippingEnabled: true
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


let currentProxyUrl = null;
let proxyCheckInProgress = false;
let lastCheckTime = 0;
let proxyListener = null;
let proxyStatus = 'unknown';
let lastInterceptTime = 0;
let interceptCount = 0;
let extensionEnabled = true;
let hideAudioOnlyEnabled = false;

let russiaOnlyChannelsSet = new Set();

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

async function loadRussiaOnlyFromCache() {
    try {
        const r = await api.storage.local.get([RUSSIA_ONLY_STORAGE_KEY]);
        const cached = r[RUSSIA_ONLY_STORAGE_KEY];
        if (Array.isArray(cached)) {
            russiaOnlyChannelsSet = new Set(cached.map(c => String(c).toLowerCase()));
            console.log(`[ReYohoho] russia-only loaded from cache: ${russiaOnlyChannelsSet.size}`);
        }
    } catch (e) {
        console.warn('[ReYohoho] Error loading russia-only cache:', e);
    }
}

async function refreshRussiaOnlyChannels() {
    const list = await fetchRussiaOnlyChannels(PROXY_SERVERS);
    if (!list) {
        console.warn('[ReYohoho] russia-only refresh: no servers responded, keeping current list');
        return false;
    }
    const next = new Set(list);
    const changed = !setsEqual(next, russiaOnlyChannelsSet);
    russiaOnlyChannelsSet = next;
    try {
        await api.storage.local.set({ [RUSSIA_ONLY_STORAGE_KEY]: list });
    } catch (e) {
        console.warn('[ReYohoho] Error saving russia-only cache:', e);
    }
    console.log(`[ReYohoho] russia-only refreshed from backend: ${next.size} channels${changed ? ' (changed)' : ''}`);
    return changed;
}

function isRussiaOnlyUsherUrlFromSet(url) {
    if (!url || russiaOnlyChannelsSet.size === 0) return false;
    const ch = extractTwitchChannelFromUsherUrl(url);
    return ch ? russiaOnlyChannelsSet.has(ch) : false;
}

// Load extension enabled state
async function loadExtensionState() {
    try {
        const result = await api.storage.local.get(['extensionEnabled', 'hideAudioOnlyEnabled']);
        if (typeof result.extensionEnabled === 'boolean') {
            extensionEnabled = result.extensionEnabled;
        }
        if (typeof result.hideAudioOnlyEnabled === 'boolean') {
            hideAudioOnlyEnabled = result.hideAudioOnlyEnabled;
        }
        console.log(`[ReYohoho] Extension enabled: ${extensionEnabled}, hideAudioOnly: ${hideAudioOnlyEnabled}`);
    } catch (e) {
        console.error('[ReYohoho] Error loading extension state:', e);
    }
}

// ============================================
// ReYohoho Twitch Proxy - Proxy Checker
// ============================================

async function checkSingleProxy(proxyUrl, timeout = PROXY_CHECK_TIMEOUT) {
    console.log(`[ReYohoho] Checking proxy: ${proxyUrl}`);
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        const checkUrl = proxyUrl + "https://google.com";
        const response = await fetch(checkUrl, {
            method: "HEAD",
            mode: "cors",
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        
        const isAvailable = response.ok;
        console.log(`[ReYohoho] Proxy ${proxyUrl} status: ${isAvailable ? "Available" : "Unavailable"} (${response.status})`);
        return isAvailable;
    } catch (error) {
        console.error(`[ReYohoho] Proxy ${proxyUrl} check failed:`, error.name, error.message);
        return false;
    }
}

async function findAvailableProxy() {
    console.log("[ReYohoho] Starting search for available proxy...");
    
    for (const proxyUrl of PROXY_SERVERS) {
        const isAvailable = await checkSingleProxy(proxyUrl);
        if (isAvailable) {
            console.log(`[ReYohoho] Found available proxy: ${proxyUrl}`);
            return proxyUrl;
        }
    }
    
    console.warn("[ReYohoho] No available proxy found");
    return null;
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { checkSingleProxy, findAvailableProxy };
}


function createProxyListener(authToken = "") {
    return function(details) {
        console.log("[ReYohoho] Proxy listener triggered for:", details.url);
        const originalUrl = details.url;

        if (isRussiaOnlyUsherUrlFromSet(originalUrl)) {
            console.log("[ReYohoho] Russia-only channel, bypassing proxy:", originalUrl);
            return {};
        }

        const proxyUrl = currentProxyUrl || PROXY_SERVERS[0];
        // Read the live toggle each time so a UI change applies on the
        // very next request without re-installing the listener.
        const hideAudioOnlyParam = hideAudioOnlyEnabled ? "&hide_audio_only=true" : "";
        const redirectUrl = proxyUrl + originalUrl + authToken + hideAudioOnlyParam;
        console.log(`[ReYohoho] Using proxy: ${proxyUrl} (hideAudioOnly=${hideAudioOnlyEnabled})`);
        
        // Track successful intercept
        lastInterceptTime = Date.now();
        interceptCount++;
        
        // Notify content scripts about the intercept
        api.tabs.query({ url: "*://*.twitch.tv/*" }).then(tabs => {
            tabs.forEach(tab => {
                api.tabs.sendMessage(tab.id, { 
                    type: 'proxyIntercept', 
                    time: lastInterceptTime,
                    count: interceptCount,
                    proxy: proxyUrl
                }).catch(() => {});
            });
        });
        
        return {
            redirectUrl: redirectUrl
        };
    };
}

async function updateProxyRules(enable) {
    console.log("[ReYohoho] Updating proxy rules, enable:", enable);
    try {
        if (proxyListener) {
            api.webRequest.onBeforeRequest.removeListener(proxyListener);
            proxyListener = null;
            console.log("[ReYohoho] Proxy listener removed");
        }

        if (enable) {
            let authToken = "";

            try {
                const cookie = await api.cookies.get({
                    url: "https://twitch.tv",
                    name: "auth-token"
                });
                if (cookie && cookie.value) {
                    authToken = "&auth=" + cookie.value;
                    console.log("[ReYohoho] Auth token retrieved");
                }
            } catch (error) {
                console.error("[ReYohoho] Error retrieving auth token:", error);
            }

            proxyListener = createProxyListener(authToken);
            api.webRequest.onBeforeRequest.addListener(
                proxyListener,
                {
                    urls: ["https://usher.ttvnw.net/*"]
                },
                ["blocking"]
            );
            console.log("[ReYohoho] Proxy listener enabled");
        }
    } catch (error) {
        console.error("[ReYohoho] Error updating proxy rules:", error);
    }
}

async function checkAndUpdateProxy() {
    if (proxyCheckInProgress) return;

    // Check if extension is disabled
    if (!extensionEnabled) {
        proxyStatus = 'disabled';
        await updateProxyRules(false);
        return;
    }

    const now = Date.now();
    if (now - lastCheckTime < CHECK_INTERVAL) {
        if (currentProxyUrl) return;
    }

    proxyCheckInProgress = true;
    lastCheckTime = now;
    proxyStatus = 'checking';

    try {
        const availableProxy = await findAvailableProxy();
        currentProxyUrl = availableProxy;
        
        if (availableProxy === null) {
            proxyStatus = 'unavailable';
            await updateProxyRules(false);
        } else {
            await updateProxyRules(true);
            proxyStatus = 'active';
        }
    } catch (error) {
        proxyStatus = 'error';
        console.error('[ReYohoho] Error in checkAndUpdateProxy:', error);
    } finally {
        proxyCheckInProgress = false;
    }
}

// Message listener
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'getProxyStatus') {
        sendResponse({
            proxyUrl: currentProxyUrl,
            status: extensionEnabled ? proxyStatus : 'disabled',
            lastInterceptTime: lastInterceptTime,
            interceptCount: interceptCount,
            extensionEnabled: extensionEnabled
        });
    } else if (message.type === 'extensionToggle') {
        extensionEnabled = message.enabled;
        lastCheckTime = 0;
        checkAndUpdateProxy();
        sendResponse({ success: true });
    }
    return true;
});

// Storage change listener
api.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;
    if (changes.extensionEnabled) {
        extensionEnabled = changes.extensionEnabled.newValue;
        lastCheckTime = 0;
        checkAndUpdateProxy();
    }
    if (changes.hideAudioOnlyEnabled) {
        hideAudioOnlyEnabled = changes.hideAudioOnlyEnabled.newValue === true;
        // No need to re-install the listener: it reads
        // hideAudioOnlyEnabled at request time.
    }
});

// Navigation listener
if (api.webNavigation) {
    api.webNavigation.onBeforeNavigate.addListener(function(details) {
        if (details.url.includes("twitch.tv")) {
            checkAndUpdateProxy();
        }
    });
}

// Request listener for twitch URLs
api.webRequest.onBeforeRequest.addListener(
    function(details) {
        checkAndUpdateProxy();
    },
    {
        urls: ["https://twitch.tv/*", "https://www.twitch.tv/*"]
    },
    []
);

setInterval(() => {
    refreshRussiaOnlyChannels().catch(e =>
        console.warn('[ReYohoho] russia-only periodic refresh failed:', e)
    );
}, RUSSIA_ONLY_FETCH_INTERVAL);

async function bootstrap() {
    await loadExtensionState();
    await loadRussiaOnlyFromCache();
    checkAndUpdateProxy();
    refreshRussiaOnlyChannels().catch(e =>
        console.warn('[ReYohoho] russia-only initial refresh failed:', e)
    );
}

// Startup/Install listeners
if (api.runtime.onStartup) {
    api.runtime.onStartup.addListener(bootstrap);
}

if (api.runtime.onInstalled) {
    api.runtime.onInstalled.addListener(bootstrap);
}

// Initialize
(async () => {
    console.log("[ReYohoho] Firefox background initialized");
    await bootstrap();
})();
