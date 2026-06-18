// ============================================
// IRC WS Proxy bootstrap (injected into MAIN world)
// Must run before any Twitch script creates a WebSocket
// ============================================
(function injectIrcWsProxy() {
    try {
        const script = document.createElement('script');
        script.textContent = `// ============================================
// ReYohoho Twitch Proxy - IRC WebSocket URL Rewriter
// Runs in page MAIN world before any Twitch script,
// because Chrome's declarativeNetRequest cannot perform
// cross-origin redirects for WebSocket requests.
// ============================================

(function () {
    'use strict';

    const SOURCE_PREFIX = 'wss://irc-ws.chat.twitch.tv';
    const TARGET_URL = 'wss://ext.rte.net.ru:8443/tw-irc-proxy';
    const DROP_EVENT = 'reyohoho-irc-proxy-drop';

    // Opt-out flag: defaults to \`true\` when missing/unreadable. Used by
    // the master extension switch and the cached availability probe.
    function readOptOutFlag(key) {
        try {
            return localStorage.getItem(key) !== 'false';
        } catch (e) {
            return true;
        }
    }

    // Opt-in flag: only the literal string \`'true'\` counts as enabled.
    // Used by the IRC-specific user toggle so a fresh install starts
    // with the IRC rewrite OFF until the user explicitly turns it on.
    function readOptInFlag(key) {
        try {
            return localStorage.getItem(key) === 'true';
        } catch (e) {
            return false;
        }
    }

    function isMasterEnabled() {
        return readOptOutFlag('reyohoho_enabled');
    }

    // Re-evaluated for every WebSocket construction so toggling either flag
    // (user setting or cached availability) takes effect on the next
    // (re)connect without a full page reload.
    function shouldRewriteNow() {
        if (!readOptOutFlag('reyohoho_enabled')) return false;
        if (!readOptInFlag('reyohoho_irc_proxy_enabled')) return false;
        if (!readOptOutFlag('reyohoho_irc_proxy_available')) return false;
        return true;
    }

    // If the master switch is off there's nothing to wire up; turning it
    // back on requires a reload (handled by the content script) anyway.
    if (!isMasterEnabled()) {
        return;
    }

    const OriginalWebSocket = window.WebSocket;
    if (!OriginalWebSocket || OriginalWebSocket.__reyohohoPatched) {
        return;
    }

    // Track every IRC WebSocket we've seen (proxied OR direct) so we can
    // close them on demand when the proxy state changes. Twitch's chat
    // client reconnects after a close, and the new socket gets routed
    // based on the freshly-read flags.
    const trackedSockets = new Set();

    function trackIrcSocket(ws) {
        trackedSockets.add(ws);
        const cleanup = () => trackedSockets.delete(ws);
        try {
            ws.addEventListener('close', cleanup);
            ws.addEventListener('error', cleanup);
        } catch (e) {}
    }

    function dropTrackedSockets(reason) {
        if (trackedSockets.size === 0) return;
        const sockets = Array.from(trackedSockets);
        trackedSockets.clear();
        console.log('[ReYohoho] Dropping', sockets.length, 'IRC WebSocket(s) for reconnect (reason:', reason, ')');
        for (const ws of sockets) {
            try {
                // 1000 = normal closure; reason string is ignored by Twitch
                // but useful when watching DevTools.
                ws.close(1000, 'reyohoho-reconnect');
            } catch (e) {}
        }
    }

    // Returns { url, isIrc } describing how the new socket should be opened.
    function resolveTarget(url) {
        try {
            const urlStr = typeof url === 'string' ? url : String(url);
            if (urlStr.indexOf(SOURCE_PREFIX) === 0) {
                if (shouldRewriteNow()) {
                    console.log('[ReYohoho] IRC WS rewrite:', urlStr, '->', TARGET_URL);
                    return { url: TARGET_URL, isIrc: true };
                }
                console.log('[ReYohoho] IRC WS direct (proxy disabled/unavailable):', urlStr);
                return { url: url, isIrc: true };
            }
        } catch (e) {
            console.error('[ReYohoho] IRC WS resolve error:', e);
        }
        return { url: url, isIrc: false };
    }

    function PatchedWebSocket(url, protocols) {
        const target = resolveTarget(url);
        const ws = protocols === undefined
            ? new OriginalWebSocket(target.url)
            : new OriginalWebSocket(target.url, protocols);
        if (target.isIrc) {
            trackIrcSocket(ws);
        }
        return ws;
    }

    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
    PatchedWebSocket.__reyohohoPatched = true;

    try {
        Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
    } catch (e) {}

    try {
        Object.defineProperty(window, 'WebSocket', {
            value: PatchedWebSocket,
            writable: true,
            configurable: true
        });
    } catch (e) {
        window.WebSocket = PatchedWebSocket;
    }

    // Bridge: the content script (isolated world / userscript MAIN world)
    // dispatches this CustomEvent on \`window\` whenever the IRC proxy
    // toggle or cached availability changes. We close every tracked
    // IRC socket so Twitch's reconnect logic kicks in and the freshly
    // constructed socket reads the updated flags.
    //
    // Reading \`e.detail.reason\` is wrapped in try/catch because in
    // Firefox content scripts, the detail object lives in a different
    // security compartment and may throw "Permission denied" if it
    // wasn't \`cloneInto()\`d before dispatch. Either way we still drop.
    window.addEventListener(DROP_EVENT, (e) => {
        let reason = 'state-change';
        try {
            if (e && e.detail && typeof e.detail.reason === 'string') {
                reason = e.detail.reason;
            }
        } catch (err) {}
        dropTrackedSockets(reason);
    });

    console.log('[ReYohoho] IRC WebSocket wrapper installed');
})();
`;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
    } catch (e) {
        console.error('[ReYohoho] Failed to inject IRC WS proxy:', e);
    }
})();

// ============================================
// ReYohoho Twitch Proxy - Content Script
// ============================================

// ============================================
// ReYohoho Twitch Proxy - Constants
// ============================================

const VERSION = '2.6.1';
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



// ============================================
// ReYohoho Twitch Proxy - UI Panel
// ============================================

// @include constants.js

function getStatusText(status) {
    switch (status) {
        case 'active': return '● Активен';
        case 'ready': return '○ Готов';
        case 'checking': return '◌ Проверка...';
        case 'disabled': return '○ Выключен';
        case 'unavailable': return '✕ Недоступен';
        case 'error': return '✕ Ошибка';
        default: return '○ Ожидание';
    }
}

// Compute display state for the IRC proxy section: respects the user toggle,
// the cached availability flag, and the master extension switch.
function getIrcProxyDisplay(extensionEnabled, ircProxy) {
    const enabled = !!(ircProxy && ircProxy.enabled);
    const available = !ircProxy || ircProxy.available !== false;

    let badgeStatus;
    let badgeText;
    if (!extensionEnabled) {
        badgeStatus = 'disabled';
        badgeText = '○ Выключен';
    } else if (!enabled) {
        badgeStatus = 'disabled';
        badgeText = '○ Выключен';
    } else if (!available) {
        badgeStatus = 'unavailable';
        badgeText = '✕ Недоступен (direct)';
    } else {
        badgeStatus = 'active';
        badgeText = '● Активен';
    }

    return { enabled, available, badgeStatus, badgeText };
}

// Show/hide the sponsor block on a single panel. Kept in the DOM (toggled via
// display) so an async backend response can reveal it after injection without
// re-rendering the whole panel. Fail-closed: anything other than `true` hides.
function applyTubernetAdState(rootEl, tubernetAdEnabled) {
    if (!rootEl) return;
    const sponsor = rootEl.querySelector('.reyohoho-sponsor');
    if (sponsor) {
        sponsor.style.display = tubernetAdEnabled === true ? '' : 'none';
    }
}

function createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled) {
    const { onExtensionToggle, onVaftToggle, onIrcProxyToggle, onHideAudioOnlyToggle } = callbacks;
    const irc = getIrcProxyDisplay(extensionEnabled, ircProxy);
    const hideAudioOnlyEnabled = hideAudioOnly === true;
    const sponsorDisplay = tubernetAdEnabled === true ? '' : 'none';
    
    const panel = document.createElement('div');
    panel.className = 'reyohoho-proxy-settings';
    panel.innerHTML = `
    <div class="reyohoho-header">
      <span class="reyohoho-icon">🎬</span>
      <span class="reyohoho-title">ReYohoho Proxy <span class="reyohoho-version">v${VERSION}</span></span>
      <span class="reyohoho-proxy-status" data-status="${proxyStatus.status}">${getStatusText(proxyStatus.status)}</span>
    </div>
    <a href="${getSponsorUrl()}" target="_blank" rel="noopener noreferrer" class="reyohoho-sponsor" style="display: ${sponsorDisplay}">
      <span class="reyohoho-sponsor-label">Спонсор</span>
      <span class="reyohoho-sponsor-body">
        <img class="reyohoho-sponsor-icon" src="${getSponsorIcon()}" alt="${SPONSOR_NAME}">
        <span class="reyohoho-sponsor-text">
          <span class="reyohoho-sponsor-name">${SPONSOR_NAME}</span>
          <span class="reyohoho-sponsor-desc">${SPONSOR_DESC}</span>
        </span>
        <span class="reyohoho-sponsor-arrow">↗</span>
      </span>
    </a>
    <div class="reyohoho-section">
      <div class="reyohoho-section-header">
        <span class="reyohoho-section-title">Прокси</span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-ext-toggle" ${extensionEnabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
      <span class="reyohoho-section-desc">Перенаправление запросов через прокси-сервер</span>
    </div>
    <div class="reyohoho-section">
      <div class="reyohoho-section-header">
        <span class="reyohoho-section-title">Скрыть Audio Only</span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-audio-only-toggle" ${hideAudioOnlyEnabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
      <span class="reyohoho-section-desc">Удалять audio_only вариант из плейлиста</span>
    </div>
    <div class="reyohoho-section">
      <div class="reyohoho-section-header">
        <span class="reyohoho-section-title">IRC чат прокси</span>
        <span class="reyohoho-proxy-status reyohoho-irc-status" data-status="${irc.badgeStatus}">${irc.badgeText}</span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-irc-toggle" ${irc.enabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
      <span class="reyohoho-section-desc">Прокси для wss://irc-ws.chat.twitch.tv. Если хост недоступен — используется direct.</span>
    </div>
    <div class="reyohoho-section">
      <div class="reyohoho-section-header">
        <span class="reyohoho-section-title">VAFT Блокировщик рекламы</span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-vaft-toggle" ${vaftEnabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
      <span class="reyohoho-section-desc">Локальная блокировка через подмену потоков</span>
      
    </div>
    <div class="reyohoho-links">
      <a href="https://t.me/reyohoho_twitch_ext" target="_blank" class="reyohoho-tg-link">
        <svg class="reyohoho-tg-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
        <span>Новости</span>
      </a>
      <a href="https://boosty.to/sentryward/donate" target="_blank" class="reyohoho-donate-link">
        <span>💜</span>
        <span>Помочь проекту</span>
      </a>
    </div>
  `;

    // Extension toggle handler
    const extToggle = panel.querySelector('#reyohoho-ext-toggle');
    if (extToggle) {
        extToggle.addEventListener('change', (e) => {
            e.stopPropagation();
            if (onExtensionToggle) onExtensionToggle(e.target.checked);
        });
    }

    // IRC proxy toggle handler
    const ircToggle = panel.querySelector('#reyohoho-irc-toggle');
    if (ircToggle) {
        ircToggle.addEventListener('change', (e) => {
            e.stopPropagation();
            if (onIrcProxyToggle) onIrcProxyToggle(e.target.checked);
        });
    }

    // Audio Only hide toggle handler
    const audioOnlyToggle = panel.querySelector('#reyohoho-audio-only-toggle');
    if (audioOnlyToggle) {
        audioOnlyToggle.addEventListener('change', (e) => {
            e.stopPropagation();
            if (onHideAudioOnlyToggle) onHideAudioOnlyToggle(e.target.checked);
        });
    }

    // VAFT toggle handler
    const vaftToggle = panel.querySelector('#reyohoho-vaft-toggle');
    const vaftTestBtn = panel.querySelector('#reyohoho-vaft-test');
    
    if (vaftToggle) {
        vaftToggle.addEventListener('change', (e) => {
            e.stopPropagation();
            // Show/hide test button
            if (vaftTestBtn) {
                vaftTestBtn.style.display = e.target.checked ? 'block' : 'none';
            }
            if (onVaftToggle) onVaftToggle(e.target.checked);
        });
    }
    
    

    panel.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // Userscript fallback: render the sponsor icon via <canvas> to bypass the
    // page CSP (Firefox blocks data: <img>). No-op inside the extensions.
    renderSponsorIconFallback(panel);

    return panel;
}

// Updates all live panels. Each toggle is only touched when the caller
// passed a defined value for it — so a partial update (e.g. only the
// IRC proxy state) won't accidentally flip unrelated toggles to their
// boolean default. This guards against bugs where an `undefined`
// argument would coerce to `false` and visually animate a user-enabled
// toggle (e.g. Audio Only) into the OFF position without actually
// changing any persisted state.
function updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxy, hideAudioOnly, tubernetAdEnabled) {
    const irc = ircProxy !== undefined
        ? getIrcProxyDisplay(extensionEnabled, ircProxy)
        : null;

    document.querySelectorAll('.reyohoho-proxy-settings').forEach(panel => {
        if (typeof tubernetAdEnabled === 'boolean') {
            applyTubernetAdState(panel, tubernetAdEnabled);
        }
        const extToggle = panel.querySelector('#reyohoho-ext-toggle');
        if (extToggle && typeof extensionEnabled === 'boolean') {
            extToggle.checked = extensionEnabled;
        }
        const vaftToggle = panel.querySelector('#reyohoho-vaft-toggle');
        if (vaftToggle && typeof vaftEnabled === 'boolean') {
            vaftToggle.checked = vaftEnabled;
        }
        const ircToggle = panel.querySelector('#reyohoho-irc-toggle');
        if (ircToggle && irc) {
            ircToggle.checked = irc.enabled;
        }
        const audioOnlyToggle = panel.querySelector('#reyohoho-audio-only-toggle');
        if (audioOnlyToggle && typeof hideAudioOnly === 'boolean') {
            audioOnlyToggle.checked = hideAudioOnly;
        }
        const ircStatusEl = panel.querySelector('.reyohoho-irc-status');
        if (ircStatusEl && irc) {
            ircStatusEl.textContent = irc.badgeText;
            ircStatusEl.dataset.status = irc.badgeStatus;
        }
        const statusEl = panel.querySelector('.reyohoho-header .reyohoho-proxy-status');
        if (statusEl && proxyStatus) {
            statusEl.textContent = getStatusText(proxyStatus.status);
            statusEl.dataset.status = proxyStatus.status;
        }
    });
}

function updateProxyStatusInPanels(proxyStatus, ircProxy) {
    document.querySelectorAll('.reyohoho-proxy-settings').forEach(panel => {
        const statusEl = panel.querySelector('.reyohoho-header .reyohoho-proxy-status');
        if (statusEl) {
            statusEl.textContent = getStatusText(proxyStatus.status);
            statusEl.dataset.status = proxyStatus.status;
        }
        if (ircProxy) {
            // Re-derive against the panel's current extension toggle state.
            const extToggle = panel.querySelector('#reyohoho-ext-toggle');
            const extEnabled = extToggle ? extToggle.checked : true;
            const irc = getIrcProxyDisplay(extEnabled, ircProxy);
            const ircStatusEl = panel.querySelector('.reyohoho-irc-status');
            if (ircStatusEl) {
                ircStatusEl.textContent = irc.badgeText;
                ircStatusEl.dataset.status = irc.badgeStatus;
            }
        }
    });
}

function injectIntoElement(container, extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled) {
    if (!container || container.querySelector('.reyohoho-proxy-settings')) {
        return false;
    }

    const panel = createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled);
    container.insertBefore(panel, container.firstChild);
    return true;
}

function tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled) {
    const settingsMenu = document.querySelector('[data-a-target="player-settings-menu"]');

    if (settingsMenu && injectIntoElement(settingsMenu, extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled)) {
        console.log('[ReYohoho] Injected into player settings menu');
        return true;
    }

    return false;
}

// `getState` is invoked on every relevant mutation so the freshly
// (re)opened settings menu is rendered against the *current* state
// (extension toggle, IRC proxy on/off + availability, etc.) rather than
// the snapshot captured when this observer was first wired up. Without
// this getter, closing and reopening the player settings menu after
// flipping the IRC proxy toggle would re-inject a panel showing the
// stale pre-toggle UI.
function startObserver(getState) {
    const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;

        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldCheck = true;
                break;
            }
        }

        if (shouldCheck) {
            const s = getState();
            tryInjectSettings(
                s.extensionEnabled,
                s.vaftEnabled,
                s.proxyStatus,
                s.callbacks,
                s.ircProxy,
                s.hideAudioOnly,
                s.tubernetAdEnabled
            );
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    return observer;
}




