// ============================================
// ReYohoho Twitch Proxy - Firefox Background Script (MV2)
// ============================================

const api = typeof browser !== 'undefined' ? browser : chrome;

// ============================================
// ReYohoho Twitch Proxy - Constants
// ============================================

const VERSION = '2.6.2';
const PROXY_SERVERS = [
    "https://proxy4.rte.net.ru/",
    "https://proxy7.rte.net.ru/",
    "https://proxy5.rte.net.ru/",
    "https://proxy6.rte.net.ru/"
];

const TEST_MODE_PARAM = "&proxymode=adblock";

// Sponsor block (shown at the top of the settings panel)
// Gated behind a backend toggle: GET {ad_enabled: bool}. On timeout, network
// error or `false` the sponsor block stays hidden (fail-closed); only an
// explicit `true` reveals it.
const TUBERNET_AD_ENABLED_URL = 'https://ext.rte.net.ru:8443/api/tubernet/ad-enabled';
const TUBERNET_AD_FETCH_TIMEOUT = 4000;

// Resolve whether the Tubernet sponsor block should be shown. Returns false on
// any failure (timeout, network error, non-OK status, malformed body) so a
// flaky/unreachable backend never surfaces the sponsor block.
async function fetchTubernetAdEnabled() {
    try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), TUBERNET_AD_FETCH_TIMEOUT);
        const res = await fetch(TUBERNET_AD_ENABLED_URL, {
            method: 'GET',
            cache: 'no-store',
            mode: 'cors',
            signal: ctrl.signal
        });
        clearTimeout(tid);
        if (!res.ok) {
            console.warn(`[ReYohoho] tubernet ad-enabled -> HTTP ${res.status}`);
            return false;
        }
        const data = await res.json();
        return data && data.ad_enabled === true;
    } catch (e) {
        console.warn('[ReYohoho] tubernet ad-enabled fetch failed:', e.name || e.message);
        return false;
    }
}

const SPONSOR_NAME = 'ТУБЕРНЕТ';
const SPONSOR_DESC = 'Доступ к любимым сервисам';
const SPONSOR_URL_CHROMIUM = 'https://chromewebstore.google.com/detail/%D1%82%D1%83%D0%B1%D0%B5%D1%80%D0%BD%D0%B5%D1%82-%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF-%D0%BA-%D0%BB%D1%8E%D0%B1%D0%B8%D0%BC%D1%8B%D0%BC/gbecllcmfddeffkfmjlndaokefpaehie';
const SPONSOR_URL_FIREFOX = 'https://addons.mozilla.org/ru/firefox/addon/tubernet/';

// Pick the sponsor link for the current browser. In the userscript build the
// same bundle runs on both Chromium and Firefox, so we detect at runtime.
function getSponsorUrl() {
    try {
        const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
        const isFirefox = /firefox/i.test(ua) || (typeof InstallTrigger !== 'undefined');
        return isFirefox ? SPONSOR_URL_FIREFOX : SPONSOR_URL_CHROMIUM;
    } catch (e) {
        return SPONSOR_URL_CHROMIUM;
    }
}

