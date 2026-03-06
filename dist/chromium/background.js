// ============================================
// ReYohoho Twitch Proxy - Chromium Background Script (MV3)
// ============================================

// ============================================
// ReYohoho Twitch Proxy - Constants
// ============================================

const VERSION = '2.2.0';

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

// VAFT Configuration
const VAFT_CONFIG = {
    AdSignifier: 'stitched',
    ClientID: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
    BackupPlayerTypes: ['embed', 'popout', 'autoplay'],
    FallbackPlayerType: 'embed',
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




let proxyCheckInProgress = false;
let lastCheckTime = 0;
let currentProxyUrl = null;
let proxyStatus = 'unknown';
let rulesActive = false;
let extensionEnabled = true;

// Load extension enabled state
async function loadExtensionState() {
    try {
        const result = await chrome.storage.local.get(['extensionEnabled']);
        if (typeof result.extensionEnabled === 'boolean') {
            extensionEnabled = result.extensionEnabled;
        }
        console.log(`[ReYohoho] Extension enabled: ${extensionEnabled}`);
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




async function updateProxyRules(enable, proxyUrl) {
    try {
        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const existingRuleIds = existingRules.map((rule) => rule.id);

        if (enable && proxyUrl) {
            let authParam = "";

            try {
                const cookie = await chrome.cookies.get({
                    url: "https://twitch.tv",
                    name: "auth-token"
                });
                if (cookie && cookie.value) {
                    authParam = "&auth=" + cookie.value;
                    console.log("[ReYohoho] Auth token retrieved");
                }
            } catch (error) {
                console.error("[ReYohoho] Error retrieving auth token:", error);
            }

            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: existingRuleIds,
                addRules: [
                    {
                        id: 1,
                        priority: 1,
                        action: {
                            type: "redirect",
                            redirect: {
                                regexSubstitution: proxyUrl + "\\0" + authParam,
                            },
                        },
                        condition: {
                            initiatorDomains: ["twitch.tv"],
                            regexFilter: "^https://usher\\.ttvnw\\.net/.*",
                            resourceTypes: [
                                "xmlhttprequest",
                                "media"
                            ],
                        },
                    },
                ],
            });
            rulesActive = true;
            console.log(`[ReYohoho] Proxy rules enabled with ${proxyUrl}`);
        } else {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: existingRuleIds,
            });
            rulesActive = false;
            console.log("[ReYohoho] Proxy rules disabled");
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
        await updateProxyRules(false, null);
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

        if (availableProxy) {
            currentProxyUrl = availableProxy;
            await updateProxyRules(true, availableProxy);
            proxyStatus = 'active';
        } else {
            currentProxyUrl = null;
            proxyStatus = 'unavailable';
            await updateProxyRules(false, null);
        }
    } catch (error) {
        proxyStatus = 'error';
        console.error('[ReYohoho] Error in checkAndUpdateProxy:', error);
    } finally {
        proxyCheckInProgress = false;
    }
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'getProxyStatus') {
        sendResponse({
            proxyUrl: currentProxyUrl,
            status: extensionEnabled ? proxyStatus : 'disabled',
            rulesActive: rulesActive,
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
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.extensionEnabled) {
        extensionEnabled = changes.extensionEnabled.newValue;
        lastCheckTime = 0;
        checkAndUpdateProxy();
    }
});

// Navigation listener
chrome.webNavigation.onBeforeNavigate.addListener(function(details) {
    if (details.url.includes("twitch.tv")) {
        checkAndUpdateProxy();
    }
});

// Startup/Install listeners
chrome.runtime.onStartup.addListener(async () => {
    await loadExtensionState();
    checkAndUpdateProxy();
});

chrome.runtime.onInstalled.addListener(async () => {
    await loadExtensionState();
    checkAndUpdateProxy();
});

// Initialize
(async () => {
    await loadExtensionState();
    console.log("[ReYohoho] Chromium background initialized");
    checkAndUpdateProxy();
})();