(function() {
    'use strict';

    // Detect environment.
    //
    // Firefox userscripts (MAIN world) expose neither `browser` nor `chrome`,
    // so we MUST `typeof`-guard both sides — referencing an undeclared
    // identifier would throw `ReferenceError` in strict mode and abort the
    // entire IIFE, which is what was breaking the userscript UI.
    const isUserscript = typeof window.__REYOHOHO_USERSCRIPT__ !== 'undefined';
    const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
    const api = (typeof browser !== 'undefined')
        ? browser
        : (typeof chrome !== 'undefined' ? chrome : null);

    // Storage adapter
    const storageAdapter = isUserscript ? window.__REYOHOHO_STORAGE__ : {
        async get(keys) {
            return api.storage.local.get(keys);
        },
        async set(data) {
            return api.storage.local.set(data);
        }
    };

    // State
    let extensionEnabled = true;
    let vaftEnabled = false;
    let vaftInitialized = false;
    let ircProxyEnabled = false;
    let ircProxyAvailable = true;
    let hideAudioOnlyEnabled = false;
    let proxyStatus = { status: 'unknown' };
    // Tubernet sponsor block gate. Fail-closed: starts hidden and is only
    // revealed once the backend explicitly returns ad_enabled=true. A timeout,
    // network error or `false` keeps it hidden.
    let tubernetAdEnabled = false;

    // Check extension enabled synchronously from localStorage
    function isExtensionEnabledSync() {
        try {
            const stored = localStorage.getItem('reyohoho_enabled');
            return stored !== 'false'; // Default to true
        } catch (e) {
            return true;
        }
    }

    // Check VAFT enabled synchronously from localStorage (fallback for fast injection)
    function isVaftEnabledSync() {
        try {
            const stored = localStorage.getItem('reyohoho_vaft_enabled');
            return stored === 'true';
        } catch (e) {
            return false;
        }
    }

    // IRC chat proxy toggle. Opt-in: only `'true'` enables the rewrite,
    // everything else (missing, `'false'`, unreadable) means disabled.
    function isIrcProxyEnabledSync() {
        try {
            return localStorage.getItem('reyohoho_irc_proxy_enabled') === 'true';
        } catch (e) {
            return false;
        }
    }

    // Last known reachability of the IRC proxy host (defaults to true)
    function isIrcProxyAvailableSync() {
        try {
            return localStorage.getItem('reyohoho_irc_proxy_available') !== 'false';
        } catch (e) {
            return true;
        }
    }

    // Hide audio_only quality from the master playlist. Default is OFF
    // (audio_only stays visible like vanilla Twitch); user opts in via the
    // UI toggle. Only the literal string 'true' counts as enabled.
    function isHideAudioOnlyEnabledSync() {
        try {
            return localStorage.getItem('reyohoho_hide_audio_only') === 'true';
        } catch (e) {
            return false;
        }
    }

    // Save extension state to localStorage for sync access
    function saveExtensionToLocalStorage(enabled) {
        try {
            localStorage.setItem('reyohoho_enabled', enabled ? 'true' : 'false');
        } catch (e) {}
    }

    // Save VAFT state to localStorage for sync access
    function saveVaftToLocalStorage(enabled) {
        try {
            localStorage.setItem('reyohoho_vaft_enabled', enabled ? 'true' : 'false');
        } catch (e) {}
    }

    function saveIrcProxyEnabledToLocalStorage(enabled) {
        try {
            localStorage.setItem('reyohoho_irc_proxy_enabled', enabled ? 'true' : 'false');
        } catch (e) {}
    }

    function saveIrcProxyAvailableToLocalStorage(available) {
        try {
            localStorage.setItem('reyohoho_irc_proxy_available', available ? 'true' : 'false');
        } catch (e) {}
    }

    function saveHideAudioOnlyToLocalStorage(enabled) {
        try {
            localStorage.setItem('reyohoho_hide_audio_only', enabled ? 'true' : 'false');
        } catch (e) {}
    }

    // Inject VAFT into page context
    function injectVAFT() {
        if (vaftInitialized) return;
        
        try {
            const script = document.createElement('script');
            
            // Chromium: use external file due to CSP restrictions
            // Firefox/Userscript: use inline script
            script.textContent = `// Upstream TwitchAdSolutions VAFT v68.4.0
// Source: https://github.com/ryanbr/TwitchAdSolutions/raw/refs/heads/master/vaft/vaft.user.js
// Do not edit manually — run: node scripts/sync-vaft.js
// (this file = upstream + ReYohoho patches; patches are defined in scripts/sync-vaft.js)
(function() {
    // Skip injection in nested frames that aren't legitimate Twitch embed contexts.
    // Twitch's main channel page has 5+ hidden cross-origin iframes (auth, analytics,
    // ad SDK, etc.) and userscript managers / uBO inject into all matching ones. Each
    // becomes a racing vaft instance that fights for player control. Only the top frame
    // hosts the player on twitch.tv/CHANNEL; nested auxiliary frames are noise.
    // Allow-list for nested-frame injection: Twitch's three documented embed contexts
    // (https://dev.twitch.tv/docs/embed/video-and-clips/) — preserves Twitch streams
    // embedded on third-party sites where vaft runs in an iframe whose parent is on
    // a different origin.
    // Use window.frameElement to detect nested frames — null on top frame, the iframe
    // element on a same-origin nested frame, throws on a cross-origin nested frame.
    // More reliable than 'window !== window.top' because Tampermonkey wraps window in a
    // proxy where the strict comparison can return true even on the top frame.
    let _isNested = false;
    try { _isNested = window.frameElement !== null; } catch (_e) { _isNested = true; }
    if (_isNested) {
        const _host = document.location.hostname;
        const _isEmbedContext = _host === 'player.twitch.tv' || _host === 'embed.twitch.tv' || document.location.pathname.startsWith('/embed/');
        if (!_isEmbedContext) {
            console.log('[AD DEBUG] vaft skipped — nested frame on ' + _host + document.location.pathname + ' (not a Twitch embed). If you see this on twitch.tv/CHANNEL top frame, please report.');
            return;
        }
    }
    // Skip injection on the Twitch clip editor — clips.twitch.tv host or /<channel>/clip/<slug> path.
    // Our fetch/Worker hooks and buffer monitor are aimed at the live channel player; on the
    // clip editor's seekable preview they have no ads to act on and have caused the preview
    // to freeze when the user drags the trim range. (Sync'd with TTV-AB v6.4.9.)
    {
        const _clipHost = document.location.hostname;
        const _clipPath = document.location.pathname || '';
        if (_clipHost === 'clips.twitch.tv' || /^\\/[^/]+\\/clip\\/[^/]+/.test(_clipPath)) {
            console.log('[AD DEBUG] vaft skipped — clip editor page (' + _clipHost + _clipPath + ').');
            return;
        }
    }
    'use strict';
    const ourTwitchAdSolutionsVersion = 85;// Used to prevent conflicts with outdated versions of the scripts
    console.log('[AD DEBUG] TwitchAdSolutions vaft v' + ourTwitchAdSolutionsVersion + ' loading');
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log('[AD DEBUG] CONFLICT: vaft v' + ourTwitchAdSolutionsVersion + ' skipped — another script already active (v' + window.twitchAdSolutionsVersion + '). Remove duplicate scripts.');
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    // Configuration and state shared between window and worker scopes
    function declareOptions(scope) {
        // 'twitch-stitched' catches the twitch-stitched-* DATERANGE class family
        // (-ad, -mid, -pod, etc.) without requiring an exact -ad suffix. Twitch-
        // prefixed so we don't re-introduce the PR #120 false-positive from bare
        // 'stitched' substring match. The specific twitch-stitched-ad DATERANGE
        // marker is a subset of this prefix.
        scope.AdSignifiers = ['stitched-ad', 'EXT-X-CUE-OUT', 'twitch-stitched', 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"', 'EXT-X-DATERANGE:CLASS="twitch-trigger"'];
        // DATERANGE classes confirmed as session/source metadata over weeks of field
        // observation — surface as "candidates" otherwise. Filtered out by the candidate
        // logger so the diagnostic stays focused on genuinely new markers.
        scope.KnownNonAdSignifiers = ['twitch-session', 'twitch-stream-source', 'twitch-ad-quartile', 'twitch-assignment'];
        scope.AdSegmentURLPatterns = ['/adsquared/', '/_404/', '/processing'];
        // Precompiled regexes shared across the stripAdSegments hot path. Declared
        // here (serialized into the worker blob with declareOptions) so literals
        // inside the per-line strip loop don't recompile on every iteration — for
        // a 100-line m3u8 at ~2 polls/sec during an ad break, hoisting the URL
        // rewrite alone saves ~200 regex compilations per second.
        scope.TwitchAdUrlRewriteRegex = /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g;
        scope.UriAttributeRegex = /URI="([^"]+)"/;
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            // Order matters: first clean type wins. 'embed' moved to end — field-observed
            // Twitch returns GQL 'server error' for streamPlaybackAccessToken on embed when
            // requested from twitch.tv origin, wasting ~200-400ms per break as first-try.
            // Kept in case it ever succeeds on some channel/user combo.
            'site',//Source
            'popout',//Source
            'mobile_web',//Mobile
            'embed',//Source (unreliable — see note above)
            'picture-by-picture',//ReYohoho: ad-free mini-player (360p) — only used during ad breaks, auto-recovers to full quality
            // 'autoplay' (360p) removed: when committed as cycle backup, the player gets stuck
            // in an endless loading circle after the CSAI-only path releases the backup —
            // autoplay variants don't transition cleanly back to main stream variants.
        ];
        scope.FallbackPlayerType = 'site';// was 'embed' — site is more reliable when all Source types end up ad-laden
        scope.ForceAccessTokenPlayerType = 'popout';
        scope.PreferLowQualityBackup = true;// Hybrid safety net for SSAI-heavy breaks: sticky escape hatch (fires after ~8s stuck in all-stripped state) + autoplay (360p) as last-resort backup when all Source types are ad-laden. Default on; set twitchAdSolutions_preferLowQualityBackup=false to disable.
        scope.FastAutoplayFirstTry = true;// When the prior break committed autoplay-via-escape-hatch, prepend autoplay (360p) to position 0 of playerTypesToTry on the next break — autoplay wins on first probe (~340ms) instead of cycling through 4 Source types (~1.5-2s). Auto-resets when a Source-tier type wins (channel recovered), so quality returns to full automatically if Twitch ever brings back non-ad-laden Source backups. Default on as of v67.1.0 — field data (project_all_channels_csai_only_marked) confirms every observed channel exhausts Source-tier on every break. Opt-out via localStorage twitchAdSolutions_fastAutoplayFirstTry=false.
        scope.BackupSwapFirst = true;// On ad detect, immediately swap to a backup player-type m3u8 (TTV-AB-style). Avoids MediaSource mixing from strip activity — fewer loading circles in field. Cost: extra fetches on every ad break. Default on; set twitchAdSolutions_backupSwapFirst=false to disable.
        scope.DisableAdSpoofing = true;// Default OFF (was ON through v68.2.0). The always-100%-watched + audible + visible spoof beacon pattern may itself fingerprint as anomalous and trigger detection escalation (CSAI reaching the committed backup) — observed correlation in field + TTV-AB maintainer hypothesis. Spoof-accepted (no GQL rejection) does NOT prove not-fingerprinted; Twitch can 200-OK while using the beacon pattern as silent detection input. Opt in by setting twitchAdSolutions_disableAdSpoofing=false to re-enable the GQL ad-tracking beacons (video_ad_impression, video_ad_quartile_complete x 4, video_ad_pod_complete).
        scope.RecoverFromSilentMute = true;// On hard reload, if the element is already muted but vaft has successfully unmuted at any point earlier this session, treat it as a silent Twitch re-mute and recover via the backstop. Default on; set twitchAdSolutions_recoverFromSilentMute=false to disable (useful for users who deliberately mute mid-session).
        scope.SkipPlayerReloadOnHevc = false;// If true this will skip player reload on streams which have 2k/4k quality (if you enable this and you use the 2k/4k quality setting you'll get error #4000 / #3000 / spinning wheel on chrome based browsers)
        scope.AlwaysReloadPlayerOnAd = false;// Always pause/play when entering/leaving ads
        scope.ReloadPlayerAfterAd = true;// After the ad finishes do a player reload instead of pause/play
        scope.ReloadCooldownSeconds = 30;// Minimum seconds between reloads — breaks CSAI cascades triggered by reload
        scope.DisableReloadCap = false;// If true, buffer monitor reloads unlimited times (pre-v47 behavior, risk of cascade)
        scope.DriftCorrectionRate = 1.1;// Playback rate for catching up to live edge after reload (0 = disable drift correction)
        scope.EarlyReloadPollThreshold = 3;// Number of consecutive all-stripped polls before triggering early reload (each poll ~2s, so 3 = ~6s, 5 = ~10s, 10 = ~20s; 0 = disable). Lowered from 5 to 3 to match the testing variant — field reports indicate faster early-reload recovers heavier SSAI breaks more cleanly. Override via localStorage twitchAdSolutions_earlyReloadPollThreshold.
        scope.PinBackupPlayerType = true;// Remember which backup player type worked and try it first on next ad break
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = 2;//autoplay
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = Object.create(null);
        scope.StreamInfosByUrl = Object.create(null);
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = true;// If true this will pause/play the player when it gets stuck buffering
        scope.PlayerBufferingDelay = 600;// How often should we check the player state (in milliseconds)
        scope.PlayerBufferingSameStateCount = 3;// How many times of seeing the same player state until we trigger pause/play (it will only trigger it one time until the player state changes again)
        scope.PlayerBufferingDangerZone = 0.5;// Lowered 1 → 0.5: at the live edge with thin-but-functional buffer (~0.7-0.95s), the AND check (positionFrozen + bufferDuration < DangerZone) was firing on real momentary stalls — but the pause/play "fix" interacts badly with Twitch's playback-monitor (snaps to "buffered region 0.04xxx"), creating a self-sustaining cascade where each fix degrades currentTime. Lower threshold confines firing to truly-drained buffer states (<0.5s) where intervention is unambiguously needed.
        scope.PlayerBufferingDoPlayerReload = false;// If true this will do a player reload instead of pause/play (player reloading is better at fixing the playback issues but it takes slightly longer)
        scope.PlayerBufferingMinRepeatDelay = 8000;// Minimum delay (in milliseconds) between each pause/play (this is to avoid over pressing pause/play when there are genuine buffering problems)
        scope.PlayerBufferingPrerollCheckEnabled = false;// Enable this if you're getting an immediate pause/play/reload as you open a stream (which is causing the stream to take longer to load). One problem with this being true is that it can cause the player to get stuck in some instances requiring the user to press pause/play
        scope.PlayerBufferingPrerollCheckOffset = 5;// How far the stream need to move before doing the buffering mitigation (depends on PlayerBufferingPrerollCheckEnabled being true)
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
        scope.StreamInfoMaxAgeMs = 30 * 60 * 1000;
    }
    function pruneStreamInfos() {
        const now = Date.now();
        for (const channelName in StreamInfos) {
            const streamInfo = StreamInfos[channelName];
            if (!streamInfo || !streamInfo.LastSeenAt || (now - streamInfo.LastSeenAt) > StreamInfoMaxAgeMs) {
                if (streamInfo && streamInfo.Urls) {
                    for (const url in streamInfo.Urls) {
                        delete StreamInfosByUrl[url];
                    }
                }
                delete StreamInfos[channelName];
            }
        }
    }
    // Creates a new StreamInfo with the full field shape declared up-front.
    // When adding a new streamInfo field, declare it here with an appropriate
    // zero value so the complete shape is visible in one place.
    function createStreamInfo(channelName, encodingsM3u8, usherParams) {
        return {
            // Identity / lifecycle
            ChannelName: channelName,
            LastSeenAt: Date.now(),
            EncodingsM3U8: encodingsM3u8,
            UsherParams: usherParams,
            // Resolutions / URL map
            Urls: Object.create(null),// xxx.m3u8 -> { Resolution: "284x160", FrameRate: 30.0 }
            ResolutionList: [],
            RequestedAds: new Set(),
            SpoofedAdIds: new Set(),// notifyAdComplete: stitched-ad IDs already spoofed this break (multi-poll dedup). Cleared at break end.
            // Modified m3u8 state
            ModifiedM3U8: null,
            IsUsingModifiedM3U8: false,
            // Ad-break state
            IsShowingAd: false,
            IsMidroll: false,
            AdBreakStartedAt: 0,
            PodLength: 1,
            HasConfirmedAdAttrs: false,
            CleanPlaylistCount: 0,
            PendingAdEndAt: 0,// Timestamp of first clean poll seen this break — drives the bounce-tolerant max-wait escalation gate (TTV-AB v6.6.7 #1/#4)
            AdEndBounceCount: 0,// Count of ad-marker bounces while PendingAdEndAt is alive — telemetry only
            ConsecutiveZeroStripBreaks: 0,
            CsaiOnlyThisBreak: false,
            // Strip state
            IsStrippingAdSegments: false,
            NumStrippedAdSegments: 0,
            RecoverySegments: [],
            RecoveryStartSeq: undefined,// LOAD-BEARING: explicitly checked with \`!== undefined\`
            FreezeStartedAt: 0,
            ConsecutiveAllStrippedPolls: 0,
            TotalAllStrippedPolls: 0,
            // Clean playlist snapshot for all-stripped recovery (mirrors TTV-AB)
            LastCleanNativeM3U8: null,
            LastCleanNativePlaylistAt: 0,
            // Backup player type cycling
            BackupEncodingsM3U8Cache: [],
            ActiveBackupPlayerType: null,
            PinnedBackupPlayerType: null,
            LastCommittedBackupPlayerType: null,
            FailedBackupPlayerTypes: new Map(),// Map<playerType, timestamp> — failures expire after 15s for retry
            LoggedBackupAdsByType: null,// lazy-init to Set on first "backup has ads" log
            CycleRescuedThisBreak: false,
            // Early reload
            EarlyReloadCount: 0,
            EarlyReloadAtPoll: 0,
            EarlyReloadTriggered: false,
            EarlyReloadAwaitingResult: false,
            // Hybrid-mode state (PreferLowQualityBackup)
            EscapeHatchFired: false,
            LastBreakUsedEscapeHatch: false,// FastAutoplayFirstTry: set when a break commits autoplay via PreferLowQualityBackup escape hatch (= all 4 Source types contaminated this break). Read at next break's backup-search entry to prepend autoplay first. Reset when a Source-tier type wins (channel recovered).
            FastAutoplayConsecutive: 0,// Count of consecutive breaks won by fast-autoplay without testing Source-tier. Triggers periodic re-probe to detect channel recovery (Twitch reversing CSAI delivery). Reset when full Source-tier probe runs or Source-tier wins.
            // Reload cooldown
            LastPlayerReload: 0,
            ReloadTimestamps: [],
            // Diagnostic flags (once-per-session)
            HasCheckedUnknownTags: false,
            HasLoggedAdAttributes: false,
            HasLoggedUnknownSignifiers: false,
            LoggedOfflineTransition: false,// Detection diagnostic: set when m3u8 transitions to offline-shape mid-session.
            ConsecutiveTokenFetchFailures: 0,// Detection diagnostic: counter for consecutive failed access-token fetches across player types. Logged at threshold, reset on success.
            LoggedTokenFailureStreak: false,// Once-per-streak guard for the threshold log.
        };
    }
    function maskAsNative(fn, name) {
        fn.toString = () => 'function ' + name + '() { [native code] }';
        return fn;
    }
    const loggedCsaiTypes = new Set();
    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    const twitchWorkers = [];
    let cachedRootNode = null;// Cached #root DOM element (never changes in React SPAs)
    let cachedPlayerRootDiv = null;// Cached .video-player element
    // One-shot flags for overlay-hide logs. Twitch's React tree re-mounts SDA
    // wrappers and ad-break cards constantly during an ad break, so the
    // hide-and-log fires hundreds of times. Log the first occurrence of each
    // hide type per page load, then stay silent — the hide itself still runs
    // on every tick via dataset-based dedup.
    let loggedSdaHide = false;
    // Strings used to detect and handle conflicting Twitch worker overrides (e.g. TwitchNoSub)
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '\${patch_url}'// TwitchNoSub (0.9.1)
    ];
    // Walk the Worker prototype chain and remove conflicting overrides
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    // Another extension may have frozen Worker.prototype or set non-configurable
                    // [[Prototype]]; setPrototypeOf throws TypeError in that case. Catch per-link
                    // so a single foreign-frozen ring doesn't abort the whole chain walk.
                    try { Object.setPrototypeOf(parent, Object.getPrototypeOf(proto)); } catch {}
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            // Per-link try-catch: a foreign extension that froze a single proto entry
            // shouldn't break the whole reinsertion chain. Skip the failing link, keep going.
            try { Object.setPrototypeOf(reinsert[i], parent); } catch {}
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        const hasConflict = workerStringConflicts.some((x) => workerString.includes(x));
        const hasReinsert = workerStringReinsert.some((x) => workerString.includes(x));
        if (hasConflict && !hasReinsert) {
            console.log('[AD DEBUG] Worker rejected — conflict string found: ' + workerStringConflicts.filter((x) => workerString.includes(x)).join(', '));
        }
        return !hasConflict || hasReinsert;
    }
    // Replace window.Worker to intercept Twitch's video worker and inject ad-blocking logic
    let injectedBlobUrl = null;
    let originalRevokeObjectURL = null;
    function hookWindowWorker() {
        // Prevent Twitch from revoking our injected worker blob URL
        if (!URL.revokeObjectURL.__tasMasked) {
            originalRevokeObjectURL = URL.revokeObjectURL;
            URL.revokeObjectURL = maskAsNative(function(url) {
                if (url === injectedBlobUrl) return;
                return originalRevokeObjectURL.call(this, url);
            }, 'revokeObjectURL');
            URL.revokeObjectURL.__tasMasked = true;
        }
        const reinsert = getWorkersForReinsert(window.Worker);
        const cleanWorker = getCleanWorker(window.Worker) || window.Worker;
        const newWorker = class Worker extends cleanWorker {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    console.log('[AD DEBUG] Non-Twitch worker skipped: ' + twitchBlobUrl);
                    return;
                }
                // Pre-check: verify we can fetch the worker JS before injecting
                let prefetchedWorkerJs = null;
                try { prefetchedWorkerJs = getWasmWorkerJs(twitchBlobUrl); } catch {}
                if (!prefetchedWorkerJs) {
                    super(twitchBlobUrl, options);
                    console.log('[AD DEBUG] Failed to fetch worker JS — falling back to unmodified worker');
                    return;
                }
                console.log('[AD DEBUG] Worker intercepted — injecting ad-block hooks');
                const newBlobStr = \`
                    const pendingFetchRequests = new Map();
                    \${hasAdTags.toString()}
                    \${getMatchedAdSignifiers.toString()}
                    \${notifyAdComplete.toString()}
                    \${stripAdSegments.toString()}
                    \${getStreamUrlForResolution.toString()}
                    \${processM3U8.toString()}
                    \${hookWorkerFetch.toString()}
                    \${declareOptions.toString()}
                    \${getAccessToken.toString()}
                    \${gqlRequest.toString()}
                    \${parseAttributes.toString()}
                    \${getWasmWorkerJs.toString()}
                    \${getServerTimeFromM3u8.toString()}
                    \${replaceServerTimeInM3u8.toString()}
                    \${pruneStreamInfos.toString()}
                    \${createStreamInfo.toString()}
                    const workerString = getWasmWorkerJs('\${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    if (!self.__tasPruneInterval) {
                        self.__tasPruneInterval = setInterval(pruneStreamInfos, 5 * 60 * 1000);
                    }
                    ReloadPlayerAfterAd = \${ReloadPlayerAfterAd};
                    ReloadCooldownSeconds = \${ReloadCooldownSeconds};
                    DisableReloadCap = \${DisableReloadCap};
                    EarlyReloadPollThreshold = \${EarlyReloadPollThreshold};
                    PinBackupPlayerType = \${PinBackupPlayerType};
                    PreferLowQualityBackup = \${PreferLowQualityBackup};
                    FastAutoplayFirstTry = \${FastAutoplayFirstTry};
                    BackupSwapFirst = \${BackupSwapFirst};
                    DisableAdSpoofing = \${DisableAdSpoofing};
                    ForceAccessTokenPlayerType = '\${ForceAccessTokenPlayerType}';
                    GQLDeviceID = \${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = \${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = \${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = \${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = \${ClientSession ? "'" + ClientSession + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key == 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key == 'UpdateClientId') {
                            ClientID = e.data.value;
                        } else if (e.data.key == 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject, timeoutId } = pendingFetchRequests.get(responseData.id);
                                clearTimeout(timeoutId);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    // Create a Response object from the response data.
                                    // Response constructor only takes status/statusText/headers — url/redirected/type
                                    // must be defined on the instance. IVS WASM validates these (Spade/tracking
                                    // requests) and throws NetworkError if they're missing — TTV-AB v6.3.5 fix.
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    try {
                                        Object.defineProperty(response, 'url', { value: responseData.url || '', configurable: true });
                                        Object.defineProperty(response, 'redirected', { value: !!responseData.redirected, configurable: true });
                                        Object.defineProperty(response, 'type', { value: responseData.type || 'basic', configurable: true });
                                    } catch {}
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        } else if (e.data.key == 'ReloadSkipped') {
                            // Main thread refused the reload (player healthy) — clear the
                            // early-reload flags so we can re-fire if the player later stalls.
                            // Without this clear, the worker's EarlyReloadTriggered /
                            // EarlyReloadAwaitingResult flags stay set after a healthy-skip,
                            // blocking subsequent early-reload firings in the same break even
                            // if a later poll legitimately calls for one.
                            let cleared = false;
                            for (const channel in StreamInfos) {
                                const si = StreamInfos[channel];
                                if (si && si.EarlyReloadTriggered) {
                                    si.EarlyReloadTriggered = false;
                                    si.EarlyReloadAwaitingResult = false;
                                    si.EarlyReloadCount = Math.max(0, (si.EarlyReloadCount || 0) - 1);
                                    cleared = true;
                                }
                            }
                            if (cleared) {
                                console.log('[AD DEBUG] Reload skipped by main thread (player healthy) — early reload state cleared, can retry');
                            }
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('SimulatedAdsDepth: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments: ' + AllSegmentsAreAdSegments);
                        }
                    });
                    hookWorkerFetch();
                    // Guard the eval — malformed workerString shouldn't silently break
                    // Twitch's player logic without a diagnostic. Worker stays alive on
                    // throw (vaft hooks installed above), but Twitch's logic wouldn't run.
                    try { eval(workerString); } catch (e) { console.error('[AD DEBUG] Worker eval failed — Twitch player logic not loaded:', e); }
                \`;
                // Revoke previous blob URL to prevent memory accumulation across worker replacements
                if (injectedBlobUrl && originalRevokeObjectURL) {
                    try { originalRevokeObjectURL.call(URL, injectedBlobUrl); } catch {}
                }
                injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                super(injectedBlobUrl, options);
                twitchWorkers.length = 0;
                twitchWorkers.push(this);
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        updateAdblockBanner(e.data);
                        // Track backup stream switches (start and end of ad break)
                        if (e.data.hasAds !== !!playerBufferState.inAdBreak) {
                            playerBufferState.lastBackupSwitchAt = Date.now();
                            // Reset position tracking on ad-end so the stream switch gap isn't detected as a jump
                            if (!e.data.hasAds) {
                                playerBufferState.position = 0;
                            }
                        }
                        playerBufferState.inAdBreak = !!e.data.hasAds;
                        // Clear drift catch-up when ads start — don't run 1.1x during ad handling
                        if (e.data.hasAds && (driftCatchUpInterval || driftCatchUpTimeout)) {
                            if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
                            if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
                            try { document.querySelector('video').playbackRate = 1.0; } catch {}
                        }
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true, e.data.kind);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        const responseData = await handleWorkerFetchRequest(fetchRequest);
                        this.postMessage({
                            key: 'FetchResponse',
                            value: responseData
                        });
                    }
                });
                // Worker crash recovery — IVS WASM worker can fire RuntimeError
                // (e.g. "index out of bounds") and die. A single crash fires multiple
                // error events; dedupe via a local flag. On first error, trigger a
                // hard reload via the main reload path — Twitch re-spawns the worker
                // as part of the new player instance, and existing reload cooldown
                // prevents runaway restart loops.
                let crashed = false;
                this.addEventListener('error', (e) => {
                    if (crashed) return;
                    crashed = true;
                    console.log('[AD DEBUG] IVS WASM worker crashed: ' + ((e && e.message) || 'unknown error') + ' — triggering hard reload to recover');
                    try { doTwitchPlayerTask(false, true, 'early'); } catch (err) {
                        console.log('[AD DEBUG] Worker crash recovery failed: ' + err.message);
                    }
                });
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('Attempt to set twitch worker denied');
                }
            }
        });
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        if (!getWasmWorkerJs.cache) {
            getWasmWorkerJs.cache = Object.create(null);
        }
        if (getWasmWorkerJs.cache[twitchBlobUrl]) {
            return getWasmWorkerJs.cache[twitchBlobUrl];
        }
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        const text = req.responseText;
        getWasmWorkerJs.cache[twitchBlobUrl] = text;
        return text;
    }
    // Hook fetch() in the worker scope to intercept m3u8 playlist requests and ad segments
    function hookWorkerFetch() {
        console.log('[AD DEBUG] hookWorkerFetch (vaft)');
        const BLANK_MP4 = new Blob([Uint8Array.from(atob('AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA'), c => c.charCodeAt(0))], {type: 'video/mp4'});
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Response(BLANK_MP4);
                }
                url = url.trimEnd();
                if (url.endsWith('m3u8')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                resolve(new Response(await processM3U8(url, await response.text(), realFetch)));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function(response) {
                            processAfter(response);
                        })['catch'](function(err) {
                            reject(err);
                        });
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const parsedUrl = new URL(url);
                    const channelName = parsedUrl.pathname.match(/([^\\/]+)(?=\\.\\w+$)/)?.[0];
                    if (ForceAccessTokenPlayerType) {
                        // parent_domains is used to determine if the player is embeded and stripping it gets rid of fake ads
                        parsedUrl.searchParams.delete('parent_domains');
                        url = parsedUrl.toString();
                    }
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = await response.text();
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null && (await realFetch(streamInfo.EncodingsM3U8.match(/^https:.*\\.m3u8$/m)?.[0])).status !== 200) {
                                    // The cached encodings are dead (the stream probably restarted)
                                    streamInfo = null;
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    // Clear reload-pending flag from a prior stream session — without this,
                                    // a reload triggered on the previous channel bleeds into the new channel's
                                    // cooldown calculation, blocking legitimate end-of-break reloads.
                                    HasTriggeredPlayerReload = false;
                                    console.log('[AD DEBUG] New stream session — channel: ' + channelName + ', API: ' + (V2API ? 'v2' : 'v1'));
                                    StreamInfos[channelName] = streamInfo = createStreamInfo(channelName, encodingsM3u8, parsedUrl.search);
                                    const lines = encodingsM3u8.split(/\\r?\\n/);
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'],
                                                    // AUDIO/VIDEO/SUBTITLES groups are copied onto the rewritten STREAM-INF
                                                    // line during HEVC→AVC fallback so the variant references matching media
                                                    // groups (mirrors TTV-AB v6.7.5 parser fix). Without these, the rewritten
                                                    // line keeps the original HEVC variant's group ids, which point at audio
                                                    // tracks the AVC backup may not carry — black screen / audio desync.
                                                    Audio: attributes['AUDIO'] || '',
                                                    Video: attributes['VIDEO'] || '',
                                                    Subtitles: attributes['SUBTITLES'] || '',
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                streamInfo.ResolutionList.push(resolutionInfo);
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    if (streamInfo.ResolutionList.length === 0) {
                                        console.log('[AD DEBUG] No resolutions parsed from encodings m3u8 — Twitch may have changed the format');
                                    }
                                    const nonHevcResolutionList = streamInfo.ResolutionList.filter((element) => element.Codecs.startsWith('avc') || element.Codecs.startsWith('av0'));
                                    if (AlwaysReloadPlayerOnAd || (nonHevcResolutionList.length > 0 && streamInfo.ResolutionList.some((element) => element.Codecs.startsWith('hev') || element.Codecs.startsWith('hvc')) && !SkipPlayerReloadOnHevc)) {
                                        // Replace OR append a STREAM-INF attribute (replace if present, append after a comma if absent).
                                        // Used below to copy AUDIO/VIDEO/SUBTITLES groups from the closest non-HEVC variant onto the
                                        // rewritten HEVC line, matching TTV-AB v6.7.5's parser fix.
                                        const replaceOrAppendStreamInfAttr = (line, key, value) => {
                                            if (typeof value !== 'string' || !value) return line;
                                            const escaped = value.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
                                            const next = key + '="' + escaped + '"';
                                            const pattern = new RegExp('(^|,)' + key + '=("[^"]*"|[^,]*)');
                                            return pattern.test(line) ? line.replace(pattern, '$1' + next) : line + ',' + next;
                                        };
                                        if (nonHevcResolutionList.length > 0) {
                                            for (let i = 0; i < lines.length - 1; i++) {
                                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(':') + 1));
                                                    const codecsKey = 'CODECS';
                                                    if (resSettings[codecsKey].startsWith('hev') || resSettings[codecsKey].startsWith('hvc')) {
                                                        const oldResolution = resSettings['RESOLUTION'];
                                                        const [targetWidth, targetHeight] = oldResolution.split('x').map(Number);
                                                        const targetArea = targetWidth * targetHeight;
                                                        let newResolutionInfo = null;
                                                        let closestDiff = Infinity;
                                                        for (let j = 0; j < nonHevcResolutionList.length; j++) {
                                                            const candidate = nonHevcResolutionList[j];
                                                            const [streamWidth, streamHeight] = candidate.Resolution.split('x').map(Number);
                                                            const diff = Math.abs((streamWidth * streamHeight) - targetArea);
                                                            if (diff < closestDiff) {
                                                                closestDiff = diff;
                                                                newResolutionInfo = candidate;
                                                            }
                                                        }
                                                        console.log('ModifiedM3U8 swap ' + resSettings[codecsKey] + ' to ' + newResolutionInfo.Codecs + ' oldRes:' + oldResolution + ' newRes:' + newResolutionInfo.Resolution);
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, \`CODECS="\${newResolutionInfo.Codecs}"\`);
                                                        // Copy media-group attributes from the closest non-HEVC variant so the
                                                        // rewritten line references audio/video/subtitle tracks the AVC backup
                                                        // actually carries. TTV-AB v6.7.5 parser fix.
                                                        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'AUDIO', newResolutionInfo.Audio);
                                                        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'VIDEO', newResolutionInfo.Video);
                                                        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'SUBTITLES', newResolutionInfo.Subtitles);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);// The stream doesn't load unless each url line is unique
                                                    }
                                                }
                                            }
                                        }
                                        if (nonHevcResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\\n');
                                        }
                                    }
                                }
                                streamInfo.LastSeenAt = Date.now();
                                // Note: do NOT set streamInfo.LastPlayerReload here. It was previously
                                // set unconditionally on new stream session creation, which caused the
                                // first end-of-break reload of every new channel to be blocked by
                                // cooldown — the cooldown check treated the session-creation timestamp
                                // as a recent reload, even though no reload had actually occurred.
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function(response) {
                            processAfter(response);
                        })['catch'](function(err) {
                            reject(err);
                        });
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches && matches.length > 1 ? matches[1] : null;
        }
        const matches = encodingsM3u8.match(/SERVER-TIME="([0-9.]+)"/);
        return matches && matches.length > 1 ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, \`$1\${newServerTime}$2\`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, \`SERVER-TIME="\${newServerTime}"\`) : encodingsM3u8;
    }
    function hasAdTags(textStr) {
        return AdSignifiers.some((s) => s && textStr.includes(s));
    }
    // Spoof ad completion to Twitch's GQL endpoint when an ad break is detected.
    // Twitch's player would normally fire video_ad_impression / video_ad_quartile_complete
    // / video_ad_pod_complete beacons as the ad plays. With ad-blocking, those beacons
    // never fire. Spoofing them mimics the "ad played normally" signal, potentially
    // reducing detection escalation. RADS-token extracted from the stitched-ad DATERANGE
    // line. Failures swallowed — never block normal ad-block flow.
    function notifyAdComplete(textStr, streamInfo) {
        try {
            // Each ad in a pod has its OWN #EXT-X-DATERANGE:ID="stitched-ad-..." line
            // with its own RADS-token, ad-id, creative-id, line-item-id, position, etc.
            // Twitch reveals each ad's DATERANGE only when that ad starts playing, so a
            // 6-ad pod surfaces ONE ad per m3u8 poll across the break. This function is
            // called on every ad-laden poll; streamInfo.SpoofedAdIds dedups across polls
            // so each ad is spoofed exactly once as it appears (full N/N pod coverage).
            const matches = [...textStr.matchAll(/#EXT-X-DATERANGE:(ID="stitched-ad-[^\\n]+)\\n/g)];
            if (matches.length === 0) {
                if (!notifyAdComplete.loggedNoMatch) {
                    notifyAdComplete.loggedNoMatch = true;
                    const dateRangeLine = textStr.match(/#EXT-X-DATERANGE:[^\\n]{0,200}/);
                    console.log('[AD DEBUG] notifyAdComplete: no stitched-ad DATERANGE match. Sample DATERANGE: ' + (dateRangeLine ? dateRangeLine[0] : 'none found'));
                }
                return;
            }
            const spoofedSet = (streamInfo && streamInfo.SpoofedAdIds) || null;
            // True pod size from the m3u8 attribute (present on each DATERANGE); fall
            // back to visible-match count if absent. Keeps total_ads consistent across
            // all ads in the pod even though they surface one poll at a time.
            const podLenMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\\d+)"/);
            const podLength = podLenMatch ? parseInt(podLenMatch[1], 10) : matches.length;
            // Hot-path early-out: notifyAdComplete now runs every ad-laden poll, and a
            // long multi-ad break has hundreds of polls AFTER the whole pod is already
            // spoofed. Once the dedup set covers the pod, every remaining poll is pure
            // waste — bail before the per-match parseAttributes loop. (size at entry is
            // before this poll's additions, so the poll that completes the pod still
            // runs and attaches pod_complete; only subsequent polls short-circuit.)
            if (spoofedSet && spoofedSet.size >= podLength) {
                return;
            }
            let newSpoofed = 0;
            let firstRollType = '';
            let podCompleteSent = false;
            for (let i = 0; i < matches.length; i++) {
                // Cheap ID pre-extract for the dedup check — the DATERANGE capture
                // always starts with ID="stitched-ad-<UUID>". Checking the dedup set
                // before the full parseAttributes() avoids re-parsing every already-
                // spoofed ad's attribute string on each poll during the spoofing phase.
                const idMatch = matches[i][1].match(/^ID="([^"]+)"/);
                const stitchedAdId = idMatch ? idMatch[1] : '';
                // Multi-poll dedup: skip ads already spoofed earlier this break.
                if (spoofedSet && stitchedAdId && spoofedSet.has(stitchedAdId)) {
                    continue;
                }
                const attr = parseAttributes(matches[i][1]);
                const radToken = attr['X-TV-TWITCH-AD-RADS-TOKEN'];
                if (!radToken) {
                    if (i === 0 && !notifyAdComplete.loggedNoToken) {
                        notifyAdComplete.loggedNoToken = true;
                        console.log('[AD DEBUG] notifyAdComplete: matched DATERANGE but no RADS token. Attributes: ' + Object.keys(attr).join(', '));
                    }
                    continue;
                }
                const rollType = (attr['X-TV-TWITCH-AD-ROLL-TYPE'] || '').toLowerCase();
                if (!firstRollType) firstRollType = rollType;
                // Prefer m3u8's explicit pod-position when present (e.g. X-TV-TWITCH-AD-POD-POSITION="2");
                // fall back to iteration index for older formats.
                const adPosition = parseInt(attr['X-TV-TWITCH-AD-POD-POSITION'] || String(i), 10);
                // Payload internally consistent with the events we claim happened. Sending
                // quartile_complete{4} + pod_complete = "watched 100% of the ad to completion."
                // Pairing that with mute=true / volume=0 / visible=false / duration=0 is the
                // obvious cross-validation flag if Twitch ever audits. Mirror a normal-viewer
                // state: audio on, visible, full duration. Duration comes from the m3u8
                // attribute when present (fallback 0 keeps the previous behavior if missing).
                const adDuration = parseInt(attr['X-TV-TWITCH-AD-DURATION'] || '0', 10) || 0;
                const payload = {
                    stitched: true,
                    ad_id: stitchedAdId,
                    roll_type: rollType,
                    creative_id: attr['X-TV-TWITCH-AD-CREATIVE-ID'] || '',
                    order_id: attr['X-TV-TWITCH-AD-ORDER-ID'] || '',
                    line_item_id: attr['X-TV-TWITCH-AD-LINE-ITEM-ID'] || '',
                    player_mute: false,
                    player_volume: 1.0,
                    visible: true,
                    duration: adDuration,
                    ad_position: adPosition,
                    total_ads: podLength
                };
                // Batch all 6 events for this ad into one GQL POST. Twitch's endpoint
                // supports JSON-array batched operations natively. Reduces request count
                // 6× and avoids the bot-like fingerprint of firing 6 separate requests
                // in rapid succession.
                const makePacket = (event, extra) => ({
                    operationName: 'ClientSideAdEventHandling_RecordAdEvent',
                    variables: { input: { eventName: event, eventPayload: JSON.stringify({ ...payload, ...extra }), radToken } },
                    extensions: { persistedQuery: { version: 1, sha256Hash: '7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b' } }
                });
                // Mark this ad spoofed BEFORE building the batch so the pod-complete
                // size check below reflects it.
                if (spoofedSet && stitchedAdId) spoofedSet.add(stitchedAdId);
                const batch = [
                    makePacket('video_ad_impression'),
                    makePacket('video_ad_quartile_complete', { quartile: 1 }),
                    makePacket('video_ad_quartile_complete', { quartile: 2 }),
                    makePacket('video_ad_quartile_complete', { quartile: 3 }),
                    makePacket('video_ad_quartile_complete', { quartile: 4 }),
                ];
                // pod_complete fires ONCE per pod — not per ad. A real player sends a
                // single pod_complete after the whole pod finishes; emitting it on every
                // ad (6× for a 6-ad pod) is itself a fingerprint. Attach it to the ad
                // that brings the dedup set up to the true pod size (the last ad). If
                // the pod never fully surfaces (some DATERANGEs missed / break ended
                // early) pod_complete is correctly never sent — a real player wouldn't
                // claim pod completion it didn't reach either. Defensive fallback (no
                // dedup set): keep per-ad pod_complete so the signal isn't lost.
                if (!spoofedSet || spoofedSet.size === podLength) {
                    batch.push(makePacket('video_ad_pod_complete'));
                    podCompleteSent = true;
                }
                // Surveil GQL response status — distinguishes "spoof fired, accepted" from
                // "spoof fired, Twitch rejected" (400/403/429/5xx). The .catch only fires for
                // network errors / timeouts; non-200 status resolves normally. Without this,
                // detection escalation (Twitch starts rejecting spoof beacons) would be a
                // silent failure mode invisible in field logs. Once-per-session guard prevents
                // spam if rate-limit kicks in across consecutive breaks.
                gqlRequest(batch).then(response => {
                    if (response && response.status !== 200 && !notifyAdComplete.loggedBadStatus) {
                        notifyAdComplete.loggedBadStatus = true;
                        console.log('[AD DEBUG] notifyAdComplete: GQL response status ' + response.status + ' — spoof may be rejected/rate-limited');
                    }
                }).catch(() => {});
                newSpoofed++;
            }
            if (newSpoofed > 0) {
                const total = spoofedSet ? spoofedSet.size : newSpoofed;
                // src= which stream the spoofed DATERANGEs came from (primary vs a
                // committed backup player-type) — surfaces the stream-swap ad-ID
                // mixing limitation: a pod that spoofs across primary+backup shows
                // src changing mid-pod. pod-complete= whether this poll attached the
                // single video_ad_pod_complete (lets you confirm pod completion
                // explicitly instead of inferring it from the total/POD ratio).
                const src = (streamInfo && streamInfo.ActiveBackupPlayerType) || 'primary';
                console.log('[AD DEBUG] Spoofed ad completion for ' + newSpoofed + ' new ad(s) (' + total + '/' + podLength + ' pod) — roll: ' + firstRollType + ', src: ' + src + ', pod-complete: ' + (podCompleteSent ? 'yes' : 'no'));
            }
        } catch (err) {
            console.log('[AD DEBUG] Ad completion spoof failed: ' + err.message);
        }
    }
    function getMatchedAdSignifiers(textStr) {
        return AdSignifiers.filter((s) => textStr.includes(s));
    }
    // Remove ad segments from an m3u8 playlist and cache their URLs for replacement
    function stripAdSegments(textStr, stripAllSegments, streamInfo) {
        let hasStrippedAdSegments = false;
        let inCueOut = false;
        const liveSegments = [];
        const lines = textStr.split(/\\r?\\n/);
        const newAdUrl = 'https://twitch.tv';
        // Log ad tracking attribute names once per stream (helps identify new beacons)
        if (!streamInfo.HasLoggedAdAttributes) {
            const adAttrs = textStr.match(/X-TV-TWITCH-AD[A-Z-]*(?==")/g);
            if (adAttrs && adAttrs.length > 0) {
                streamInfo.HasLoggedAdAttributes = true;
                console.log('[AD DEBUG] Ad tracking attributes seen: ' + [...new Set(adAttrs)].join(', '));
            }
        }
        // Log potential ad markers that aren't in AdSignifiers (candidates for future inclusion)
        if (!streamInfo.HasLoggedUnknownSignifiers) {
            const candidates = new Set();
            let sm;
            const classRe = /EXT-X-DATERANGE:[^\\n]*CLASS="(twitch-[^"]+)"/g;
            while ((sm = classRe.exec(textStr)) !== null) {
                candidates.add('EXT-X-DATERANGE:CLASS="' + sm[1] + '"');
            }
            const tagRe = /(SCTE35-[A-Z-]+|EXT-X-CUE-[A-Z-]+)/g;
            while ((sm = tagRe.exec(textStr)) !== null) {
                candidates.add(sm[1]);
            }
            // Substring check (not exact): a candidate is "known" if any AdSignifier
            // appears within it. This handles prefix signifiers like 'twitch-stitched'
            // covering 'EXT-X-DATERANGE:CLASS="twitch-stitched-ad"' etc.
            const unknown = [...candidates].filter(c =>
                !AdSignifiers.some(s => s && c.includes(s)) &&
                !KnownNonAdSignifiers.some(s => s && c.includes(s))
            );
            if (unknown.length > 0) {
                streamInfo.HasLoggedUnknownSignifiers = true;
                console.log('[AD DEBUG] Potential ad markers seen but not in AdSignifiers: ' + unknown.join(', ') + ' (candidates for future inclusion)');
            }
        }
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            // Track SCTE-35 CUE-OUT/CUE-IN ad boundaries
            if (line.includes('EXT-X-CUE-OUT')) {
                if (!inCueOut) {
                    console.log('[AD DEBUG] SCTE-35 CUE-OUT — ad boundary entered');
                }
                inCueOut = true;
            } else if (line.includes('EXT-X-CUE-IN')) {
                if (inCueOut) {
                    console.log('[AD DEBUG] SCTE-35 CUE-IN — ad boundary exited');
                }
                inCueOut = false;
            }
            // Remove tracking urls which appear in the overlay UI
            lines[i] = line.replaceAll(TwitchAdUrlRewriteRegex, \`$1\${newAdUrl}$2\`);
            const isLiveSegment = line.includes(',live');
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!isLiveSegment || stripAllSegments || AllSegmentsAreAdSegments || inCueOut)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && AdSegmentURLPatterns.some((p) => lines[i + 1].includes(p))) {
                console.log('[AD DEBUG] Ad segment detected via URL pattern: ' + lines[i + 1]);
                AdSegmentCache.set(lines[i + 1], Date.now());
                hasStrippedAdSegments = true;
                streamInfo.NumStrippedAdSegments++;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && isLiveSegment) {
                liveSegments.push({ extinf: line, url: lines[i + 1] });
            } else if (line.startsWith('#EXT-X-PART:')) {
                // LL-HLS part: URI is inline as an attribute. Strip if it matches a known
                // ad URL (already in cache from a parallel EXTINF strip, or matches a URL pattern).
                // Without this, the player may use the parts path to fetch ad media via low-latency.
                const partUriMatch = line.match(UriAttributeRegex);
                const partUri = partUriMatch ? partUriMatch[1] : '';
                if (partUri && (AdSegmentCache.has(partUri) || AdSegmentURLPatterns.some((p) => partUri.includes(p)))) {
                    AdSegmentCache.set(partUri, Date.now());
                    lines[i] = '';
                    hasStrippedAdSegments = true;
                }
            } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:')) {
                // LL-HLS prefetch/preload hints can point at upcoming ad segments before any
                // EXTINF line or ad signifier has materialized in the playlist. If we only
                // strip prefetch hints AFTER hasStrippedAdSegments is set, the first poll of
                // an ad break can leak a prefetch hint pointing at an ad URL — the player
                // then pre-fetches ad media via the LL-HLS path before our usual strip catches
                // up, producing an ad flash. Detect the ad URL here so hasStrippedAdSegments
                // flips on the first poll and the post-loop unconditional prefetch strip fires.
                // Ported from TTV-AB 52b41b4.
                // Format: '#EXT-X-TWITCH-PREFETCH:https://url/here.ts' (raw URL after the colon)
                //     or: '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="url"' (URI attribute)
                let hintUrl = '';
                if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    hintUrl = line.substring('#EXT-X-TWITCH-PREFETCH:'.length).trim();
                } else {
                    const hintMatch = line.match(/URI="([^"]+)"/);
                    hintUrl = hintMatch ? hintMatch[1] : '';
                }
                if (hintUrl && (AdSegmentCache.has(hintUrl) || AdSegmentURLPatterns.some((p) => hintUrl.includes(p)))) {
                    AdSegmentCache.set(hintUrl, Date.now());
                    hasStrippedAdSegments = true;
                }
            }
        }
        // Moved out of the per-line loop: a per-line scan for any signifier is
        // semantically equivalent to a single full-text scan, since the check has
        // no line-level state — it just flips hasStrippedAdSegments = true on first
        // match. One scan instead of N_lines * N_signifiers scans (~100x fewer
        // includes() calls on a typical 100-line m3u8).
        if (!hasStrippedAdSegments && hasAdTags(textStr)) {
            hasStrippedAdSegments = true;
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                // No low latency during ads (otherwise it's possible for the player to prefetch and display ad segments)
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:') || lines[i].startsWith('#EXT-X-PRELOAD-HINT:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        // Cache live segments for recovery (plus the MEDIA-SEQUENCE of the oldest cached segment,
        // so the player accepts injected recovery segments as the correct position in the stream)
        if (liveSegments.length > 0) {
            streamInfo.RecoverySegments = liveSegments.slice(-6);
            const seq = parseInt((textStr.match(/#EXT-X-MEDIA-SEQUENCE:(\\d+)/) || [])[1]);
            if (!isNaN(seq)) {
                streamInfo.RecoveryStartSeq = seq + Math.max(0, liveSegments.length - streamInfo.RecoverySegments.length);
            }
        }
        // If all segments were stripped, try to prevent black screen via recovery content.
        // Prefer the full-playlist snapshot from a recent non-ad poll (mirrors TTV-AB
        // LastCleanNativeM3U8 approach) — gives the player 4-6 live segments worth of
        // content vs the thin per-segment recovery cache. Falls back to the per-segment
        // cache if the snapshot is stale or missing.
        if (hasStrippedAdSegments && liveSegments.length === 0) {
            streamInfo.ConsecutiveAllStrippedPolls = (streamInfo.ConsecutiveAllStrippedPolls || 0) + 1;
            streamInfo.TotalAllStrippedPolls = (streamInfo.TotalAllStrippedPolls || 0) + 1;
            if (!streamInfo.FreezeStartedAt) streamInfo.FreezeStartedAt = Date.now();
            // Primary: fresh full-playlist snapshot (< 1.5s old, must not itself contain ad markers)
            const snapshotAge = streamInfo.LastCleanNativePlaylistAt ? (Date.now() - streamInfo.LastCleanNativePlaylistAt) : Infinity;
            // Post-ad re-entry guard (mirrors TTV-AB v9.1.3): on a consecutive break that re-enters
            // within the 8s post-ad reload window, the snapshot can straddle the end-of-break reload
            // boundary and replay stale content from the previous cycle. Skip it and fall through to
            // the per-segment recovery cache, which is rebuilt from the current break's polls.
            const recentReloadReentry = streamInfo.LastPlayerReload && (Date.now() - streamInfo.LastPlayerReload) < 8000;
            if (streamInfo.LastCleanNativeM3U8 && snapshotAge <= 1500 && !recentReloadReentry && !hasAdTags(streamInfo.LastCleanNativeM3U8)) {
                console.log('[AD DEBUG] All segments stripped — reusing last clean native playlist (' + snapshotAge + 'ms old)');
                streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
                return streamInfo.LastCleanNativeM3U8;
            }
            // Fallback: per-segment recovery cache (existing behavior)
            if (streamInfo.RecoverySegments && streamInfo.RecoverySegments.length > 0) {
                console.log('[AD DEBUG] All segments stripped — restoring ' + streamInfo.RecoverySegments.length + ' recovery segments');
                if (streamInfo.RecoveryStartSeq !== undefined) {
                    for (let j = 0; j < lines.length; j++) {
                        if (lines[j].startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                            lines[j] = '#EXT-X-MEDIA-SEQUENCE:' + streamInfo.RecoveryStartSeq;
                            break;
                        }
                    }
                }
                for (let j = 0; j < streamInfo.RecoverySegments.length; j++) {
                    lines.push(streamInfo.RecoverySegments[j].extinf);
                    lines.push(streamInfo.RecoverySegments[j].url);
                }
            }
        } else if (liveSegments.length > 0) {
            // Reset freeze counter when live segments are available
            streamInfo.ConsecutiveAllStrippedPolls = 0;
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        const now = Date.now();
        // Throttle cache prune to once per 60s. The 120s TTL gives plenty of headroom
        // and scanning the full cache on every m3u8 poll adds up during heavy ad break
        // sequences (LL-HLS can poll multiple times per second). Ported from TTV-AB.
        if (!streamInfo.LastAdCachePruneAt || now - streamInfo.LastAdCachePruneAt > 60000) {
            streamInfo.LastAdCachePruneAt = now;
            AdSegmentCache.forEach((value, key, map) => {
                if (value < now - 120000) {
                    map.delete(key);
                }
            });
            // Bound the cache to prevent unbounded growth on long sessions. Each entry is
            // a URL string + Date.now() timestamp (~200-300 bytes); over a multi-hour session
            // with frequent ad breaks, the Map can reach MB-scale. When size > 1000, evict
            // the oldest 200 entries (Map iteration order is insertion order, so FIFO).
            // Old ad URLs are unlikely to be requested again; if they are, they'll be
            // re-cached via the strip path normally.
            if (AdSegmentCache.size > 1000) {
                let evicted = 0;
                for (const url of AdSegmentCache.keys()) {
                    AdSegmentCache.delete(url);
                    if (++evicted >= 200) break;
                }
                if (!streamInfo.LoggedAdCacheSize1k) {
                    streamInfo.LoggedAdCacheSize1k = true;
                    console.log('[AD DEBUG] AdSegmentCache exceeded 1000 entries — evicted oldest ' + evicted + ' (now ' + AdSegmentCache.size + ')');
                }
            }
        }
        return lines.join('\\n');
    }
    // Find the closest matching stream URL for a given resolution from a master m3u8
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.split(/\\r?\\n/);
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        let matchedResolutionUrl = null;
        let matchedFrameRate = false;
        let closestResolutionUrl = null;
        let closestResolutionDifference = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            // Accept v2 API variant URLs which are raw CDN URLs without '.m3u8' in the path.
            // v1 API: next line is '...index-<resolution>.m3u8?...'
            // v2 API: next line is a raw CDN URL like 'https://video-edge-...net/v1/.../chunked/...'
            // without '.m3u8'. Matching only on '.m3u8' would skip v2 variants entirely,
            // causing getStreamUrlForResolution to return null and backup selection to fail.
            const nextLine = encodingsLines[i + 1]?.trim();
            if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && nextLine && !nextLine.startsWith('#') && (nextLine.includes('.m3u8') || nextLine.includes('://'))) {
                const attributes = parseAttributes(encodingsLines[i]);
                const resolution = attributes['RESOLUTION'];
                const frameRate = attributes['FRAME-RATE'];
                if (resolution) {
                    if (resolution == resolutionInfo.Resolution && (!matchedResolutionUrl || (!matchedFrameRate && frameRate == resolutionInfo.FrameRate))) {
                        matchedResolutionUrl = encodingsLines[i + 1];
                        matchedFrameRate = frameRate == resolutionInfo.FrameRate;
                        if (matchedFrameRate) {
                            return matchedResolutionUrl;
                        }
                    }
                    const [width, height] = resolution.split('x').map(Number);
                    const difference = Math.abs((width * height) - (targetWidth * targetHeight));
                    if (difference < closestResolutionDifference) {
                        closestResolutionUrl = encodingsLines[i + 1];
                        closestResolutionDifference = difference;
                    }
                }
            }
        }
        return closestResolutionUrl;
    }
    // Core ad-blocking logic: detect ads in m3u8, fetch backup streams, strip ad segments
    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        streamInfo.LastSeenAt = Date.now();
        if (HasTriggeredPlayerReload) {
            HasTriggeredPlayerReload = false;
            streamInfo.LastPlayerReload = Date.now();
        }
        // Detection diagnostic: if Twitch shuts a stream down (anti-ad-block detection
        // response observed in field reports), the m3u8 transitions to a stream-end shape
        // — \`EXT-X-ENDLIST\` present and no \`#EXTINF:\` segment lines. Log once per stream
        // session so users / bug reporters can include the transition timestamp in repros.
        if (!streamInfo.LoggedOfflineTransition && textStr.includes('#EXT-X-ENDLIST') && !textStr.includes('#EXTINF:')) {
            streamInfo.LoggedOfflineTransition = true;
            console.log('[AD DEBUG] Stream ended / offline shape detected — m3u8 has #EXT-X-ENDLIST with no segments. Possible Twitch detection response, broadcaster ended stream, or natural end-of-broadcast');
        }
        if (!streamInfo.HasCheckedUnknownTags) {
            streamInfo.HasCheckedUnknownTags = true;
            const unknownAdTags = textStr.match(/#EXT[^:\\n]*(?:ad|cue|scte|sponsor)[^:\\n]*/gi);
            if (unknownAdTags) {
                const unknown = unknownAdTags.filter(t => !AdSignifiers.some(s => s && t.includes(s)));
                if (unknown.length > 0) {
                    console.log('[AD DEBUG] Unknown ad-related tags found: ' + [...new Set(unknown)].join(', '));
                }
            }
        }
        const haveAdTags = hasAdTags(textStr) || SimulatedAdsDepth > 0;
        // Cache the clean main stream m3u8 for all-stripped recovery fallback.
        // Updated during non-ad polls (outside of any ad break), so by the time an ad
        // break starts, streamInfo.LastCleanNativeM3U8 holds a snapshot ~1-2 seconds old
        // with several live segments. When heavy SSAI breaks leave the main playlist
        // entirely stripped, stripAdSegments replays this snapshot instead of the thin
        // RecoverySegments array — typically gives the player 4-6 live segments of
        // content to chew on vs the 1-2 cached individual segments.
        // Mirrors TTV-AB src/modules/processor.ts:733-736.
        if (!haveAdTags && !streamInfo.IsShowingAd && textStr.indexOf('#EXTINF') !== -1) {
            streamInfo.LastCleanNativeM3U8 = textStr;
            streamInfo.LastCleanNativePlaylistAt = Date.now();
        }
        if (haveAdTags) {
            // Bounce-tolerant reset: keep PendingAdEndAt alive across short flips back to ad-marked
            // so the slow-path max-wait gate can still fire when bouncing markers prevent
            // CleanPlaylistCount from reaching threshold. Mirrors TTV-AB v6.6.7 #1.
            const adEndStalenessMs = 12000;
            if (streamInfo.PendingAdEndAt && (Date.now() - streamInfo.PendingAdEndAt) < adEndStalenessMs) {
                streamInfo.AdEndBounceCount = (streamInfo.AdEndBounceCount || 0) + 1;
            } else {
                streamInfo.PendingAdEndAt = 0;
                streamInfo.AdEndBounceCount = 0;
            }
            streamInfo.CleanPlaylistCount = 0;
            streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            if (!streamInfo.IsShowingAd) {
                streamInfo.IsShowingAd = true;
                streamInfo.AdBreakStartedAt = Date.now();
                const podLengthMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\\d+)"/);
                const podLength = podLengthMatch ? parseInt(podLengthMatch[1], 10) : 1;
                // Reset early-reload state for new ad break; allow up to one early reload per ad in pod
                streamInfo.PodLength = podLength;
                streamInfo.EarlyReloadTriggered = false;
                streamInfo.EarlyReloadCount = 0;
                streamInfo.EarlyReloadAtPoll = 0;
                // Track high-confidence ad markers to distinguish real ads from false-positive signifier matches
                streamInfo.HasConfirmedAdAttrs = textStr.includes('X-TV-TWITCH-AD-AD-SESSION-ID') || textStr.includes('X-TV-TWITCH-AD-RADS-TOKEN');
                streamInfo.CycleRescuedThisBreak = false;
                streamInfo.LastCommittedBackupPlayerType = null;
                streamInfo.FreezeStartedAt = 0;
                streamInfo.CsaiOnlyThisBreak = false;// Reset sticky CSAI flag for new break
                console.log('[AD DEBUG] Ad detected — type: ' + (streamInfo.IsMidroll ? 'midroll' : 'preroll') + ', channel: ' + streamInfo.ChannelName + ', pod: ' + podLength + ' ad(s) (~' + (podLength * 30) + 's expected), signifiers: ' + getMatchedAdSignifiers(textStr).join(', '));
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false
                });
            }
            // Spoof ad-completion every ad-laden poll (not just break-start). Twitch
            // discloses each ad's DATERANGE only as that ad starts, so multi-ad pods
            // surface one ad per poll — notifyAdComplete dedups via SpoofedAdIds so
            // each ad is spoofed once across the break (full N/N coverage).
            if (!DisableAdSpoofing) {
                // Defer off the playlist critical path — synchronous matchAll + parse +
                // JSON.stringify here delays the modified-m3u8 return to the player
                // (ad-break stutter). Next tick is fine; spoof beacons aren't time-critical.
                // (GosuDRM TTV-AB v8.0.0 field finding on this same spoof code.)
                setTimeout(() => notifyAdComplete(textStr, streamInfo), 0);
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.split(/\\r?\\n/);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            // Only request one .ts file per .m3u8 request to avoid making too many requests
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            fetch(lines[i + 1]).then((response) => response.blob()).catch(() => {});
                            break;
                        }
                    }
                }
            }
            const currentResolution = streamInfo.Urls[url];
            if (!currentResolution) {
                console.log('Ads will leak due to missing resolution info for ' + url);
                return stripAdSegments(textStr, false, streamInfo);
            }
            const isHevc = currentResolution.Codecs.startsWith('hev') || currentResolution.Codecs.startsWith('hvc');
            // Post-ad reload-loop guard: at end of break, IsUsingModifiedM3U8 is reset to false.
            // If post-ad continuation markers arrive within ~8s, the next ad-detect fires the
            // HEVC reload AGAIN because the !IsUsingModifiedM3U8 condition is satisfied — causing
            // a redundant player teardown/rebuild cycle ~seconds after the previous reload
            // already settled. Skip the reload if we just reloaded recently; the backup-stream
            // path will handle this break instead.
            const postAdReentryGuardMs = 8000;
            const recentlyReloaded = streamInfo.LastPlayerReload && (Date.now() - streamInfo.LastPlayerReload) < postAdReentryGuardMs;
            if (((isHevc && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8 && !recentlyReloaded) {
                streamInfo.IsUsingModifiedM3U8 = true;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            }
            // Sticky CSAI fast path: if a prior poll in THIS break already confirmed the break
            // is CSAI-only (all segments live on poll 1), stay on the fast path for the rest
            // of the break. stripAdSegments still handles any real EXTINF ad segments that
            // show up on later polls (they get cached and the fetch hook returns BLANK_MP4),
            // so ads are blocked even without the backup switch. Skipping backup search for
            // the whole CSAI break saves ~20 wasted fetches per break — the backup wouldn't
            // help anyway since every player type has the same CSAI ads. Flag is cleared
            // only at break end (IsShowingAd=false path).
            // Sticky CSAI escape hatch (PreferLowQualityBackup): if the sticky path has
            // been stuck in all-stripped state for too long (~8s), fall through to backup
            // search. Gives heavy-SSAI channels a way out of the sticky freeze by trying
            // Source backups + autoplay fallback instead of sitting in recovery loop.
            if (PreferLowQualityBackup && streamInfo.CsaiOnlyThisBreak && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= 4) {
                const stuckPolls = streamInfo.ConsecutiveAllStrippedPolls;
                const recoveryCacheSize = streamInfo.RecoverySegments?.length || 0;
                const earlyReloadInfo = (streamInfo.EarlyReloadCount || 0) + '/' + Math.max(1, streamInfo.PodLength || 1);
                console.log('[AD DEBUG] Sticky CSAI escape hatch — stuck ' + stuckPolls + ' polls (~' + (stuckPolls * 2) + 's), EarlyReloadCount=' + earlyReloadInfo + ', recovery cache=' + recoveryCacheSize + ' segments, falling through to backup search');
                streamInfo.CsaiOnlyThisBreak = false;
                streamInfo.EscapeHatchFired = true;
            }
            if (streamInfo.CsaiOnlyThisBreak && !streamInfo.IsUsingModifiedM3U8) {
                if (IsAdStrippingEnabled) {
                    textStr = stripAdSegments(textStr, false, streamInfo);
                }
                // Early reload during prolonged freeze — mirrors the check in the normal
                // backup-search path (line ~952) which we'd otherwise skip entirely by
                // returning early from the sticky path. Without this, heavy SSAI breaks
                // on CSAI-confirmed streams leave the player replaying the thin recovery
                // cache for the full break duration (observed: 35.9s freeze on pod-1
                // break, 3 all-stripped polls, 1-segment recovery cache).
                // Bounded to maxEarlyReloads per ad in pod so reload loops are impossible.
                // Check early reload result from previous poll (sticky path returns before the normal-path check)
                if (streamInfo.EarlyReloadAwaitingResult) {
                    streamInfo.EarlyReloadAwaitingResult = false;
                    console.log('[AD DEBUG] Early reload result (sticky path): still ads — continuing recovery loop');
                    streamInfo.EarlyReloadTriggered = false;
                }
                const stickyRecoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
                const stickyMaxEarlyReloads = stickyRecoveryThin ? Math.max(2, streamInfo.PodLength || 1) : Math.max(1, streamInfo.PodLength || 1);
                const stickyEffectiveThreshold = stickyRecoveryThin ? 1 : EarlyReloadPollThreshold;
                if (EarlyReloadPollThreshold > 0 && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= stickyEffectiveThreshold && !streamInfo.EarlyReloadTriggered && (streamInfo.EarlyReloadCount || 0) < stickyMaxEarlyReloads) {
                    streamInfo.EarlyReloadTriggered = true;
                    streamInfo.EarlyReloadAwaitingResult = true;
                    streamInfo.EarlyReloadCount = (streamInfo.EarlyReloadCount || 0) + 1;
                    streamInfo.EarlyReloadAtPoll = streamInfo.TotalAllStrippedPolls || streamInfo.ConsecutiveAllStrippedPolls;
                    const stickyReason = stickyRecoveryThin ? ' (thin recovery cache: ' + (streamInfo.RecoverySegments?.length || 0) + ' segments)' : '';
                    console.log('[AD DEBUG] Early reload triggered (sticky path) — ' + streamInfo.ConsecutiveAllStrippedPolls + ' consecutive all-stripped polls' + stickyReason + ' [' + streamInfo.EarlyReloadCount + '/' + stickyMaxEarlyReloads + ']');
                    postMessage({ key: 'ReloadPlayer', kind: 'early' });
                }
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
                    numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
                    activeBackupPlayerType: null
                });
                return textStr;
            }
            // CSAI fast path: if all segments in the main stream are live, skip backup search.
            // CSAI ads are delivered outside the m3u8 — the main stream segments are clean.
            // Just strip tracking URLs and return the main stream directly, avoiding the
            // backup stream switch that causes a 20-40s rebuffer gap.
            const mainStreamLines = textStr.split(/\\r?\\n/);
            let hasNonLiveSegment = false;
            for (let i = 0; i < mainStreamLines.length; i++) {
                if (mainStreamLines[i].startsWith('#EXTINF') && !mainStreamLines[i].includes(',live')) {
                    hasNonLiveSegment = true;
                    break;
                }
            }
            // BackupSwapFirst (opt-in): skip sticky CSAI path entirely, always fall through to
            // backup search on ad detect. Mimics TTV-AB's backup-swap-first flow — avoids
            // MediaSource mixing from strip activity (no BLANK_MP4 injection, no recovery
            // segment replay), which users report produces fewer loading circles. Cost: extra
            // fetches on every ad break (token requests for each backup type tried).
            if (!hasNonLiveSegment && !streamInfo.IsUsingModifiedM3U8 && !BackupSwapFirst) {
                streamInfo.CsaiOnlyThisBreak = true;// Mark break as confirmed CSAI so subsequent polls stay on the fast path
                console.log('[AD DEBUG] CSAI fast path — all segments live, skipping backup search');
                if (IsAdStrippingEnabled) {
                    textStr = stripAdSegments(textStr, false, streamInfo);
                }
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
                    numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
                    activeBackupPlayerType: null
                });
                return textStr;
            }
            const backupSearchStart = Date.now();
            let backupColdTokenFetches = 0;// diag: cold-cache token round-trips this backup search (0 = warm — encodings cache hit)
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                // When doing player reload there are a lot of requests which causes the backup stream to load in slow. Briefly prefer using a single version to prevent long delays
                startIndex = PlayerReloadMinimalRequestsPlayerIndex;
                isDoingMinimalRequests = true;
            }
            // Try pinned backup player type first if available
            // When PreferLowQualityBackup is enabled, append 'autoplay' (360p) as a last-resort
            // fallback — mirrors pixeltris's original behavior. Source backups are tried first;
            // autoplay only kicks in when they're all ad-laden. Keeps Source quality when
            // available while guaranteeing a clean backup for heavy SSAI breaks.
            const playerTypesToTry = PreferLowQualityBackup ? [...BackupPlayerTypes, 'autoplay'] : [...BackupPlayerTypes];
            if (streamInfo.PinnedBackupPlayerType) {
                const pinnedIndex = playerTypesToTry.indexOf(streamInfo.PinnedBackupPlayerType);
                if (pinnedIndex > 0) {
                    playerTypesToTry.splice(pinnedIndex, 1);
                    playerTypesToTry.unshift(streamInfo.PinnedBackupPlayerType);
                }
            }
            // FastAutoplayFirstTry: when the immediately prior break committed autoplay via
            // PreferLowQualityBackup escape hatch (all 4 Source types contaminated), this
            // channel is currently SSAI-uniform — Source-tier probes are wasted ~1.5s of
            // buffering. Try autoplay first instead. If autoplay is contaminated this time,
            // iteration falls through to the rest of playerTypesToTry as normal. If a
            // Source-tier type wins (channel recovered), the "Source committed" branch
            // below resets LastBreakUsedEscapeHatch so the next break does normal iteration.
            // Default on as of v67.1.0. Opt-out via twitchAdSolutions_fastAutoplayFirstTry=false.
            //
            // Periodic re-probe: every Nth consecutive fast-autoplay win, force a full
            // Source-tier probe to catch channel recovery (e.g., Twitch reverses universal
            // CSAI delivery). Without this, once a channel hits fast-autoplay it stays on
            // 360p for the entire session — Source-tier is never re-tested so we'd miss
            // a Source-clean break. Costs ~1.5-2s of probe-loop once every N breaks; N=5
            // means ~25-50min between re-probes at typical break density.
            if (FastAutoplayFirstTry && streamInfo.LastBreakUsedEscapeHatch && PreferLowQualityBackup) {
                const FastAutoplayReprobeInterval = 5;
                const consecutive = streamInfo.FastAutoplayConsecutive || 0;
                if (consecutive >= FastAutoplayReprobeInterval) {
                    // Re-probe: skip the autoplay reorder this break — let Source-tier be
                    // tested. Reset counter; if Source-tier still all ad-laden, the autoplay
                    // commit path below will set LastBreakUsedEscapeHatch=true again and the
                    // cycle resumes. If Source-tier wins, LastBreakUsedEscapeHatch clears.
                    streamInfo.FastAutoplayConsecutive = 0;
                    if (!streamInfo.LoggedFastAutoplayReprobeThisBreak) {
                        streamInfo.LoggedFastAutoplayReprobeThisBreak = true;
                        console.log('[AD DEBUG] Fast-autoplay re-probe — testing Source-tier after ' + consecutive + ' consecutive fast-autoplay breaks (channel-recovery check)');
                    }
                } else {
                    const autoplayIdx = playerTypesToTry.indexOf('autoplay');
                    if (autoplayIdx > 0) {
                        playerTypesToTry.splice(autoplayIdx, 1);
                        playerTypesToTry.unshift('autoplay');
                        if (!streamInfo.LoggedFastAutoplayThisBreak) {
                            streamInfo.LoggedFastAutoplayThisBreak = true;
                            console.log('[AD DEBUG] Fast-autoplay first-try — prior break exhausted Source-tier; probing autoplay first');
                        }
                    }
                }
            }
            // Real-time contamination reorder: on poll 2+ of a break, move types that were
            // already logged as ad-laden earlier in the same break to the end of iteration.
            // Lets untried/clean types (typically autoplay on SSAI-heavy channels like warn)
            // get tried first instead of re-checking types we already know are contaminated.
            // LoggedBackupAdsByType is populated below at the "also has ads" log site and
            // cleared at end-of-break, so this is per-break adaptive.
            if (streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.size > 0) {
                const clean = [];
                const contam = [];
                for (const t of playerTypesToTry) {
                    if (streamInfo.LoggedBackupAdsByType.has(t)) contam.push(t);
                    else clean.push(t);
                }
                if (contam.length > 0 && clean.length > 0) {
                    playerTypesToTry.length = 0;
                    playerTypesToTry.push(...clean, ...contam);
                    if (!streamInfo.LoggedContamReorderThisBreak) {
                        streamInfo.LoggedContamReorderThisBreak = true;
                        console.log('[AD DEBUG] Contamination-aware reorder — trying [' + clean.join(', ') + '] before known-contaminated [' + contam.join(', ') + ']');
                    }
                }
            }
            for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < playerTypesToTry.length; playerTypeIndex++) {
                const playerType = playerTypesToTry[playerTypeIndex];
                const realPlayerType = playerType.replace('-CACHED', '');
                const failedAt = streamInfo.FailedBackupPlayerTypes.get(realPlayerType);
                // 5s (was 15s): in the CSAI-flip world a contaminated backup type can
                // recover within seconds; the 15s lockout kept us off a now-clean type far
                // too long (TTV-AB/GosuDRM v8.0.0 "reduced ad-induced stalling"). Tradeoff:
                // ~3x more retry fetches — watched via the cold/warm token-fetch log (#228).
                if (failedAt && (Date.now() - failedAt) < 5000) {
                    continue;
                }
                const isFullyCachedPlayerType = playerType != realPlayerType;
                for (let i = 0; i < 2; i++) {
                    // This caches the m3u8 if it doesn't have ads. If the already existing cache has ads it fetches a new version (second loop)
                    let isFreshM3u8 = false;
                    let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
                    if (!encodingsM3u8) {
                        isFreshM3u8 = true;
                        backupColdTokenFetches++;
                        try {
                            const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
                            if (accessTokenResponse.status === 200) {
                                const accessToken = await accessTokenResponse.json();
                                // Twitch returns streamPlaybackAccessToken in two observed shapes:
                                //   { data: { streamPlaybackAccessToken: {...} } } (most player types)
                                //   { streamPlaybackAccessToken: {...} } (flatter, observed for 'embed')
                                // Accept either. Field-observed silently dropping embed backup otherwise.
                                const spat = accessToken?.data?.streamPlaybackAccessToken || accessToken?.streamPlaybackAccessToken;
                                if (!spat) {
                                    const errInfo = accessToken?.errors ? ' errors: ' + JSON.stringify(accessToken.errors).substring(0, 300) : '';
                                    console.log('[AD DEBUG] GQL response missing streamPlaybackAccessToken for ' + realPlayerType + '. Response keys: ' + JSON.stringify(Object.keys(accessToken || {})) + errInfo);
                                    streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                                    streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                                    if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                                        streamInfo.LoggedTokenFailureStreak = true;
                                        console.log('[AD DEBUG] Token fetch failed ' + streamInfo.ConsecutiveTokenFetchFailures + ' times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting');
                                    }
                                    continue;
                                }
                                const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                                urlInfo.searchParams.set('sig', spat.signature);
                                urlInfo.searchParams.set('token', spat.value);
                                const encodingsM3u8Response = await realFetch(urlInfo.href);
                                if (encodingsM3u8Response.status === 200) {
                                    encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                                    // Reset detection diagnostic counter on success — token fetched, m3u8 fetched.
                                    streamInfo.ConsecutiveTokenFetchFailures = 0;
                                    streamInfo.LoggedTokenFailureStreak = false;
                                } else {
                                    console.log('[AD DEBUG] Usher HTTP ' + encodingsM3u8Response.status + ' for ' + realPlayerType);
                                }
                            } else {
                                let errorBody = '';
                                try { errorBody = ' — ' + (await accessTokenResponse.text()).substring(0, 200); } catch {}
                                console.log('[AD DEBUG] Access token HTTP ' + accessTokenResponse.status + ' for ' + realPlayerType + (accessTokenResponse.status === 403 ? ' (integrity: ' + (ClientIntegrityHeader ? 'present' : 'missing') + ')' : '') + errorBody);
                                streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                                streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                                if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                                    streamInfo.LoggedTokenFailureStreak = true;
                                    console.log('[AD DEBUG] Token fetch failed ' + streamInfo.ConsecutiveTokenFetchFailures + ' times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting');
                                }
                            }
                        } catch (err) {
                            console.log('[AD DEBUG] Access token failed for ' + realPlayerType + ': ' + err.message);
                            streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                            streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                            if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                                streamInfo.LoggedTokenFailureStreak = true;
                                console.log('[AD DEBUG] Token fetch failed ' + streamInfo.ConsecutiveTokenFetchFailures + ' times consecutively across player types — possible Twitch detection / integrity rotation / rate limiting');
                            }
                        }
                    }
                    if (encodingsM3u8) {
                        try {
                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
                            const streamM3u8Response = await realFetch(streamM3u8Url);
                            if (streamM3u8Response.status == 200) {
                                const m3u8Text = await streamM3u8Response.text();
                                if (m3u8Text) {
                                    if (playerType == FallbackPlayerType) {
                                        fallbackM3u8 = m3u8Text;
                                    }
                                    if ((!hasAdTags(m3u8Text) && (SimulatedAdsDepth == 0 || playerTypeIndex >= SimulatedAdsDepth - 1)) || (!fallbackM3u8 && playerTypeIndex >= playerTypesToTry.length - 1)) {
                                        if ((streamInfo.ConsecutiveAllStrippedPolls || 0) >= 1 && !hasAdTags(m3u8Text)) {
                                            const prevType = streamInfo.LastCommittedBackupPlayerType;
                                            if (prevType && prevType !== playerType) {
                                                console.log('[AD DEBUG] Cycle switched to different clean type (' + playerType + ', was ' + prevType + ') during freeze — recovered without reload');
                                                // Only mark as cycle-rescued when we ACTUALLY switched player types.
                                                // Natural recovery (same type became clean) still needs the end-of-break
                                                // reload to refresh the player buffer — skipping it leaves the player
                                                // stuck with low buffer and the buffer monitor unable to recover.
                                                streamInfo.CycleRescuedThisBreak = true;
                                            } else {
                                                console.log('[AD DEBUG] Same backup type (' + playerType + ') became clean during freeze — natural recovery');
                                            }
                                        }
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                    if (hasAdTags(m3u8Text)) {
                                        if (!streamInfo.LoggedBackupAdsByType) streamInfo.LoggedBackupAdsByType = new Set();
                                        if (!streamInfo.LoggedBackupAdsByType.has(playerType)) {
                                            streamInfo.LoggedBackupAdsByType.add(playerType);
                                            console.log('[AD DEBUG] Backup stream (' + playerType + ') also has ads');
                                        }
                                    }
                                    if (isFullyCachedPlayerType || isDoingMinimalRequests) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                    // Cycle through all player types looking for a clean backup. Only commit
                                    // an ad-laden backup as a last resort when we've exhausted all options.
                                    // PR #89 previously committed the first ad-laden type immediately — that
                                    // caused the v58 freeze regression (issue #112) because the strip+recovery
                                    // loop would engage even when a clean alternate was available on another
                                    // player type.
                                    if (hasAdTags(m3u8Text) && playerTypeIndex >= playerTypesToTry.length - 1) {
                                        console.log('[AD DEBUG] All backup player types ad-laden — taking ' + playerType + ' as last-resort fallback (strip+recovery path will engage)');
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                }
                            } else {
                                console.log('[AD DEBUG] Backup stream fetch failed for ' + playerType + ' (status ' + streamM3u8Response.status + ')');
                            }
                        } catch (err) {
                            console.log('[AD DEBUG] Backup stream error for ' + playerType + ': ' + err.message);
                        }
                    }
                    streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
                    if (isFreshM3u8) {
                        break;
                    }
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                // Don't fall back to a type we've already marked contaminated this break.
                // Without this guard, when all Source types go ad-laden mid-break the iteration
                // ends with no clean commit AND fallbackM3u8 still pointing at FallbackPlayerType's
                // ad-laden m3u8 — we'd silently re-commit the same contaminated site on every poll
                // (no "Blocking ads" log because ActiveBackupPlayerType unchanged), and the user
                // sees the full ad pod with no indication of failure. Better to leave backupM3u8
                // null and let the "No ad-free backup stream found" log fire so it's visible.
                if (streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.has(FallbackPlayerType)) {
                    console.log('[AD DEBUG] Skipping fallback to ' + FallbackPlayerType + ' — marked contaminated this break (' + [...streamInfo.LoggedBackupAdsByType].join(', ') + ' all ad-laden)');
                } else {
                    backupPlayerType = FallbackPlayerType;
                    backupM3u8 = fallbackM3u8;
                }
            }
            // Stale-commit guard: multiple processM3U8 calls can be in flight concurrently for
            // the same streamInfo (one per m3u8 poll). If this backup search started during the
            // ad break but completed AFTER a later poll already ran the end-of-break reset
            // (IsShowingAd = false, ActiveBackupPlayerType = null), committing the backup here
            // would overwrite the cleared state and feed stale playlist data to the player,
            // causing buffer reconciliation failures and a forced reload. Check IsShowingAd
            // here to discard stale results.
            if (backupM3u8 && streamInfo.IsShowingAd) {
                textStr = backupM3u8;
                streamInfo.LastCommittedBackupPlayerType = backupPlayerType;
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    const sourceQualityTypes = ['embed', 'site', 'popout'];
                    // Never pin 'autoplay'. PreferLowQualityBackup keeps autoplay as the LAST
                    // entry in playerTypesToTry so the iteration-end last-resort branch can
                    // commit it when all Source types are ad-laden. Pinning autoplay would
                    // move it to position 0, which makes the last-resort branch commit a
                    // different ad-laden Source type at the new last position instead — user
                    // gets a Source-tier ad-marked backup (strip+recovery path engages,
                    // freezes likely) instead of the intended 360p clean autoplay backup.
                    if ((PinBackupPlayerType && backupPlayerType !== 'autoplay') || sourceQualityTypes.includes(backupPlayerType)) {
                        streamInfo.PinnedBackupPlayerType = backupPlayerType;
                    }
                    console.log(\`[AD DEBUG] Blocking\${(streamInfo.IsMidroll ? ' midroll ' : ' ')}ads (\${backupPlayerType}) — backup found in \${Date.now() - backupSearchStart}ms\${backupColdTokenFetches > 0 ? \` (cold cache: \${backupColdTokenFetches} token fetch\${backupColdTokenFetches > 1 ? 'es' : ''})\` : ' (warm cache)'}\`);
                    if (streamInfo.EscapeHatchFired) {
                        const qualityTier = backupPlayerType === 'autoplay' ? '360p' : 'Source';
                        console.log('[AD DEBUG] Post-escape backup: ' + backupPlayerType + ' (' + qualityTier + ') — recovered from sticky-path freeze');
                    } else if (backupPlayerType === 'autoplay' && PreferLowQualityBackup) {
                        const sourceTried = streamInfo.LoggedBackupAdsByType?.size || 0;
                        if (sourceTried === 0) {
                            console.log('[AD DEBUG] Autoplay backup committed — 360p pinned from prior break (PreferLowQualityBackup)');
                            // Fast-autoplay won without testing Source-tier — increment re-probe counter
                            streamInfo.FastAutoplayConsecutive = (streamInfo.FastAutoplayConsecutive || 0) + 1;
                        } else {
                            console.log('[AD DEBUG] Autoplay backup committed — 360p fallback after ' + sourceTried + ' Source type(s) ad-laden (PreferLowQualityBackup)');
                        }
                        // FastAutoplayFirstTry: only flag the channel as SSAI-uniform when 4 Source
                        // types were probed and all contaminated. The "0 sourceTried" case (pinned
                        // from prior break) doesn't add new information.
                        if (FastAutoplayFirstTry && sourceTried >= 4) {
                            streamInfo.LastBreakUsedEscapeHatch = true;
                            // Full probe just ran — reset re-probe counter (we just tested Source-tier)
                            streamInfo.FastAutoplayConsecutive = 0;
                        }
                    } else if (FastAutoplayFirstTry && backupPlayerType !== 'autoplay') {
                        // Source-tier type committed cleanly — channel recovered. Reset the
                        // SSAI-uniform signal so next break does normal iteration. Also reset
                        // the re-probe counter since we just got a Source-tier win.
                        streamInfo.LastBreakUsedEscapeHatch = false;
                        streamInfo.FastAutoplayConsecutive = 0;
                    }
                }
            } else if (backupM3u8 && !streamInfo.IsShowingAd) {
                console.log('[AD DEBUG] Discarded stale backup commit (' + backupPlayerType + ', ' + (Date.now() - backupSearchStart) + 'ms) — break ended during search');
            } else {
                console.log('[AD DEBUG] No ad-free backup stream found — ads may leak. Tried: ' + playerTypesToTry.slice(startIndex).join(', '));
            }
            // TODO: Improve hevc stripping. It should always strip when there is a codec mismatch (both ways)
            const stripHevc = isHevc && streamInfo.ModifiedM3U8;
            if (IsAdStrippingEnabled || stripHevc) {
                textStr = stripAdSegments(textStr, stripHevc, streamInfo);
            } else if (!backupM3u8) {
                console.log('[AD DEBUG] Ad stripping disabled and no backup — ads WILL show');
            }
            // Log reload outcome on the poll after early reload triggered
            if (streamInfo.EarlyReloadAwaitingResult) {
                streamInfo.EarlyReloadAwaitingResult = false;
                if (textStr.includes(',live') && streamInfo.IsStrippingAdSegments) {
                    console.log('[AD DEBUG] Early reload result: partial — some live segments returned');
                } else if (!streamInfo.IsStrippingAdSegments) {
                    console.log('[AD DEBUG] Early reload result: clean — freeze ended');
                    // Reset trigger flag so subsequent freezes within the same pod can re-fire (bounded by EarlyReloadCount/PodLength)
                    streamInfo.EarlyReloadTriggered = false;
                } else {
                    console.log('[AD DEBUG] Early reload result: still ads — continuing recovery loop');
                    streamInfo.EarlyReloadTriggered = false;
                }
            }
            // Early reload during prolonged freeze: if we've been looping recovery segments
            // for N+ polls (~Nx2s), trigger a reload to attempt fresh content. Bounded to one
            // reload per ad in the pod (e.g. 2-ad pod = up to 2 early reloads).
            const recoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
            const maxEarlyReloads = recoveryThin ? Math.max(2, streamInfo.PodLength || 1) : Math.max(1, streamInfo.PodLength || 1);
            const effectiveThreshold = recoveryThin ? 1 : EarlyReloadPollThreshold;
            if (EarlyReloadPollThreshold > 0 && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= effectiveThreshold && !streamInfo.EarlyReloadTriggered && (streamInfo.EarlyReloadCount || 0) < maxEarlyReloads) {
                streamInfo.EarlyReloadTriggered = true;
                streamInfo.EarlyReloadAwaitingResult = true;
                streamInfo.EarlyReloadCount = (streamInfo.EarlyReloadCount || 0) + 1;
                streamInfo.EarlyReloadAtPoll = streamInfo.TotalAllStrippedPolls || streamInfo.ConsecutiveAllStrippedPolls;
                const reason = recoveryThin ? ' (thin recovery cache: ' + (streamInfo.RecoverySegments?.length || 0) + ' segments)' : '';
                console.log('[AD DEBUG] Early reload triggered — ' + streamInfo.ConsecutiveAllStrippedPolls + ' consecutive all-stripped polls' + reason + ' [' + streamInfo.EarlyReloadCount + '/' + maxEarlyReloads + ']');
                postMessage({ key: 'ReloadPlayer', kind: 'early' });
            }
        } else if (streamInfo.IsShowingAd) {
            // Mark first candidate-end timestamp on the first clean poll seen this break,
            // so the slow-path max-wait gate below can fire even if subsequent polls bounce
            // back to ad-marked. The bounce-tolerant haveAdTags reset keeps this alive
            // across short flips. Mirrors TTV-AB v6.6.7 #1.
            if (!streamInfo.PendingAdEndAt) {
                streamInfo.PendingAdEndAt = Date.now();
            }
            streamInfo.CleanPlaylistCount++;
            // Check if the current playlist has live segments — if not, backup stream is dead
            const hasLiveSegments = textStr.includes(',live');
            // Independent slow-path max-wait escalation — ends the visible ad cycle even when
            // marker bouncing keeps CleanPlaylistCount below threshold. Without this, the player
            // could be wedged on backup indefinitely on channels where Twitch flips markers
            // in/out faster than 3 consecutive clean polls can land. Mirrors TTV-AB v6.6.7 #4
            // ("Decoupled Slow-Path Recovery from Clean-Count").
            const adEndMaxWaitMs = 12000;
            const elapsedSinceCandidate = Date.now() - streamInfo.PendingAdEndAt;
            const slowPathReady = streamInfo.PendingAdEndAt > 0 && elapsedSinceCandidate >= adEndMaxWaitMs;
            // Require 3 consecutive clean polls before declaring ad-end. Previously only 1
            // when NumStrippedAdSegments === 0 (CSAI-only / backup-swap path) and 2 otherwise,
            // which let brief clean windows during ongoing breaks flip IsShowingAd false
            // prematurely on SSAI-uniform channels. TTV-AB hit the same false-positive at 2
            // probes and bumped to 3 in v6.6.7 ("Ad-End Re-Entry Stability") — Twitch can
            // serve a clean playlist mid-break before re-injecting markers, and 2 polls
            // (~4s) wasn't always enough to ride out the bounce.
            if (streamInfo.CleanPlaylistCount >= 3 || !hasLiveSegments || slowPathReady) {
                if (slowPathReady && streamInfo.CleanPlaylistCount < 3) {
                    console.log('[AD DEBUG] Slow-path ad-end escalation — ' + (streamInfo.AdEndBounceCount || 0) + ' marker bounces, ' + (elapsedSinceCandidate / 1000).toFixed(1) + 's since first clean poll');
                }
                if (!hasLiveSegments) {
                    console.log('[AD DEBUG] Backup stream has no live segments — forcing immediate reload');
                }
                const adBreakDurationSec = streamInfo.AdBreakStartedAt ? ((Date.now() - streamInfo.AdBreakStartedAt) / 1000).toFixed(1) : '?';
                console.log('[AD DEBUG] Finished blocking ads — stripped ' + streamInfo.NumStrippedAdSegments + ' ad segments, duration: ' + adBreakDurationSec + 's');
                if (streamInfo.TotalAllStrippedPolls > 0) {
                    const reloadInfo = streamInfo.EarlyReloadAtPoll ? ', early reload at poll ' + streamInfo.EarlyReloadAtPoll : '';
                    const wallClockFreeze = streamInfo.FreezeStartedAt ? ((Date.now() - streamInfo.FreezeStartedAt) / 1000).toFixed(1) + 's wall-clock' : 'unknown';
                    console.log('[AD DEBUG] Ad break stats: ' + streamInfo.TotalAllStrippedPolls + ' all-stripped polls, freeze duration: ' + wallClockFreeze + reloadInfo);
                }
                const hadStrippedSegments = streamInfo.NumStrippedAdSegments > 0;
                // Only count toward false-positive guard if the m3u8 lacked high-confidence ad markers.
                // Confirmed ads (with X-TV-TWITCH-AD-AD-SESSION-ID etc.) that produce 0 strips are real ads
                // we successfully avoided via clean backup — not false positives.
                if (!hadStrippedSegments && !streamInfo.HasConfirmedAdAttrs) {
                    streamInfo.ConsecutiveZeroStripBreaks++;
                    if (streamInfo.ConsecutiveZeroStripBreaks >= 3) {
                        console.log('[AD DEBUG] Warning: ' + streamInfo.ConsecutiveZeroStripBreaks + ' consecutive unconfirmed ad breaks with 0 segments stripped — possible false positive from ad signifiers');
                    }
                } else if (hadStrippedSegments || streamInfo.HasConfirmedAdAttrs) {
                    // Reset is symmetric with the increment guard above — any positive "break
                    // was handled cleanly" signal resets the false-positive history. Previously
                    // only stripped>0 reset the counter, which let stale suspicious history
                    // bleed across legitimately-handled backup-swap breaks (0 stripped + real
                    // ad attrs) and trigger the warning on partially-stale state.
                    streamInfo.ConsecutiveZeroStripBreaks = 0;
                }
                streamInfo.IsShowingAd = false;
                streamInfo.IsStrippingAdSegments = false;
                streamInfo.NumStrippedAdSegments = 0;
                streamInfo.ActiveBackupPlayerType = null;
                streamInfo.RequestedAds?.clear?.();
                streamInfo.SpoofedAdIds?.clear?.();// New break = fresh ad-spoof dedup set
                streamInfo.FailedBackupPlayerTypes?.clear?.();
                if (streamInfo.LoggedBackupAdsByType) streamInfo.LoggedBackupAdsByType.clear();
                streamInfo.LoggedContamReorderThisBreak = false;
                streamInfo.CleanPlaylistCount = 0;
                streamInfo.PendingAdEndAt = 0;
                streamInfo.AdEndBounceCount = 0;
                streamInfo.ConsecutiveAllStrippedPolls = 0;
                streamInfo.EarlyReloadTriggered = false;
                streamInfo.EarlyReloadAwaitingResult = false;
                streamInfo.EarlyReloadAtPoll = 0;
                streamInfo.TotalAllStrippedPolls = 0;
                streamInfo.CsaiOnlyThisBreak = false;
                streamInfo.EscapeHatchFired = false;
                streamInfo.HasLoggedAdAttributes = false;
                streamInfo.HasLoggedUnknownSignifiers = false;
                streamInfo.LoggedFastAutoplayThisBreak = false;
                streamInfo.LoggedFastAutoplayReprobeThisBreak = false;
                // CSAI-only ad break: no segments were stripped — skip reload entirely.
                if (!hadStrippedSegments) {
                    console.log('[AD DEBUG] CSAI-only ad break (stripped 0) — clearing backup without player action');
                    streamInfo.IsUsingModifiedM3U8 = false;
                    // Exception: if ANY backup was committed during this break (escape hatch
                    // or cycle rescue that didn't meet cycleRescuedCleanly criteria), the
                    // MediaSource buffer has accumulated mixed-source segments (backup-fetched
                    // via alternate player-type access token + native-fetched). Mixing can
                    // cause audio/video track timestamps to diverge, and without a reload the
                    // drift compounds across subsequent escape-hatch breaks. Force a hard reload
                    // to flush the MediaSource buffer + refresh the access token.
                    // For autoplay (360p) specifically, the reload also restores Source
                    // quality (autoplay-scoped token only serves 360p variant ladder).
                    if (streamInfo.LastCommittedBackupPlayerType) {
                        const isAutoplay = streamInfo.LastCommittedBackupPlayerType === 'autoplay';
                        const reason = isAutoplay ? 'autoplay (360p) — restoring Source quality' : streamInfo.LastCommittedBackupPlayerType + ' — flushing MediaSource to prevent A/V desync accumulation';
                        console.log('[AD DEBUG] End-of-break reload: ' + reason);
                        streamInfo.LastPlayerReload = Date.now();
                        if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
                        streamInfo.ReloadTimestamps.push(Date.now());
                        postMessage({ key: 'ReloadPlayer', kind: 'early' });
                    }
                } else {
                // Auto-escalate cooldown: if 3+ reloads in last 5 min, triple the cooldown
                if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
                streamInfo.ReloadTimestamps = streamInfo.ReloadTimestamps.filter(t => Date.now() - t < 300000);
                const recentReloads = streamInfo.ReloadTimestamps.filter(t => Date.now() - t < 300000).length;
                const effectiveCooldown = recentReloads >= 3 ? ReloadCooldownSeconds * 3 : ReloadCooldownSeconds;
                const tooSoonSinceLastReload = streamInfo.LastPlayerReload && (Date.now() - streamInfo.LastPlayerReload) < (effectiveCooldown * 1000);
                // Skip end-of-break reload when cycle rescue handled the break cleanly:
                // a freeze of ≤2 polls (~4s) was resolved by switching to a clean backup,
                // and no early reload was needed. The player is on a healthy backup stream
                // — reloading just to return to the canonical player type causes an unnecessary
                // ~1-2s loading circle.
                const cycleRescuedCleanly = streamInfo.CycleRescuedThisBreak &&
                    (streamInfo.TotalAllStrippedPolls || 0) <= 2 &&
                    (streamInfo.EarlyReloadCount || 0) === 0;
                if (cycleRescuedCleanly) {
                    console.log('[AD DEBUG] Cycle rescue handled the break cleanly — skipping end-of-break reload');
                }
                // Post-ad reload bypasses cooldown: it's a buffer flush tied to natural break
                // end, not a cascade-risk retry. The ad break cycle itself rate-limits this
                // path (once per break). Cooldown still gates buffer-monitor and other
                // cascade-risk paths that can fire repeatedly in-break.
                const shouldReload = streamInfo.IsUsingModifiedM3U8 || (ReloadPlayerAfterAd && hadStrippedSegments && !cycleRescuedCleanly);
                if (shouldReload) {
                    streamInfo.ReloadTimestamps.push(Date.now());
                    streamInfo.IsUsingModifiedM3U8 = false;
                    streamInfo.LastPlayerReload = Date.now();
                    // Hard reload when buffer may be dirty from strip or m3u8 modification —
                    // soft reload preserves the existing MediaSource buffer, and any
                    // timestamp weirdness from strip/BLANK_MP4/recovery injection persists
                    // across it, causing audio/video desync over time.
                    postMessage({
                        key: 'ReloadPlayer',
                        kind: 'early'
                    });
                } else {
                    if (tooSoonSinceLastReload) {
                        console.log('[AD DEBUG] Skipping reload — last reload was ' + ((Date.now() - streamInfo.LastPlayerReload) / 1000).toFixed(0) + 's ago (cooldown: ' + effectiveCooldown + 's' + (recentReloads >= 3 ? ', auto-escalated from ' + recentReloads + ' reloads in 5min' : '') + ')');
                    }
                    postMessage({
                        key: 'PauseResumePlayer'
                    });
                }
                }// end else (non-CSAI path)
            }
        }
        postMessage({
            key: 'UpdateAdBlockBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: streamInfo.IsShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
            activeBackupPlayerType: streamInfo.ActiveBackupPlayerType
        });
        return textStr;
    }
    function parseAttributes(str) {
        if (!str) return {};
        // Normalize: always pass only attribute section
        if (str.charCodeAt(0) === 35) { // '#'
            const idx = str.indexOf(':');
            if (idx !== -1) str = str.slice(idx + 1);
        }
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map(x => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
            }));
    }
    // Request a playback access token from Twitch GQL using the given player type
    function getAccessToken(channelName, playerType) {
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: playerType,
                platform: playerType == 'autoplay' ? 'android' : 'web'
            },
            extensions: {
                persistedQuery: {
                    version:1,
                    sha256Hash:"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body);
    }
    // Send a GQL request to Twitch via the main thread (workers can't make credentialed requests)
    function gqlRequest(body) {
        if (!GQLDeviceID) {
            GQLDeviceID = '';
            const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const dcharactersLength = dcharacters.length;
            for (let i = 0; i < 32; i++) {
                GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
            }
        }
        let headers = {
            'Client-ID': ClientID,
            'X-Device-Id': GQLDeviceID,
            'Authorization': AuthorizationHeader,
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader}),
            ...(ClientVersion && {'Client-Version': ClientVersion}),
            ...(ClientSession && {'Client-Session-Id': ClientSession})
        };
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            const timeoutId = setTimeout(() => {
                if (pendingFetchRequests.has(requestId)) {
                    pendingFetchRequests.delete(requestId);
                    reject(new Error('FetchRequest timed out'));
                }
            }, 15000);
            pendingFetchRequests.set(requestId, {
                resolve,
                reject,
                timeoutId
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    let playerForMonitoringBuffering = null;
    let driftCatchUpInterval = null;
    let driftCatchUpTimeout = null;
    function startDriftCorrection(videoElement) {
        if (DriftCorrectionRate <= 1) return;
        if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
        if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
        videoElement.playbackRate = DriftCorrectionRate;
        console.log('[AD DEBUG] Drift correction: catching up at ' + DriftCorrectionRate + 'x');
        driftCatchUpInterval = setInterval(() => {
            try {
                const vid = document.querySelector('video');
                if (vid && vid.buffered.length > 0) {
                    if (vid.buffered.end(vid.buffered.length - 1) - vid.currentTime <= 1) {
                        vid.playbackRate = 1.0;
                        console.log('[AD DEBUG] Drift correction complete — resumed normal playback speed');
                        clearInterval(driftCatchUpInterval); driftCatchUpInterval = null;
                        if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
                    }
                }
            } catch { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
        }, 500);
        driftCatchUpTimeout = setTimeout(() => {
            try { videoElement.playbackRate = 1.0; } catch {}
            if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
            driftCatchUpTimeout = null;
        }, 30000);
    }
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        fixAttempts: 0,
        lastFixTime: 0,
        isLive: true,
        lastBackupSwitchAt: 0,
        lastReloadAt: 0,
        recoveryReloadUsed: false,
        userPauseIntent: false,
        loggedPauseIntent: false,
        weJustPaused: 0,
        inAdBreak: false,
        vaftEverUnmuted: false
    };
    // Poll the player state to detect and fix buffering caused by ad stream switching
    function monitorPlayerBuffering() {
        // Fresh player lookup every tick (avoids stale ref when Twitch restarts its own player)
        playerForMonitoringBuffering = null;
        {
            const playerAndState = getPlayerAndState();
            if (playerAndState && playerAndState.player && playerAndState.state) {
                playerForMonitoringBuffering = {
                    player: playerAndState.player,
                    state: playerAndState.state
                };
                const video = playerAndState.player.getHTMLVideoElement?.();
                if (video && !video.__tasIntentHooked) {
                    video.__tasIntentHooked = true;
                    video.addEventListener('pause', () => {
                        if (!playerBufferState.weJustPaused || (Date.now() - playerBufferState.weJustPaused) > 2000) {
                            playerBufferState.userPauseIntent = true;
                        }
                    });
                    video.addEventListener('play', () => {
                        playerBufferState.userPauseIntent = false;
                        playerBufferState.loggedPauseIntent = false;
                    });
                }
            }
        }
        if (playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const state = playerForMonitoringBuffering.state;
                if (!player.core) {
                    playerForMonitoringBuffering = null;
                } else if (state.props?.content?.type === 'live' && !player.isPaused() && !player.getHTMLVideoElement()?.ended && (player.getHTMLVideoElement()?.readyState ?? 0) >= 1 && playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay && !isActivelyStrippingAds && !playerBufferState.inAdBreak && (!playerBufferState.lastReloadAt || Date.now() - playerBufferState.lastReloadAt >= 15000) && (!playerBufferState.lastBackupSwitchAt || Date.now() - playerBufferState.lastBackupSwitchAt >= 10000)) {
                    const m3u8Url = player.core?.state?.path;
                    if (m3u8Url) {
                      const lastSlash = m3u8Url.lastIndexOf('/');
                      const queryStart = m3u8Url.indexOf('?', lastSlash);
                      const fileName = m3u8Url.substring(lastSlash + 1, queryStart !== -1 ? queryStart : undefined);
                      if (fileName?.endsWith('.m3u8')) {
                          const channelName = fileName.slice(0, -5);
                          if (playerBufferState.channelName != channelName) {
                              playerBufferState.channelName = channelName;
                              playerBufferState.hasStreamStarted = false;
                              playerBufferState.numSame = 0;
                              playerBufferState.fixAttempts = 0;
                              playerBufferState.recoveryReloadUsed = false;
                              playerBufferState.userPauseIntent = false;
                              playerBufferState.loggedPauseIntent = false;
                          }
                      }
                    }
                    if (player.getState() === 'Playing') {
                        playerBufferState.hasStreamStarted = true;
                    }
                    const position = player.core?.state?.position;
                    const bufferedPosition = player.core?.state?.bufferedPosition;
                    const bufferDuration = player.getBufferDuration();
                    // video.currentTime is the source of truth for actual playback progress —
                    // player.core.state.position updates in batches on reload-heavy channels
                    // (see PR #183 commit msg), so it can appear frozen for ~12s even while
                    // the video element is advancing smoothly. Used in the stall trigger below
                    // alongside state.position so a real stall (BOTH frozen) is required to
                    // fire, not just a batch-update lull in state.position.
                    const videoEl = player.getHTMLVideoElement?.();
                    const videoCurrentTime = videoEl?.currentTime;
                    if (position !== undefined && bufferedPosition !== undefined) {
                        // NOTE: This could be improved. It currently lets the player fully eat the full buffer before it triggers pause/play
                        // Skip the buffer-stall check entirely while the <video> element isn't actively
                        // trying to play. Two states this catches:
                        //   readyState < 2 (HAVE_CURRENT_DATA) — MSE init / seek in flight / fresh post-
                        //     reload load. currentTime and state.position are both genuinely 0 here, but
                        //     it's an initialization state, not a stall — escalating would loop reloads.
                        //   videoEl.paused === true — the outer block already gates on
                        //     player.isPaused()===false, but the IVS player wrapper and the underlying
                        //     <video>.paused can disagree briefly during reload teardown / autoplay-policy
                        //     mute toggles. When <video>.paused is true the player isn't trying to play
                        //     so "stalled" is the wrong word.
                        // Hold counters (don't increment, don't reset): a real stall sequence interrupted
                        // by a brief init dip resumes counting on the next active poll.
                        const playerNotActivelyPlaying = videoEl && (videoEl.readyState < 2 || videoEl.paused);
                        // FFZ's audio compressor wraps player.load() and creates a fresh <video>
                        // element on every load (src/sites/shared/player.jsx replaceVideoElement).
                        // Twitch's playback-monitor then snaps the new element to "buffered region
                        // 0.04xxx" while the buffer rebuilds. During that brief ramp-up window,
                        // currentTime plateaus and state.position is also at its post-reload reset
                        // — exactly the positionFrozen pattern. Detect the swap by element identity
                        // and treat it like a fresh reload (clear counters, set the recovery flag
                        // so the next active poll grants grace).
                        if (videoEl && playerBufferState.videoElement && playerBufferState.videoElement !== videoEl) {
                            playerBufferState.numSame = 0;
                            playerBufferState.fixAttempts = 0;
                            playerBufferState.recoveryReloadUsed = false;
                        }
                        playerBufferState.videoElement = videoEl;
                        // Stall trigger: position-frozen check now requires BOTH state.position
                        // AND video.currentTime unchanged. If currentTime is advancing the player
                        // is playing fine and we should not "fix" anything — the false-fires
                        // were causing user-visible 8s-cadence abrupts on low-latency / post-
                        // quality-change states.
                        const positionFrozen = (playerBufferState.position == position) &&
                            (playerBufferState.videoCurrentTime === undefined || playerBufferState.videoCurrentTime === videoCurrentTime);
                        if (playerNotActivelyPlaying) {
                            // Skip — neither increment nor reset, just hold state.
                        } else if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            // Tighten to AND: a real stall is BOTH frozen position AND a draining buffer.
                            // Field reports on Firefox at live edge showed the OR form firing during normal
                            // thin-buffer breathing (~1-2s buffered, currentTime briefly idle waiting on a
                            // segment fetch) — pause/play would then knock the player back to readyState=1
                            // and currentTime=0, snowballing into a self-reinforcing reload cascade. With
                            // AND, real stalls (frozen + buffer drained below DangerZone) still fire on the
                            // same poll cadence; healthy thin-buffer feeds no longer trip it.
                            // ReYohoho: 0.1s threshold — live-edge breathing at 0.3-0.5s is normal; pause/play
                            // there triggers Twitch PAUSE_ADS and leaves the player stuck at t=0.
                            // Also require readyState < 3: a HAVE_FUTURE_DATA+ element still has decodable
                            // frames, so the frozen position is a transient live-edge lull, not a real stall.
                            // Field log: pause/play fired at readyState=4 / bufferDuration=0.085 and tore the
                            // IVS player down to t=0, cascading into repeated watchdog hard reloads.
                            (positionFrozen && bufferDuration < 0.1 && (videoEl?.readyState ?? 0) < 3)  &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                playerBufferState.fixAttempts++;
                                // Cap: at most ONE reload per recovery window. After reloading once,
                                // stay on pause/play until playback recovers. Prevents reload cascades.
                                const wouldEscalate = playerBufferState.fixAttempts >= 3;
                                const escalateToReload = wouldEscalate && (DisableReloadCap || !playerBufferState.recoveryReloadUsed);
                                const reloadCapNote = wouldEscalate && !escalateToReload ? ' (reload cap reached, pause/play only — set twitchAdSolutions_disableReloadCap=true to bypass)' : (escalateToReload ? ' (escalating to reload)' : '');
                                console.log('Attempt to fix buffering position:' + playerBufferState.position + ' bufferedPosition:' + playerBufferState.bufferedPosition + ' bufferDuration:' + playerBufferState.bufferDuration + reloadCapNote);
                                // Seek past buffer gap instead of stalling + drift to recover
                                const video = player.getHTMLVideoElement?.();
                                if (video && video.buffered.length > 1) {
                                    for (let bi = 0; bi < video.buffered.length; bi++) {
                                        if (video.buffered.start(bi) > video.currentTime + 0.5) {
                                            console.log('[AD DEBUG] Seeking past ' + (video.buffered.start(bi) - video.currentTime).toFixed(1) + 's buffer gap');
                                            video.currentTime = video.buffered.start(bi);
                                            startDriftCorrection(video);
                                            break;
                                        }
                                    }
                                }
                                if (video) {
                                    console.log('[AD DEBUG] Video state: readyState=' + video.readyState + ' networkState=' + video.networkState + ' buffered=' + (video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1).toFixed(1) : 0) + ' currentTime=' + video.currentTime.toFixed(1) + ' paused=' + video.paused);
                                }
                                const isPausePlay = escalateToReload ? false : !PlayerBufferingDoPlayerReload;
                                const isReload = escalateToReload ? true : PlayerBufferingDoPlayerReload;
                                doTwitchPlayerTask(isPausePlay, isReload);
                                playerBufferState.lastFixTime = Date.now();
                                playerBufferState.numSame = 0;
                                if (escalateToReload) {
                                    playerBufferState.fixAttempts = 0;
                                    playerBufferState.recoveryReloadUsed = true;
                                }
                            }
                        } else {
                            playerBufferState.numSame = 0;
                            playerBufferState.fixAttempts = 0;
                            playerBufferState.recoveryReloadUsed = false;
                        }
                        // Detect position jump (native gap recovery) — drift to catch up.
                        // Skip during ad breaks and 10s after: backup stream switching causes buffer gaps that trigger false jumps.
                        // Rate-limit to once per 30s: field-observed on warn that Twitch's player.core.state.position
                        // jumps ~60s every ~12s on reload-heavy channels (likely batch updates from m3u8 manifest
                        // refreshes / program-date-time sync points, not real drift). Our 1.1x videoElement.playbackRate
                        // doesn't affect state.position anyway, so re-firing every 12s is useless log spam — the catch-up
                        // operates on currentTime which is already at live edge. Rate-limit collapses the spam to a
                        // single drift attempt per 30s window, leaving real-drift paths (buffer-gap seek, post-reload)
                        // unaffected since they call startDriftCorrection() directly without going through this detector.
                        if (playerBufferState.position > 0 && position - playerBufferState.position > 5 && !playerBufferState.inAdBreak && (!playerBufferState.lastBackupSwitchAt || Date.now() - playerBufferState.lastBackupSwitchAt >= 10000) && (!playerBufferState.lastDriftStartedAt || Date.now() - playerBufferState.lastDriftStartedAt >= 30000)) {
                            console.log('[AD DEBUG] Position jumped ' + (position - playerBufferState.position).toFixed(1) + 's — starting drift correction');
                            startDriftCorrection(player.getHTMLVideoElement?.());
                            playerBufferState.lastDriftStartedAt = Date.now();
                        }
                        playerBufferState.position = position;
                        playerBufferState.videoCurrentTime = videoCurrentTime;
                        playerBufferState.bufferedPosition = bufferedPosition;
                        playerBufferState.bufferDuration = bufferDuration;
                    } else {
                        playerBufferState.numSame = 0;
                    }
                }
            } catch (err) {
                console.error('error when monitoring player for buffering: ' + err);
                playerForMonitoringBuffering = null;
            }
        }
        // Loading-circle health check: during an ad strip+recovery loop the normal buffer monitor
        // is gated off (isActivelyStrippingAds), so a visibly stalled player would otherwise wait
        // for the worker's poll-based early reload (~10s). This catches the visible stall ~3s after
        // it starts and triggers a reload directly, eliminating most of the loading-circle window.
        if (isActivelyStrippingAds && playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const video = player?.getHTMLVideoElement?.();
                if (video && !video.ended && !playerBufferState.userPauseIntent) {
                    // Track whether the player has ever had data — distinguishes a real stall
                    // (had data, lost data) from initial player init (never had data yet).
                    // Without this, fresh page load + preroll causes PR #96 to misfire repeatedly
                    // because readyState=0 is normal during init.
                    if (video.readyState >= 3) {
                        playerBufferState.hasHadData = true;
                    }
                    const isStalled = video.readyState < 3 && (video.paused || video.networkState === 2);
                    const stallReloadCooldown = 15000;
                    const cooldownExpired = !playerBufferState.lastAdStallReloadAt || (Date.now() - playerBufferState.lastAdStallReloadAt) > stallReloadCooldown;
                    // Don't fire loading-circle reload if ANY reload happened recently — readyState=0
                    // is the expected transient state during a reload's MediaSource teardown. Without
                    // this, an early-reload in flight can trigger a redundant loading-circle reload.
                    const recentReload = playerBufferState.lastReloadAt && (Date.now() - playerBufferState.lastReloadAt) < stallReloadCooldown;
                    if (isStalled && cooldownExpired && !recentReload && playerBufferState.hasHadData) {
                        if (!playerBufferState.adStallStartAt) {
                            playerBufferState.adStallStartAt = Date.now();
                        } else if ((Date.now() - playerBufferState.adStallStartAt) > 3000) {
                            console.log('[AD DEBUG] Loading circle detected during ad break (' + ((Date.now() - playerBufferState.adStallStartAt) / 1000).toFixed(1) + 's stall, readyState=' + video.readyState + ') — early reload');
                            playerBufferState.lastAdStallReloadAt = Date.now();
                            playerBufferState.adStallStartAt = 0;
                            // Hard reload: a stuck media player needs its MediaSource rebuilt, not just an m3u8 refetch.
                            doTwitchPlayerTask(false, true, 'early');
                        }
                    } else if (!isStalled) {
                        playerBufferState.adStallStartAt = 0;
                    }
                }
            } catch {}
        } else if (!isActivelyStrippingAds && playerBufferState.adStallStartAt) {
            playerBufferState.adStallStartAt = 0;
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        playerBufferState.isLive = isLive;
        // Force immediate tick when tab becomes visible so stalls are caught fast on return
        if (typeof document !== 'undefined' && !monitorPlayerBuffering.visibilityHooked) {
            monitorPlayerBuffering.visibilityHooked = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && !monitorPlayerBuffering.pendingTick) {
                    monitorPlayerBuffering.pendingTick = true;
                    setTimeout(() => { monitorPlayerBuffering.pendingTick = false; monitorPlayerBuffering(); }, 100);
                }
            });
        }
        // Catch persistent ad-break overlays (e.g. "taking an ad break / stick around")
        // even after hasAds has transitioned to false. updateAdblockBanner only calls
        // hideTwitchAdOverlays during the active ad break; some overlays have their own
        // lifecycle and stay visible afterwards. Running here on every monitor tick
        // (1-3s cadence) keeps them hidden without a dedicated interval.
        try { hideTwitchAdOverlays(); } catch {}
        // Visibility-aware backoff: poll 3x slower when tab is hidden (but NOT during PiP — user is still watching).
        // Exception: don't back off during an active ad break — hidden-tab recovery (backup search → reload) is
        // already slowed by browser timer clamping; the 3x backoff compounds the "stuck loading until refocus"
        // stall some users hit when a break starts on a backgrounded tab (issue #129). Workaround, not a full fix:
        // background media deprioritization is browser-level. Negligible cost — only polls faster while hidden + in-break.
        const shouldThrottle = typeof document !== 'undefined' && document.hidden && !document.pictureInPictureElement && !playerBufferState.inAdBreak;
        const nextDelay = shouldThrottle ? PlayerBufferingDelay * 3 : PlayerBufferingDelay;
        setTimeout(monitorPlayerBuffering, nextDelay);
    }
    // Hide Twitch's ad break / Turbo promo / stream display ad overlays when we're already blocking ads
    function hideTwitchAdOverlays() {
        if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) return;
        // Hide stream display ad (SDA) wrapper
        const sdaElements = document.querySelectorAll('[data-test-selector="sda-wrapper"]');
        for (let i = 0; i < sdaElements.length; i++) {
            if (!sdaElements[i].dataset.tasHidden) {
                sdaElements[i].dataset.tasHidden = '';
                sdaElements[i].style.setProperty('display', 'none', 'important');
                if (!loggedSdaHide) {
                    loggedSdaHide = true;
                    console.log('[AD DEBUG] Hidden Twitch stream display ad');
                }
            }
        }
    }
    function updateAdblockBanner(data) {
        if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) {
            cachedPlayerRootDiv = document.querySelector('.video-player');
        }
        const playerRootDiv = cachedPlayerRootDiv;
        if (playerRootDiv != null) {
            let adBlockDiv = null;
            adBlockDiv = playerRootDiv.querySelector('.tas-adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'tas-adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            if (adBlockDiv != null) {
                isActivelyStrippingAds = data.isStrippingAdSegments;
                adBlockDiv.P.textContent = 'ReYohoho: Blocking' + (data.isMidroll ? ' midroll' : '') + ' ads' + (data.isStrippingAdSegments ? ' (stripping)' : '') + (data.activeBackupPlayerType ? ' (' + data.activeBackupPlayerType + ')' : '');// + (data.numStrippedAdSegments > 0 ? \` (\${data.numStrippedAdSegments})\` : '');
                adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            }
            if (data.hasAds) {
                hideTwitchAdOverlays();
            }
        }
    }
    // Traverse React's fiber tree to find Twitch's player and player state instances
    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            if (!cachedRootNode) {
                cachedRootNode = document.querySelector('#root');
            }
            const rootNode = cachedRootNode;
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer') || x.startsWith('__reactFiber'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        // Primary: named property lookup
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        // Fallback: structural match if Twitch obfuscates property names
        if (!player) {
            player = findReactNode(reactRootNode, node => node.getHTMLVideoElement && node.getBufferDuration && node.core?.state);
        }
        // Primary: named property lookup
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        // Fallback: structural match — setSrc exists but setInitialPlaybackSettings was renamed
        const playerStateFallback = !playerState ? findReactNode(reactRootNode, node => node.setSrc && node.setStreamManagerNode && !node.getHTMLVideoElement) : null;
        // Fallback 2: TTV-AB's approach — videoPlayerInstance with playerMode
        const playerStateFallback2 = !playerState && !playerStateFallback ? findReactNode(reactRootNode, node => node.state?.videoPlayerInstance?.playerMode !== undefined)?.state?.videoPlayerInstance : null;
        const finalPlayerState = playerState || playerStateFallback || playerStateFallback2;
        // Grace period before logging "not found" warnings. The buffer monitor can tick
        // before React has finished mounting the player, leading to a false-positive
        // log that fires once on every page load. Only log if the null state persists
        // for 10+ seconds — by then React is definitely mounted and a persistent null
        // indicates real API drift (Twitch renamed setPlayerActive/setSrc/etc).
        if (!player) {
            if (!getPlayerAndState.firstPlayerNullAt) getPlayerAndState.firstPlayerNullAt = Date.now();
            if (!getPlayerAndState.loggedNoPlayer && (Date.now() - getPlayerAndState.firstPlayerNullAt) > 10000) {
                getPlayerAndState.loggedNoPlayer = true;
                console.log('[AD DEBUG] Player not found for 10s+ — Twitch may have renamed setPlayerActive/mediaPlayerInstance');
            }
        } else {
            getPlayerAndState.firstPlayerNullAt = 0;// reset on successful find
        }
        if (!finalPlayerState) {
            if (!getPlayerAndState.firstStateNullAt) getPlayerAndState.firstStateNullAt = Date.now();
            if (!getPlayerAndState.loggedNoState && (Date.now() - getPlayerAndState.firstStateNullAt) > 10000) {
                getPlayerAndState.loggedNoState = true;
                console.log('[AD DEBUG] Player state not found for 10s+ — Twitch may have renamed setSrc/setInitialPlaybackSettings');
            }
        } else {
            getPlayerAndState.firstStateNullAt = 0;// reset on successful find
        }
        return  {
            player: player,
            state: finalPlayerState
        };
    }
    // Apple touch-device detection. iPadOS 13+ reports navigator.platform 'MacIntel' with a desktop
    // Safari UA — distinguished from a real Mac only by touch support (real Macs report maxTouchPoints 0).
    // iPhone/iPod/older iPadOS report platform directly.
    const isAppleTouchDevice = (function() {
        try {
            const p = navigator.platform || '';
            if (/^(iPhone|iPad|iPod)/.test(p)) return true;
            return p === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
        } catch { return false; }
    })();
    // On Apple touch devices a hard reload re-instantiates the media element (setSrc isNewMediaPlayerInstance),
    // which iOS/iPadOS treats as not user-gesture-"blessed" → play() is rejected → black frame + native play
    // icon the user must tap (issue: iPad ad black-screen). Downgrade hard reloads to soft so the existing
    // blessed element is reused and resumes without a tap. Opt-out: twitchAdSolutions_iosSoftReload=false.
    const iosSoftReload = isAppleTouchDevice && (function() {
        try { return localStorage.getItem('twitchAdSolutions_iosSoftReload') !== 'false'; } catch { return true; }
    })();
    // Pause/play or fully reload the Twitch player, preserving quality/volume settings
    function doTwitchPlayerTask(isPausePlay, isReload, reloadKind) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('Could not find player');
            return;
        }
        if (!playerState) {
            console.log('Could not find player state');
            return;
        }
        const wasPaused = player.isPaused() || player.core?.paused;
        if (wasPaused) {
            // User deliberately paused — respect their intent, don't auto-resume
            if (playerBufferState.userPauseIntent) {
                if (!playerBufferState.loggedPauseIntent) {
                    playerBufferState.loggedPauseIntent = true;
                    console.log('[AD DEBUG] Respecting user pause intent — skipping auto-resume');
                }
                return;
            }
            // If WE recently called pause/play and player is still paused, retry play (stuck from autoplay policy or ad-state interference)
            if (playerBufferState.weJustPaused && (Date.now() - playerBufferState.weJustPaused) < 10000) {
                try { player.play()?.catch?.(() => {}); } catch {}
            }
            return;
        }
        if (!wasPaused) {
            playerBufferState.weJustPaused = 0;
        }
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play()?.catch?.(() => {});
            playerBufferState.weJustPaused = Date.now();
            return;
        }
        if (isReload && document.pictureInPictureElement) {
            // Downgrade to pause/play to preserve PiP — setSrc exits PiP
            player.pause();
            player.play()?.catch?.(() => {});
            console.log('[AD DEBUG] Downgraded reload to pause/play to preserve PiP');
            return;
        }
        if (isReload) {
            // Skip reload if the player is already healthy — avoids disrupting smooth playback.
            // But if we're way behind live edge (e.g. after a long ad break), proceed with reload to reset latency.
            const video = player.getHTMLVideoElement?.();
            if (video && video.readyState >= 3 && !video.paused && !video.ended) {
                let latencySec = 0;
                let latencyKnown = false;
                try {
                    if (video.seekable && video.seekable.length > 0) {
                        const seekableEnd = video.seekable.end(video.seekable.length - 1);
                        if (Number.isFinite(seekableEnd)) {
                            const calc = Math.max(0, seekableEnd - video.currentTime);
                            // Sanity cap: values >1h indicate garbage from the Media Source API
                            // (seen right after a reload while the seekable range is in a transient state).
                            if (calc < 3600) {
                                latencySec = calc;
                                latencyKnown = true;
                            }
                        }
                    }
                } catch (e) {}
                if (!latencyKnown) {
                    console.log('[AD DEBUG] Latency unknown (seekable unavailable) — proceeding with reload');
                } else if (latencySec > 7) {
                    console.log('[AD DEBUG] Player playing but ' + latencySec.toFixed(1) + 's behind live — proceeding with reload to reset latency');
                } else {
                    console.log('[AD DEBUG] Skipping reload — player healthy (readyState=' + video.readyState + ', playing, latency=' + latencySec.toFixed(1) + 's)');
                    postTwitchWorkerMessage('ReloadSkipped');
                    return;
                }
            }
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            const lsKeyLowLatency = 'lowLatencyModeEnabled';// Preserve user's low-latency toggle across reloads (TTV-AB parity)
            const lsKeyPersistence = 'persistenceEnabled';// Preserve autoplay/persistence toggle across reloads (TTV-AB parity)
            let currentQualityLS = null;
            let currentMutedLS = null;
            let currentVolumeLS = null;
            let currentLowLatencyLS = null;
            let currentPersistenceLS = null;
            try {
                currentQualityLS = localStorage.getItem(lsKeyQuality);
                currentMutedLS = localStorage.getItem(lsKeyMuted);
                currentVolumeLS = localStorage.getItem(lsKeyVolume);
                currentLowLatencyLS = localStorage.getItem(lsKeyLowLatency);
                currentPersistenceLS = localStorage.getItem(lsKeyPersistence);
                if (localStorageHookFailed && player?.core?.state) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                    localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                if (player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
                }
            } catch {}
            playerBufferState.lastReloadAt = Date.now();
            playerBufferState.adStallStartAt = 0;// clear stale stall timer so post-reload readyState=0 isn't attributed to pre-reload stall
            playerBufferState.userPauseIntent = false;
            playerBufferState.loggedPauseIntent = false;
            // playerForMonitoringBuffering re-acquired fresh every tick — no manual invalidation needed
            // Hard reload for 'early' (mid-break escape — fresh session gets new ad-decision bucket).
            // Soft reload for 'post-ad' (smooth transition, no black screen teardown).
            // Apple touch devices: force soft — a new media instance needs a user tap to resume (black-screen + play icon).
            const hardReload = reloadKind === 'early' && !iosSoftReload;
            if (reloadKind === 'early' && iosSoftReload) {
                console.log('[AD DEBUG] iOS/iPadOS: downgrading hard reload to soft — keeps media element user-gesture-blessed (avoids black-screen + play-icon stall). Opt-out: twitchAdSolutions_iosSoftReload=false');
            }
            console.log('[AD DEBUG] Reloading Twitch player' + (hardReload ? ' (hard)' : ' (soft)'));
            // Pre-mute through hard reload to hide the MediaSource-teardown audio click.
            // New MSE initialization crosses a discontinuity boundary that produces an
            // audible pop on first frames. Restored on \`canplay\` (audio decodable) with a
            // 1500ms safety cap. Skipped if user was already muted (preserves intent).
            // Existing 3000ms LS-restore timer below acts as ultimate backstop.
            if (hardReload) {
                try {
                    const v = document.querySelector('video');
                    const wasInitiallyUnmuted = v && !v.muted;
                    // Issue #200 fix: also set up restore+backstop when the element is already
                    // muted IF vaft has successfully unmuted at any point earlier this session.
                    // Strong signal of Twitch's silent re-mute pattern (confirmed via v633
                    // diagnostic logs) rather than user-initiated mute. Without this, AFK
                    // users come back to persistently-muted streams (Tgod1991 on v635). First-
                    // session-mute users have vaftEverUnmuted=false → backstop never engages
                    // → mute respected. Disabled by twitchAdSolutions_recoverFromSilentMute=
                    // false for users who deliberately mute mid-session.
                    const shouldRecover = playerBufferState.vaftEverUnmuted && RecoverFromSilentMute;
                    if (v && (wasInitiallyUnmuted || shouldRecover)) {
                        if (wasInitiallyUnmuted) {
                            v.muted = true;
                        }
                        // setSrc({isNewMediaPlayerInstance:true}) replaces the <video> element,
                        // so a listener on the original \`v\` never fires — events fire on the
                        // new element. Listen on document (capture phase) instead so we catch
                        // them regardless of which <video> Twitch attaches the new MediaSource
                        // to. Three event triggers are wired up because Edge dispatches
                        // \`loadeddata\` / \`playing\` independently of \`canplay\` and any of them
                        // is sufficient signal that the new element is ready for unmute.
                        // First-fired wins via the idempotent \`done\` guard.
                        let done = false;
                        const restore = () => {
                            if (done) return;
                            done = true;
                            document.removeEventListener('canplay', listener, true);
                            document.removeEventListener('playing', listener, true);
                            document.removeEventListener('loadeddata', listener, true);
                            try {
                                const cur = document.querySelector('video');
                                if (cur) {
                                    cur.muted = false;
                                    playerBufferState.vaftEverUnmuted = true;
                                }
                            } catch {}
                        };
                        const listener = (e) => {
                            if (e.target && e.target.tagName === 'VIDEO') restore();
                        };
                        document.addEventListener('canplay', listener, true);
                        document.addEventListener('playing', listener, true);
                        document.addEventListener('loadeddata', listener, true);
                        setTimeout(restore, 4000);// Bumped 2500ms → 4000ms for Edge slow-init slack — issue #200 follow-up reports muted state on hard reloads where MSE init exceeded 2500ms.
                        // Final backstop: if the player ends up muted at 5500ms despite our
                        // restore (Twitch's own LS-restore at ~3000ms can re-mute if the
                        // captured pre-reload muted snapshot was true), force one more
                        // unmute. Idempotent — no-op if already unmuted. Skipped if the user
                        // explicitly muted (\`weJustPaused\` paths preserve user-mute intent;
                        // checking \`playerBufferState.userPauseIntent\` here is a cheap proxy
                        // — pause+mute are conceptually correlated by Twitch's player code).
                        setTimeout(() => {
                            try {
                                const cur = document.querySelector('video');
                                if (cur && cur.muted) {
                                    if (playerBufferState.userPauseIntent) {
                                        console.log('[AD DEBUG] Hard reload backstop SKIPPED — element muted at 5500ms but userPauseIntent set (likely false-positive pause event during MSE teardown — issue #200 follow-up)');
                                    } else {
                                        cur.muted = false;
                                        playerBufferState.vaftEverUnmuted = true;
                                        console.log('[AD DEBUG] Hard reload backstop unmute fired — element was still muted at 5500ms (initial: ' + (wasInitiallyUnmuted ? 'unmuted, we pre-muted' : 'already-muted on entry — recovering from silent Twitch re-mute') + ')');
                                    }
                                }
                            } catch {}
                        }, 5500);
                    }
                } catch {}
            }
            // Set weJustPaused so the pause-listener filters out the MSE-teardown
            // pause event that Twitch dispatches on the old <video> during setSrc.
            // Without this, userPauseIntent would falsely flip to true during the
            // reload window, blocking the 5500ms backstop's unmute on stuck-muted
            // recovery (issue #200 follow-up). Reuses the existing 2s pause-listener
            // guard.
            if (hardReload) {
                playerBufferState.weJustPaused = Date.now();
            }
            playerState.setSrc({ isNewMediaPlayerInstance: hardReload, refreshAccessToken: hardReload });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            player.play()?.catch?.(() => {});
            // Always restore muted/volume state after reload — Chrome autoplay policy can force muted.
            // Block must always run: if Twitch hasn't written LS values yet (fresh session, private mode,
            // cleared cache), the video still needs unmute after Chrome's autoplay mute on reload.
            {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) {
                            localStorage.setItem(lsKeyQuality, currentQualityLS);
                        }
                        if (currentMutedLS) {
                            localStorage.setItem(lsKeyMuted, currentMutedLS);
                        }
                        if (currentVolumeLS) {
                            localStorage.setItem(lsKeyVolume, currentVolumeLS);
                        }
                        if (currentLowLatencyLS !== null) {
                            localStorage.setItem(lsKeyLowLatency, currentLowLatencyLS);
                        }
                        if (currentPersistenceLS !== null) {
                            localStorage.setItem(lsKeyPersistence, currentPersistenceLS);
                        }
                        const videos = document.getElementsByTagName('video');
                        // Respect user's mute intent: only force-unmute if LS didn't say mute.
                        // Twitch writes video-muted as '{"default":true}' when user muted via UI;
                        // Chrome autoplay policy can mute even if user didn't (no LS signal).
                        const userIntendedMute = currentMutedLS && currentMutedLS.includes('"default":true');
                        if (videos.length > 0 && videos[0].muted && !userIntendedMute) {
                            videos[0].muted = false;
                        }
                        // Correct live drift after reload.
                        // For hard reload with large drift (>5s), hard-seek to live edge to flush
                        // any A/V timestamp desync from strip+BLANK_MP4+recovery activity. Drift
                        // correction at 1.1x would take minutes to catch up 30-60s of drift.
                        // For soft reload or small drift, use existing gradual catch-up.
                        if (videos.length > 0 && videos[0].buffered.length > 0 && videos[0].readyState >= 3) {
                            const liveEdge = videos[0].buffered.end(videos[0].buffered.length - 1);
                            const drift = liveEdge - videos[0].currentTime;
                            if (hardReload && drift > 5 && Number.isFinite(liveEdge) && liveEdge < 3600) {
                                console.log('[AD DEBUG] Post-hard-reload seek to live — ' + drift.toFixed(1) + 's behind, jumping to live edge to flush A/V drift');
                                videos[0].currentTime = liveEdge;
                            } else if (drift > 2) {
                                console.log('[AD DEBUG] Post-reload live drift correction: ' + drift.toFixed(1) + 's behind');
                                startDriftCorrection(videos[0]);
                            }
                        }
                    } catch {}
                }, 3000);
            }
            return;
        }
    }
    window.reloadTwitchPlayer = () => {
        doTwitchPlayerTask(false, true);
    };
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            worker.postMessage({key: key, value: value});
        });
    }
    async function handleWorkerFetchRequest(fetchRequest) {
        // 5s AbortController timeout. The worker uses this path for GQL requests
        // (access tokens + ad-spoof beacons). Without a timeout, a hung GQL endpoint
        // would block the worker's backup-search loop indefinitely (until browser's
        // ~30s default), turning a slow-network blip into a multi-second player
        // freeze during the ad break. 5s is well above normal Twitch GQL response
        // (<1s) but bounds worst-case wait. AbortError flows through the existing
        // catch + FailedBackupPlayerTypes lockout naturally.
        const controller = new AbortController();
        const timeoutMs = 5000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await window.realFetch(fetchRequest.url, {
                ...fetchRequest.options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const responseBody = await response.text();
            const responseObject = {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                ok: response.ok,
                redirected: response.redirected,
                type: response.type,
                url: response.url,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
            return responseObject;
        } catch (error) {
            clearTimeout(timeoutId);
            return {
                id: fetchRequest.id,
                error: error.name === 'AbortError' ? 'GQL fetch timeout (' + (timeoutMs / 1000) + 's)' : error.message
            };
        }
    }
    // Hook fetch() in the window scope to capture auth headers and modify player type requests
    function hookFetch() {
        console.log('[AD DEBUG] Window fetch hook installed');
        let hasLoggedHeaders = false;
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = maskAsNative(function(url, init) {
            if (typeof url === 'string') {
                if (url.includes('gql')) {
                    let deviceId = init.headers['X-Device-Id'];
                    if (typeof deviceId !== 'string') {
                        deviceId = init.headers['Device-ID'];
                    }
                    if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                        GQLDeviceID = deviceId;
                        postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                    }
                    if (typeof init.headers['Client-Version'] === 'string' && init.headers['Client-Version'] !== ClientVersion) {
                        postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = init.headers['Client-Version']);
                    }
                    if (typeof init.headers['Client-Session-Id'] === 'string' && init.headers['Client-Session-Id'] !== ClientSession) {
                        postTwitchWorkerMessage('UpdateClientSession', ClientSession = init.headers['Client-Session-Id']);
                    }
                    if (typeof init.headers['Client-Integrity'] === 'string' && init.headers['Client-Integrity'] !== ClientIntegrityHeader) {
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = init.headers['Client-Integrity']);
                    }
                    if (typeof init.headers['Authorization'] === 'string' && init.headers['Authorization'] !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = init.headers['Authorization']);
                    }
                    if (!hasLoggedHeaders && GQLDeviceID && AuthorizationHeader) {
                        hasLoggedHeaders = true;
                        console.log('[AD DEBUG] GQL headers captured — DeviceId: ' + (GQLDeviceID ? 'yes' : 'no') + ', Auth: ' + (AuthorizationHeader ? 'yes' : 'no') + ', Integrity: ' + (ClientIntegrityHeader ? 'yes' : 'no'));
                    }
                    // Get rid of mini player above chat - TODO: Reject this locally instead of having server reject it
                    if (init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken') && init.body.includes('picture-by-picture')) {
                        init.body = '';
                    }
                    if (ForceAccessTokenPlayerType && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
                        let replacedPlayerType = '';
                        const newBody = JSON.parse(init.body);
                        if (Array.isArray(newBody)) {
                            for (let i = 0; i < newBody.length; i++) {
                                if (newBody[i]?.variables?.playerType && newBody[i]?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                    replacedPlayerType = newBody[i].variables.playerType;
                                    newBody[i].variables.playerType = ForceAccessTokenPlayerType;
                                }
                            }
                        } else {
                            if (newBody?.variables?.playerType && newBody?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                replacedPlayerType = newBody.variables.playerType;
                                newBody.variables.playerType = ForceAccessTokenPlayerType;
                            }
                        }
                        if (replacedPlayerType) {
                            console.log(\`[AD DEBUG] Replaced '\${replacedPlayerType}' player type with '\${ForceAccessTokenPlayerType}' player type\`);
                            init.body = JSON.stringify(newBody);
                        }
                    }
                }
                if (url.includes('edge.ads.twitch.tv')) {
                    if (url.includes('PAUSE_ADS')) {
                        console.log('[AD DEBUG] Blocked PAUSE_ADS request — pause ads break playback when ad endpoint is blocked');
                        return Promise.resolve(new Response('', { status: 204, statusText: 'No Content' }));
                    }
                    const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
                    if (!loggedCsaiTypes.has(csaiType)) {
                        loggedCsaiTypes.add(csaiType);
                        console.log('[AD DEBUG] CSAI ad request detected — type: ' + csaiType + ' (client-side ad insertion, not blockable via m3u8)');
                    }
                }
            }
            return realFetch.apply(this, arguments);
        }, 'fetch');
    }
    // Set up visibility overrides and localStorage hooks to preserve player state across reloads
    function onContentLoaded() {
        if (document.getElementById('seventv-extension')) {
            console.log('[AD DEBUG] Warning: 7TV extension detected — may cause black screen or buffering issues. If you experience problems, try disabling 7TV.');
        }
        // Resume the player on tab focus if Twitch paused it during an ad on a hidden tab.
        // Previously also spoofed document.hidden / visibilityState / hasFocus and swallowed
        // the events on the capture phase. That broke other extensions that key off real
        // visibility (e.g. BetterTTV "Mute Invisible Player"). Resume-on-focus alone is
        // enough to keep playback alive across hidden→visible transitions during ads.
        // Sync'd with TTV-AB v6.5.0.
        let wasVideoPlaying = true;
        const visibilityChange = () => {
            const videos = document.getElementsByTagName('video');
            if (videos.length === 0) return;
            if (document.hidden) {
                wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                return;
            }
            if (!playerBufferState.hasStreamStarted) {
                playerBufferState.hasStreamStarted = true;
            }
            if (wasVideoPlaying && !videos[0].ended && videos[0].paused) {
                videos[0].play()?.catch?.(() => {});
            }
        };
        document.addEventListener('visibilitychange', visibilityChange);
        // Hooks for preserving volume / resolution
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',// Low Latency
                'persistenceEnabled',// Mini Player
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = maskAsNative(function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            }, 'setItem');
            const realGetItem = localStorage.getItem;
            localStorage.getItem = maskAsNative(function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            }, 'getItem');
            if (localStorage.getItem === realGetItem) {
                // These hooks are useful to preserve player state on player reload
                // Firefox doesn't allow hooking of localStorage functions but chrome does
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('localStorageHooks failed ' + err)
            localStorageHookFailed = true;
        }
    }
    declareOptions(window);
    try {
        const lsReloadAfterAd = localStorage.getItem('twitchAdSolutions_reloadPlayerAfterAd');
        if (lsReloadAfterAd !== null) {
            ReloadPlayerAfterAd = lsReloadAfterAd === 'true';
        }
        const lsReloadCooldown = parseInt(localStorage.getItem('twitchAdSolutions_reloadCooldownSeconds'));
        if (!isNaN(lsReloadCooldown) && lsReloadCooldown >= 0) {
            ReloadCooldownSeconds = lsReloadCooldown;
        }
        const lsDisableReloadCap = localStorage.getItem('twitchAdSolutions_disableReloadCap');
        if (lsDisableReloadCap !== null) {
            DisableReloadCap = lsDisableReloadCap === 'true';
        }
        const lsDriftRate = parseFloat(localStorage.getItem('twitchAdSolutions_driftCorrectionRate'));
        if (!isNaN(lsDriftRate) && lsDriftRate >= 0) {
            DriftCorrectionRate = lsDriftRate;
        }
        const lsEarlyReload = parseInt(localStorage.getItem('twitchAdSolutions_earlyReloadPollThreshold'));
        if (!isNaN(lsEarlyReload) && lsEarlyReload >= 0) {
            EarlyReloadPollThreshold = lsEarlyReload;
        }
        const lsPlayerType = localStorage.getItem('twitchAdSolutions_playerType');
        if (lsPlayerType !== null) {
            ForceAccessTokenPlayerType = lsPlayerType;
        }
        const lsPinBackup = localStorage.getItem('twitchAdSolutions_pinBackupPlayerType');
        if (lsPinBackup !== null) {
            PinBackupPlayerType = lsPinBackup === 'true';
        }
        const lsPreferLow = localStorage.getItem('twitchAdSolutions_preferLowQualityBackup');
        if (lsPreferLow === 'false') {
            PreferLowQualityBackup = false;
            console.log('[AD DEBUG] PreferLowQualityBackup disabled via localStorage — sticky CSAI path only, no autoplay fallback or escape hatch');
        }
        const lsFastAutoplay = localStorage.getItem('twitchAdSolutions_fastAutoplayFirstTry');
        if (lsFastAutoplay === 'false') {
            FastAutoplayFirstTry = false;
            console.log('[AD DEBUG] FastAutoplayFirstTry disabled via localStorage — full Source-tier probe on every break (no autoplay fast-path)');
        }
        const lsBackupSwapFirst = localStorage.getItem('twitchAdSolutions_backupSwapFirst');
        if (lsBackupSwapFirst === 'false') {
            BackupSwapFirst = false;
            console.log('[AD DEBUG] BackupSwapFirst disabled via localStorage — using sticky CSAI path (strip on native stream)');
        }
        const lsDisableAdSpoofing = localStorage.getItem('twitchAdSolutions_disableAdSpoofing');
        if (lsDisableAdSpoofing === 'false') {
            DisableAdSpoofing = false;
            console.log('[AD DEBUG] AdSpoofing enabled via localStorage opt-in — firing GQL ad-tracking beacons on ad detect');
        }
        const lsRecoverFromSilentMute = localStorage.getItem('twitchAdSolutions_recoverFromSilentMute');
        if (lsRecoverFromSilentMute === 'false') {
            RecoverFromSilentMute = false;
            console.log('[AD DEBUG] RecoverFromSilentMute disabled via localStorage — hard-reload backstop respects already-muted state, mid-session manual mutes preserved across reloads');
        }
        const lsHideAdOverlay = localStorage.getItem('twitchAdSolutions_hideAdOverlay');
        if (lsHideAdOverlay === 'true') {
            const style = document.createElement('style');
            style.textContent = '.tas-adblock-overlay { display: none !important; }';
            (document.head || document.documentElement).appendChild(style);
        }
    } catch {}
    console.log('[AD DEBUG] Config: ReloadPlayerAfterAd = ' + ReloadPlayerAfterAd + ', ForceAccessTokenPlayerType = ' + ForceAccessTokenPlayerType + ', PinBackupPlayerType = ' + PinBackupPlayerType);
    // === ReYohoho: stall-recovery watchdog + verbose diagnostics ===
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
                    // Mark our own reload so the next freeze check grants settling grace
                    // (STALL_INITIAL_SECONDS instead of STALL_SECONDS). A freshly reloaded
                    // hard-reset instance starts at t=0/readyState=0 and needs time to spin
                    // up; without this the watchdog re-fired every ~15s and cascaded.
                    playerBufferState.lastReloadAt = now;
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
                var recentReload = (typeof playerBufferState !== 'undefined' && playerBufferState.lastReloadAt && (now - playerBufferState.lastReloadAt) < 20000) ? true : false;
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

    hookWindowWorker();
    hookFetch();
    // Hook XHR to detect CSAI ad requests that bypass fetch
    const realXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = maskAsNative(function(method, url) {
        if (typeof url === 'string' && url.includes('edge.ads.twitch.tv')) {
            const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
            const xhrKey = csaiType + '-xhr';
            if (!loggedCsaiTypes.has(xhrKey)) {
                loggedCsaiTypes.add(xhrKey);
                console.log('[AD DEBUG] CSAI ad request (XHR) detected — type: ' + csaiType);
            }
        }
        return realXHROpen.apply(this, arguments);
    }, 'open');
    if (PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
    if (document.readyState === "complete" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('Ad depth parameter required (0 = no simulated ad, 1+ = use backup player for given depth)');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
})();
`;
            
            (document.head || document.documentElement).appendChild(script);
            
            // For inline scripts, remove immediately
            // For external scripts, keep until loaded
            if (!script.src) {
                script.remove();
            }
            
            vaftInitialized = true;
            console.log('[ReYohoho] VAFT injected into page context');
        } catch (e) {
            console.error('[ReYohoho] Error injecting VAFT:', e);
        }
    }

    // CRITICAL: Inject VAFT synchronously BEFORE page loads if enabled
    // This must happen before Twitch creates its Workers
    if (isVaftEnabledSync()) {
        vaftEnabled = true;
        injectVAFT();
    }

    // Load settings
    async function loadSettings() {
        try {
            const result = await storageAdapter.get(['extensionEnabled', 'vaftEnabled', 'ircProxyEnabled', 'hideAudioOnlyEnabled']);
            
            if (typeof result.extensionEnabled === 'boolean') {
                extensionEnabled = result.extensionEnabled;
                saveExtensionToLocalStorage(extensionEnabled);
            } else {
                extensionEnabled = isExtensionEnabledSync();
            }
            
            if (typeof result.vaftEnabled === 'boolean') {
                vaftEnabled = result.vaftEnabled;
                // Sync to localStorage for next page load
                saveVaftToLocalStorage(vaftEnabled);
                // Inject if enabled and not yet injected
                if (vaftEnabled && !vaftInitialized) {
                    injectVAFT();
                }
            }

            if (typeof result.ircProxyEnabled === 'boolean') {
                ircProxyEnabled = result.ircProxyEnabled;
                saveIrcProxyEnabledToLocalStorage(ircProxyEnabled);
            } else {
                ircProxyEnabled = isIrcProxyEnabledSync();
            }

            if (typeof result.hideAudioOnlyEnabled === 'boolean') {
                hideAudioOnlyEnabled = result.hideAudioOnlyEnabled;
                saveHideAudioOnlyToLocalStorage(hideAudioOnlyEnabled);
            } else {
                hideAudioOnlyEnabled = isHideAudioOnlyEnabledSync();
            }

            // Last known availability (refreshed by checkIrcProxyAvailability)
            ircProxyAvailable = isIrcProxyAvailableSync();
            
            console.log(`[ReYohoho] Loaded settings: enabled=${extensionEnabled}, vaft=${vaftEnabled}, ircProxy=${ircProxyEnabled} (available=${ircProxyAvailable}), hideAudioOnly=${hideAudioOnlyEnabled}`);
        } catch (e) {
            console.error('[ReYohoho] Error loading settings:', e);
        }
    }

    // Save extension enabled state
    async function saveExtensionEnabled(enabled) {
        extensionEnabled = enabled;
        try {
            await storageAdapter.set({ extensionEnabled: enabled });
            saveExtensionToLocalStorage(enabled);
            console.log(`[ReYohoho] Extension ${enabled ? 'enabled' : 'disabled'}`);
            
            // Notify background script
            if (isExtension && api) {
                api.runtime.sendMessage({ type: 'extensionToggle', enabled: enabled });
            }
            
            // Reload to apply changes
            location.reload();
        } catch (e) {
            console.error('[ReYohoho] Error saving extension state:', e);
        }
    }

    // Save VAFT state
    async function saveVaftEnabled(enabled) {
        vaftEnabled = enabled;
        try {
            await storageAdapter.set({ vaftEnabled: enabled });
            // Also save to localStorage for sync access on next page load
            saveVaftToLocalStorage(enabled);
            console.log(`[ReYohoho] VAFT ${enabled ? 'enabled' : 'disabled'}`);
            
            // Reload to apply changes (VAFT needs to be injected before page loads)
            location.reload();
        } catch (e) {
            console.error('[ReYohoho] Error saving VAFT state:', e);
        }
    }

    // Notify the MAIN-world WebSocket wrapper (irc-ws-proxy.js) that it
    // should close every tracked IRC socket so Twitch's chat client
    // reconnects and the new socket re-reads the proxy flags.
    //
    // Firefox isolates content-script objects with Xray vision: a plain
    // detail object created here is opaque to MAIN-world listeners and
    // throws "Permission denied to access property" when they try to
    // read it. `cloneInto(detail, window)` (Firefox-only helper) lifts
    // the object into the page compartment. Chromium and Tampermonkey
    // (with @grant none) don't expose `cloneInto` and don't need it.
    function dispatchIrcProxyDrop(reason) {
        try {
            const rawDetail = { reason: reason || 'state-change' };
            const detail = (typeof cloneInto === 'function')
                ? cloneInto(rawDetail, window)
                : rawDetail;
            window.dispatchEvent(new CustomEvent('reyohoho-irc-proxy-drop', { detail }));
        } catch (e) {
            console.error('[ReYohoho] Failed to dispatch IRC drop event:', e);
        }
    }

    // Save "hide audio_only" toggle. The proxy URL passed via background
    // (DNR/webRequest) bakes in the &hide_audio_only param, and the
    // userscript reads localStorage at script-load time. In all cases the
    // active player has already cached its master playlist, so we reload
    // to make Twitch refetch with the new flag.
    async function saveHideAudioOnlyEnabled(enabled) {
        hideAudioOnlyEnabled = enabled;
        try {
            await storageAdapter.set({ hideAudioOnlyEnabled: enabled });
            saveHideAudioOnlyToLocalStorage(enabled);
            console.log(`[ReYohoho] Hide audio_only ${enabled ? 'enabled' : 'disabled'}`);
            location.reload();
        } catch (e) {
            console.error('[ReYohoho] Error saving hideAudioOnly state:', e);
        }
    }

    // Save IRC proxy state. No reload needed: the wrapper picks up the
    // new flag on the next WebSocket construction, and we drop the
    // active socket(s) here so reconnect happens immediately.
    async function saveIrcProxyEnabled(enabled) {
        ircProxyEnabled = enabled;
        try {
            await storageAdapter.set({ ircProxyEnabled: enabled });
            saveIrcProxyEnabledToLocalStorage(enabled);
            console.log(`[ReYohoho] IRC proxy ${enabled ? 'enabled' : 'disabled'}`);
            dispatchIrcProxyDrop(enabled ? 'toggle-on' : 'toggle-off');
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
        } catch (e) {
            console.error('[ReYohoho] Error saving IRC proxy state:', e);
        }
    }

    // Probe the IRC proxy host with a HEAD request. We use no-cors because
    // the upstream doesn't return CORS headers; an opaque success response
    // is enough to know the host is reachable, and any network failure
    // (DNS, TLS, timeout) flips the cached availability flag to false so
    // active sockets get dropped and Twitch reconnects via direct.
    async function checkIrcProxyAvailability() {
        const probeUrl = (typeof IRC_PROXY_HOST !== 'undefined' ? IRC_PROXY_HOST : 'https://ext.rte.net.ru:8443') + '/https://google.com';
        const timeoutMs = typeof IRC_PROXY_CHECK_TIMEOUT !== 'undefined' ? IRC_PROXY_CHECK_TIMEOUT : 3000;

        let available = false;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            await fetch(probeUrl, {
                method: 'HEAD',
                mode: 'no-cors',
                cache: 'no-store',
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            available = true;
        } catch (e) {
            available = false;
            console.warn('[ReYohoho] IRC proxy host unreachable, falling back to direct:', e.name || e.message);
        }

        const previous = ircProxyAvailable;
        ircProxyAvailable = available;
        saveIrcProxyAvailableToLocalStorage(available);

        if (available !== previous) {
            console.log(`[ReYohoho] IRC proxy availability changed: ${available ? 'reachable' : 'unreachable'}`);
            // Only drop sockets when the user wants the proxy on; otherwise
            // they're already on the correct (direct) route.
            if (ircProxyEnabled) {
                dispatchIrcProxyDrop(available ? 'available' : 'unavailable');
            }
        }
        return available;
    }

    // UI Callbacks
    const callbacks = {
        onExtensionToggle: saveExtensionEnabled,
        onVaftToggle: saveVaftEnabled,
        onIrcProxyToggle: saveIrcProxyEnabled,
        onHideAudioOnlyToggle: saveHideAudioOnlyEnabled
    };

    // Get proxy status from background script (extensions)
    async function fetchProxyStatus() {
        if (!isExtension || !api) {
            // For userscript, check localStorage
            if (!extensionEnabled) {
                proxyStatus = { status: 'disabled' };
                return;
            }
            
            const proxyUrl = localStorage.getItem('reyohoho_proxy_url');
            
            if (proxyUrl) {
                proxyStatus = { status: 'active' };
            } else {
                proxyStatus = { status: 'checking' };
            }
            return;
        }
        
        try {
            const response = await api.runtime.sendMessage({ type: 'getProxyStatus' });
            if (response) {
                proxyStatus = { status: response.status || 'unknown', ...response };
            }
        } catch (e) {
            // Extension context may not be available
            proxyStatus = { status: 'unknown' };
        }
    }


    // Build the snapshot of IRC-proxy state that the UI panel renders.
    function ircProxyState() {
        return { enabled: ircProxyEnabled, available: ircProxyAvailable };
    }

    // Live snapshot used by the MutationObserver to render the panel
    // against current state instead of values captured at initUI() time.
    // Critical for toggles that don't reload the page (e.g. IRC proxy):
    // without this, closing and reopening the Twitch settings menu after
    // a toggle would re-render the panel with the pre-toggle state.
    function getCurrentUIState() {
        return {
            extensionEnabled,
            vaftEnabled,
            proxyStatus,
            callbacks,
            ircProxy: ircProxyState(),
            hideAudioOnly: hideAudioOnlyEnabled,
            tubernetAdEnabled
        };
    }

    // Initialize UI injection
    function initUI() {
        // Start observer for settings menu
        startObserver(getCurrentUIState);
        
        // Periodic check
        setInterval(() => {
            tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
        }, 500);
        
        // Periodic status update
        setInterval(async () => {
            await fetchProxyStatus();
            updateProxyStatusInPanels(proxyStatus, ircProxyState());
        }, 5000);

        // Resolve the Tubernet sponsor gate once on load. Fail-closed: only an
        // explicit ad_enabled=true reveals the sponsor block; timeout/error/false
        // keeps it hidden.
        refreshTubernetAdEnabled();

        // Periodic IRC proxy availability probe. Runs once immediately so
        // the cached flag reflects current reality on a fresh page load.
        const ircInterval = typeof IRC_PROXY_CHECK_INTERVAL !== 'undefined' ? IRC_PROXY_CHECK_INTERVAL : 30000;
        checkIrcProxyAvailability().then(() => {
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
        });
        setInterval(async () => {
            await checkIrcProxyAvailability();
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
        }, ircInterval);
    }

    // Ask the backend whether the Tubernet sponsor block should be shown and
    // push the result into any live panels.
    async function refreshTubernetAdEnabled() {
        try {
            tubernetAdEnabled = await fetchTubernetAdEnabled();
        } catch (e) {
            tubernetAdEnabled = false;
        }
        updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
    }

    // Listen for storage changes (extensions)
    if (isExtension && api && api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local') {
                if (changes.extensionEnabled) {
                    extensionEnabled = changes.extensionEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
                }
                if (changes.vaftEnabled) {
                    vaftEnabled = changes.vaftEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
                }
                if (changes.ircProxyEnabled) {
                    ircProxyEnabled = changes.ircProxyEnabled.newValue;
                    saveIrcProxyEnabledToLocalStorage(ircProxyEnabled);
                    // Mirror the local toggle path so other tabs also drop
                    // their active IRC sockets and reconnect via the new
                    // route without requiring a manual reload.
                    dispatchIrcProxyDrop(ircProxyEnabled ? 'toggle-on-sync' : 'toggle-off-sync');
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
                }
                if (changes.hideAudioOnlyEnabled) {
                    hideAudioOnlyEnabled = changes.hideAudioOnlyEnabled.newValue;
                    saveHideAudioOnlyToLocalStorage(hideAudioOnlyEnabled);
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
                }
            }
        });
    }

    // Main initialization
    async function init() {
        await loadSettings();
        await fetchProxyStatus();
        
        // Initialize UI
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initUI);
        } else {
            initUI();
        }
        
        console.log('[ReYohoho] Content script initialized');
    }

    init();
})();