// True when running inside a browser extension that exposes runtime.getURL.
// Used to load packaged (CSP-safe) resources; false in the userscript build.
function hasExtensionRuntime() {
    try {
        const api = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime
            : (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime
            : null;
        return !!(api && typeof api.getURL === 'function');
    } catch (e) {
        return false;
    }
}

// Resolve the sponsor icon. In the extensions we load it as a packaged
// web-accessible resource via runtime.getURL — Firefox enforces the page's
// CSP on content-script-injected <img>, which blocks data: URIs, but allows
// the extension's own moz-extension:// resources. The data URI is kept as a
// fallback for the userscript build (no extension API available).
function getSponsorIcon() {
    try {
        const api = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime
            : (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime
            : null;
        if (api && typeof api.getURL === 'function') {
            return api.getURL('static/tubernet.png');
        }
    } catch (e) { /* fall through to data URI */ }
    return SPONSOR_ICON;
}

// Decode a data: URI into a Blob (used to bypass CSP in the userscript build).
function dataUriToBlob(dataUri) {
    const comma = dataUri.indexOf(',');
    const meta = dataUri.slice(0, comma);
    const b64 = dataUri.slice(comma + 1);
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

// In the userscript build the sponsor icon falls back to a data: URI, which
// Firefox blocks via the page CSP for content-injected <img>. Painting the
// decoded bitmap onto a <canvas> sidesteps img-src entirely, so swap the
// <img> for a <canvas> when no extension runtime is available.
function renderSponsorIconFallback(rootEl) {
    if (!rootEl || hasExtensionRuntime()) return;
    const img = rootEl.querySelector('.reyohoho-sponsor-icon');
    if (!img || typeof createImageBitmap !== 'function') return;
    try {
        const blob = dataUriToBlob(SPONSOR_ICON);
        createImageBitmap(blob).then((bmp) => {
            const canvas = document.createElement('canvas');
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            canvas.className = img.className;
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.drawImage(bmp, 0, 0);
            if (img.parentNode) img.parentNode.replaceChild(canvas, img);
        }).catch(() => { /* leave the (broken) img in place */ });
    } catch (e) { /* ignore */ }
}
const SPONSOR_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAA3NCSVQICAjb4U/gAAADAFBMVEVHcEwuvMK6K57KN63QObJhJk4ppKsvCgU7CTwfAABbV4suwsO7PbQhcHjyO7/DLZ2sLpiKQaOGY8XsOLffNbAw1dLJKp4rusRhSpEttr4iAwAAAAAyOIbsOLeeKo9hVI4vx8mNQqSdR7NJE2splJEtscgu09ItzM0txcexN6Yu0dAtg53MM6sunLbZPb5QlM2IWr12XraeV8bfObeVU7wrs8jpOLjnNrUx3dgx3tgrytCzVc3BR8Msuc/5Orw6lb4v0s8lSXststDxOr7aOLYvna3tPcPlNLMu1tX0NrhodcJzbsJ0bcI0o8qRU7uSWsLcP8EzosWASaU0nsN2ab8ssct+T6urSLwqx9IxfoAvlq/EScYqxc5HhLMrzNEtrsDkN7Z5cchTh8PaQ8o4nsjWRMkqrr8t09QyoMJ3a8TvObzxOLxHjsJcgcYx3tgryNhSiMUu1dQmmaAw2tayR7stzc4/iLOuR7nfP8IqydGUADpzhNTrRtSLbM+ZatRqbLmEacguqsmzS8CmUMAousuyUMavUMXmPsMt0NBDkMP1P8kszdTmP8b21rn2PL/2Or0t1tP3ObkqytMu2NQowNH2Ororz9Mt0dJHiMQv3Nkt09NUfcIpts8pw9P8Obwsrc0u2tdddsEsp8ooutD4PcQpuNCDXcB6YsBvacApsM0pxtIovc/rP8M0mcc/jsVPgcLSRMcps84x39oovtH7PcbdQsXzPcE6ncs7ksWLWL9Ci8RncMIpwtLDScYwpMqhVcYx4dsx2dIr0dWwSsOlTcI3lcUxnchXesEvoMjvPcArzdJOisbXRMa7ScSQXcZ8aMWVWcStUcYpx9Iqzde3TsdClcneR9Ax5N0zqc90ZsDjQsbMRcbJR8diesUt1NMu19fzOr2YU8FqbcBkccGfUcJtcsfmQMS+Tskr09lAmsrvQMeKXsWXVMFzbMRXgsY5o8/tRdToRdCNcNWQVsBLhMNidMIpyNOqVstJj8hKhcOZWcfGTMtdm9tui9jMT9FHcExjmNt0AAABAHRSTlMAWDBSXgEmCg4GAk5bE+44KzL+tGizIm8hRAQCGb8bBG8/WRcah9GEeUqLK0FbrNOLXs16eLenjtD7wf284f1qqBf95XM9xYDZ+5l8yeSo25e1Nqdry0iG1wtH1LBJyWvOtIjg0sad7nzm1Nmp+uzy0PQexZygUma37RT17efyRbft6++m6O3p7pHx8+v///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8A4wz1XAAAB1ZJREFUWIWdVwdYU0kQXqQkQUGK0gQUBBURC2JDPXs9e++9dz379V6/5BFKDCQQJagQiiQYFJFIrBQRQhOVEAsioCIWrHffzb60FxLK3Xxf8t7uzL9v5t+ZLQi1JIx+E+cc3rh8+fJR+xd727do1oJ0nvPr4ztl+XfvXawpKSkpGvlWFhh0tN1o+jBVXd2ds/ln1PiioiLZo6eFHwpmD2oXvKcjU5r4GOPvfaypqRkJX5fJCgsLC+odbt36vG380GhmTmLinbNlZ9aPWuzt5eW1yDto1myAnwf8s+qdB1uHm7M+k+YkPk4829+PZqCYN9Dh1K2K6jfX8wbQW8E7RoercnLqJliYUnrNeHbh+PO8d7VjWoLTbENU0hyhbb+WDFxmVD7PKy1tGGJa7ckKYTGlwoktO2htvfL5u9LarNujTWmdVOGAt20tQjzG3IYTt2PG76YZaeisECZT6NE63HKpi/2O0phUka8r2e5urdd9Bv4L+7eOhxFQN+QcJxodHKBxSKfxwPihbeHVwiD/J/UO3txL19clGgiY3D48yL4+qyKeRCqJrroxQ8JZLNt2on18x/MTFLkRkcpLZto+j5BwFcuYWFOybkD6bZ6Iz87lRBJchqazMwSQ1qU98EGVeaUwgCSBHOALbfc2YHBCO+D2WytT8mqzYuIk4EGkUqyNwA470KFt/KzTb6KOgQPjY/kJ7Ah5JBdmlRTHkPB2zMC8+mcPo14np83chtCSJuBQ0FergilI69wWfmBBxYXrKRnp83FjRVNuJIdA6IANbllABG0xQJtdX/HgeMqx0rm45SaHCMABf64zbnpADkxpHe9VcPLUg+NRx5Jnks3gJnYER4zQVMUqdQSqaHfL5ph+5iCdsHj7zfpw/hQQ+D4j3R+rnIsBz+2DVkewI6Ec8BwYJ+GUtLq6xjJYWC+WXJbdB/xDCODcBqxaXQwUckYgxpEjEVX+ZBkwjapomDDxMV7XL968efnK0/MnKy7gAJKAQZ8VbJhDTjnU85+5EQIzvAyHG2XhFCFe2OHzNy9fvnL/1UkgMCol+eqNE0NGZ/JxFpJltKJYHtoboTXGkzhYiBd2Df4Rxr+5DgFcy4rnxZFZrBxBcvFEToxFyDacKfU0wE8Uwsp+9sxd7D7+PhAA+OSkGydSebGZCqgCsRW2W1Ylx+UwLZzJ7EbFd0nD+HyIH/AQ/6nTQMD75KvXsmJS40T8plyOpgiswINe6gEM/E+TSnEAdwH/SIt/nXEOHIjnicISIAN6qC3HCZTEVJwGhgP42ds5OTl5OtF+uPLovgafQuLBAShDjriPxpIeqRvAjTqCJbK0hrxyL9LjgQAIIJ4XG5aQy+2hNexZpcQhNPdAK4u1eEwgEKBhgNsRdddYWFUpQ7tiDlhSU7vJj2T8D45fhwwiAyAd2Gyjt3AVENkwjdtDmEITq4mf7JUWn3EOHDgRDw6EFVNNenAJLiSSIyRS890YexSkjT8j+arGAQl/FdWqq5K4BBk9OFolHGYAp5V1Ag4LcQFp8JhB7EBTb6rdXoLgjiOXZOZ2ar99mTn8fTgJ+Rf1WoOHACAH+PKOFLueXIKowi8wDUI9i9YWL1zg4VlfAfn7HvgDPBmASMJXyMfp7ZAzDEBuTXhb1JfjnDL1BrOomvy8Dh8ryUxgCxBlgKlKQkx6ZBHNUm3T9m9cTz6+c0PTgf30+UlJWd/PJPFhCraSejTpKQYK1K8W/ZlpduRbt6/IDZ72ci38b0iv3YeysraguVDFUATs3Coqh30FRKhmc3WMZkrJfYH2YjDJ4kv1cXAL/HDdLoQqliTgKqRwaCkgiHJ/jTPRLCnemTq8MMfNQS+/xQ/9WYzH01RxD0MHxMO1DUc4HP4BE4oXJuuBL3G2Wg4YoNXaxOEADL+P6Fxi7yZ3S01ZeKpUUuFh9XvgN3iFZ3xap2N7mQRSMJczwp2CR71CidDh+uYwVk6OijzfjQwkWfi0Uq/0lYjCFPJdDCq+D5dQllN7pqlUa/5yQox/9uPWgr9ddFwtRQtFkkx5MBWOJl2CMqAyAjs8y5aGjpYdwpjpX1LWSEsUJ5E8MagBNA7wguEGXWgKbK92jeQh9+u1lH7r7nSJqNjMwJZeThC/7dKtKzrpB0UAabyg2Z1gUlixlUGHVXmoQCkwPlFZvKAji8ZORv2+uw3oQ2aXsrMJsauRXefJDMDnl41qrvAxbI4tBzy3Y3MrUvwa8X768ZBJpVpcR3Czs7PFpvGQy2vOwIZY84u3abW1VS+xMjtbILYyrQexw/iSoreyIIax0myJHE6nUAFuxjq9jPoI1zxZYb3DjAUulG4fsyGZxQo4FxAGFWVK5v38VlZY4AAXtMqde3b8PmbMat9NC3mxfAmsSIqIqrGtfl4tiwIL8A3vQiW+YKU33I6JSeXxRLESCZt9wKZtOBabgVurqyvVA9zIghtOKnZhiXP70GqhD5q+Jy+vtLaB9CBu9E8BS/8LXOuJ/8qAgICDk3zaNv3/8i++K68pJyXuQAAAAABJRU5ErkJggg==';

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

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VERSION,
        PROXY_SERVERS,
        TEST_MODE_PARAM,
        SPONSOR_NAME,
        SPONSOR_DESC,
        SPONSOR_URL_CHROMIUM,
        SPONSOR_URL_FIREFOX,
        TUBERNET_AD_ENABLED_URL,
        TUBERNET_AD_FETCH_TIMEOUT,
        fetchTubernetAdEnabled,
        getSponsorUrl,
        getSponsorIcon,
        hasExtensionRuntime,
        renderSponsorIconFallback,
        SPONSOR_ICON,
        MODES,
        PROXY_CHECK_TIMEOUT,
        CHECK_INTERVAL,
        IRC_PROXY_HOST,
        IRC_PROXY_TARGET_URL,
        IRC_PROXY_SOURCE_PREFIX,
        IRC_PROXY_CHECK_INTERVAL,
        IRC_PROXY_CHECK_TIMEOUT,
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
