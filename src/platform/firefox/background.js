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

// Startup/Install listeners
if (api.runtime.onStartup) {
    api.runtime.onStartup.addListener(async () => {
        await loadExtensionState();
        checkAndUpdateProxy();
    });
}

if (api.runtime.onInstalled) {
    api.runtime.onInstalled.addListener(async () => {
        await loadExtensionState();
        checkAndUpdateProxy();
    });
}

// Initialize
(async () => {
    await loadExtensionState();
    console.log("[ReYohoho] Firefox background initialized");
    checkAndUpdateProxy();
})();
