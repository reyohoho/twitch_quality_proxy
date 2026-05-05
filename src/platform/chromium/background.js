// ============================================
// ReYohoho Twitch Proxy - Chromium Background Script (MV3)
// ============================================

// @build-include ../core/constants.js

let proxyCheckInProgress = false;
let lastCheckTime = 0;
let currentProxyUrl = null;
let proxyStatus = 'unknown';
let rulesActive = false;
let extensionEnabled = true;
let hideAudioOnlyEnabled = false;

let russiaOnlyChannelsSet = new Set();

// Load extension enabled state
async function loadExtensionState() {
    try {
        const result = await chrome.storage.local.get(['extensionEnabled', 'hideAudioOnlyEnabled']);
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

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

async function loadRussiaOnlyFromCache() {
    try {
        const r = await chrome.storage.local.get([RUSSIA_ONLY_STORAGE_KEY]);
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
        await chrome.storage.local.set({ [RUSSIA_ONLY_STORAGE_KEY]: list });
    } catch (e) {
        console.warn('[ReYohoho] Error saving russia-only cache:', e);
    }
    console.log(`[ReYohoho] russia-only refreshed from backend: ${next.size} channels${changed ? ' (changed)' : ''}`);
    if (changed && extensionEnabled && currentProxyUrl) {
        // Пересобираем DNR-правила: alternation в allow-rule изменился.
        await updateProxyRules(true, currentProxyUrl);
    }
    return changed;
}

// @build-include ../core/proxy-checker.js

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

            // usher.ttvnw.net URLs always carry a query string (token, sig,
            // ...), so an extra "&hide_audio_only=true" is always safe to
            // append. The proxy reads it before forwarding to Twitch and
            // strips audio_only entries from the master playlist.
            const hideAudioOnlyParam = hideAudioOnlyEnabled ? "&hide_audio_only=true" : "";

            const rules = [
                {
                    id: 1,
                    priority: 1,
                    action: {
                        type: "redirect",
                        redirect: {
                            regexSubstitution: proxyUrl + "\\0" + authParam + hideAudioOnlyParam,
                        },
                    },
                    condition: {
                        initiatorDomains: ["twitch.tv"],
                        regexFilter: "^https://usher\\.ttvnw\\.net/.*",
                        resourceTypes: ["xmlhttprequest", "media"]
                    }
                }
            ];

            const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const russiaOnlyArr = Array.from(russiaOnlyChannelsSet);
            const RUSSIA_ONLY_RULE_ID_BASE = 100;
            russiaOnlyArr.forEach((channel, idx) => {
                rules.push({
                    id: RUSSIA_ONLY_RULE_ID_BASE + idx,
                    priority: 100,
                    action: { type: "allow" },
                    condition: {
                        initiatorDomains: ["twitch.tv"],
                        regexFilter: `^https://usher\\.ttvnw\\.net/api/v[12]/channel/hls/${escapeRegex(channel)}\\.m3u8`,
                        resourceTypes: ["xmlhttprequest", "media"]
                    }
                });
            });

            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: existingRuleIds,
                addRules: rules,
            });
            rulesActive = true;
            console.log(`[ReYohoho] Proxy rules enabled with ${proxyUrl} (hideAudioOnly=${hideAudioOnlyEnabled}, russiaOnlyAllowed=${russiaOnlyArr.length})`);
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
    if (namespace !== 'local') return;
    if (changes.extensionEnabled) {
        extensionEnabled = changes.extensionEnabled.newValue;
        lastCheckTime = 0;
        checkAndUpdateProxy();
    }
    if (changes.hideAudioOnlyEnabled) {
        hideAudioOnlyEnabled = changes.hideAudioOnlyEnabled.newValue === true;
        // Refresh the DNR rule with the new query param. We deliberately
        // keep currentProxyUrl as-is to avoid an unnecessary proxy probe.
        if (extensionEnabled && currentProxyUrl) {
            updateProxyRules(true, currentProxyUrl);
        }
    }
});

// Navigation listener
chrome.webNavigation.onBeforeNavigate.addListener(function(details) {
    if (details.url.includes("twitch.tv")) {
        checkAndUpdateProxy();
    }
});

const RUSSIA_ONLY_ALARM = 'reyohoho-russia-only-refresh';
chrome.alarms.create(RUSSIA_ONLY_ALARM, {
    delayInMinutes: Math.max(1, Math.round(RUSSIA_ONLY_FETCH_INTERVAL / 60000)),
    periodInMinutes: Math.max(1, Math.round(RUSSIA_ONLY_FETCH_INTERVAL / 60000))
});
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RUSSIA_ONLY_ALARM) {
        refreshRussiaOnlyChannels().catch(e =>
            console.warn('[ReYohoho] russia-only periodic refresh failed:', e)
        );
    }
});

async function bootstrap() {
    await loadExtensionState();
    await loadRussiaOnlyFromCache();
    checkAndUpdateProxy();
    refreshRussiaOnlyChannels().catch(e =>
        console.warn('[ReYohoho] russia-only initial refresh failed:', e)
    );
}

chrome.runtime.onStartup.addListener(bootstrap);
chrome.runtime.onInstalled.addListener(bootstrap);

// Initialize
(async () => {
    console.log("[ReYohoho] Chromium background initialized");
    await bootstrap();
})();
