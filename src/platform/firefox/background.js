// ============================================
// ReYohoho Twitch Proxy - Firefox Background Script (MV2)
// ============================================

const api = typeof browser !== 'undefined' ? browser : chrome;

// @build-include ../core/constants.js

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

// @build-include ../core/proxy-checker.js

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
