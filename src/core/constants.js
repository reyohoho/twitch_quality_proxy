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
