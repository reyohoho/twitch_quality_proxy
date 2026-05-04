// ==UserScript==
// @name         ReYohoho Twitch Proxy + VAFT
// @namespace    https://github.com/reyohoho
// @version      2.3.0
// @description  Прокси для Twitch с поддержкой 1080p/1440p
// @author       ReYohoho
// @match        https://www.twitch.tv/*
// @match        https://twitch.tv/*
// @grant        none
// @run-at       document-start
// @updateURL    https://github.com/reyohoho/twitch_quality_proxy/raw/refs/heads/universal/dist/userscript/reyohoho-twitch.user.js
// @downloadURL  https://github.com/reyohoho/twitch_quality_proxy/raw/refs/heads/universal/dist/userscript/reyohoho-twitch.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ============================================
    // PROXY CONFIGURATION
    // ============================================
    const PROXY_SERVERS = [
        'https://proxy4.rte.net.ru/',
        'https://proxy7.rte.net.ru/',
        'https://proxy5.rte.net.ru/',
        'https://proxy6.rte.net.ru/'
    ];

    // Get saved settings from localStorage
    const savedProxy = localStorage.getItem('reyohoho_proxy_url') || PROXY_SERVERS[0];
    const extensionEnabled = localStorage.getItem('reyohoho_enabled') !== 'false'; // Default true

    // Get auth token from cookies
    function getAuthToken() {
        const cookies = document.cookie.split(';');
        for (let cookie of cookies) {
            const [name, value] = cookie.trim().split('=');
            if (name === 'auth-token') {
                return decodeURIComponent(value);
            }
        }
        return '';
    }

    // Build full proxy URL
    function buildProxyUrl(originalUrl, proxyUrl) {
        let result = proxyUrl + originalUrl;
        const authToken = getAuthToken();
        if (authToken) {
            result += (originalUrl.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(authToken);
        }
        return result;
    }

    // ============================================
    // WORKER INTERCEPTION (CRITICAL!)
    // ============================================
    const originalWorker = window.Worker;
    window.Worker = function (scriptURL, options) {
        // Skip if extension is disabled
        if (!extensionEnabled) {
            return new originalWorker(scriptURL, options);
        }

        console.log('[ReYohoho] Intercepting Worker creation:', scriptURL);

        if (typeof scriptURL === 'string' && scriptURL.startsWith('blob:')) {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', scriptURL, false);
            xhr.send();

            let workerCode = xhr.responseText;

            // Inject proxy code into worker
            // Re-read auth token at Worker creation time (may have changed since page load)
            const authTokenNow = getAuthToken();

            const proxyCode = `
                (function() {
                    const PROXY_URL = '${savedProxy}';
                    const AUTH_TOKEN = '${authTokenNow}';
                    
                    function replaceUrl(url) {
                        if (typeof url === 'string' && url.includes('usher.ttvnw.net')) {
                            let newUrl = PROXY_URL + url;
                            // Add auth token if available
                            if (AUTH_TOKEN) {
                                newUrl += (url.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(AUTH_TOKEN);
                            }
                            console.log('[ReYohoho Worker] Redirecting:', url.substring(0, 60) + '...');
                            // Notify main thread about intercept
                            try { self.postMessage({ type: 'reyohoho-intercept', time: Date.now() }); } catch(e) {}
                            return newUrl;
                        }
                        return url;
                    }
                    
                    const originalFetch = self.fetch;
                    self.fetch = function(...args) {
                        let url = args[0];
                        if (typeof url === 'string') {
                            args[0] = replaceUrl(url);
                        } else if (url instanceof Request) {
                            if (url.url.includes('usher.ttvnw.net')) {
                                const newUrl = replaceUrl(url.url);
                                args[0] = new Request(newUrl, url);
                            }
                        }
                        return originalFetch.apply(this, args);
                    };
                    
                    const originalXHROpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                        url = replaceUrl(url);
                        return originalXHROpen.call(this, method, url, ...rest);
                    };
                    
                    const originalURL = self.URL;
                    self.URL = function(url, base) {
                        if (typeof url === 'string') {
                            url = replaceUrl(url);
                        }
                        return new originalURL(url, base);
                    };
                    Object.setPrototypeOf(self.URL, originalURL);
                    Object.defineProperty(self.URL, 'prototype', {
                        value: originalURL.prototype,
                        writable: false
                    });
                    
                    console.log('[ReYohoho Worker] Proxy hooks installed');
                })();
            `;

            workerCode = proxyCode + '\n' + workerCode;

            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const newBlobURL = URL.createObjectURL(blob);

            console.log('[ReYohoho] Created patched worker with proxy hooks');
            const worker = new originalWorker(newBlobURL, options);

            // Listen for intercept messages from worker
            worker.addEventListener('message', function (e) {
                if (e.data && e.data.type === 'reyohoho-intercept') {
                    notifyIntercept();
                }
            });

            return worker;
        }

        return new originalWorker(scriptURL, options);
    };

    // ============================================
    // INTERCEPT NOTIFICATION
    // ============================================
    function notifyIntercept() {
        try {
            localStorage.setItem('reyohoho_last_intercept', Date.now().toString());
            window.dispatchEvent(new CustomEvent('reyohoho-proxy-intercept'));
        } catch (e) { }
    }

    // ============================================
    // MAIN THREAD INTERCEPTION
    // ============================================
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
        if (!extensionEnabled) {
            return originalFetch.apply(this, args);
        }
        let url = args[0];
        if (typeof url === 'string' && url.includes('usher.ttvnw.net')) {
            args[0] = buildProxyUrl(url, savedProxy);
            console.log('[ReYohoho] Intercepting fetch:', url.substring(0, 60) + '...');
            notifyIntercept();
        } else if (url instanceof Request && url.url.includes('usher.ttvnw.net')) {
            const newUrl = buildProxyUrl(url.url, savedProxy);
            args[0] = new Request(newUrl, url);
            console.log('[ReYohoho] Intercepting Request:', url.url.substring(0, 60) + '...');
            notifyIntercept();
        }
        return originalFetch.apply(this, args);
    };

    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (extensionEnabled && typeof url === 'string' && url.includes('usher.ttvnw.net')) {
            url = buildProxyUrl(url, savedProxy);
            console.log('[ReYohoho] Intercepting XHR:', url.substring(0, 60) + '...');
            notifyIntercept();
        }
        return originalXHROpen.call(this, method, url, ...rest);
    };

    console.log('[ReYohoho] Proxy userscript loaded (proxy: ' + savedProxy + ', enabled: ' + extensionEnabled + ')');

    // ============================================
    // STORAGE ADAPTER (for UI compatibility)
    // ============================================
    const storage = {
        async get(keys) {
            const result = {};
            for (const key of (Array.isArray(keys) ? keys : [keys])) {
                const value = localStorage.getItem('reyohoho_' + key);
                result[key] = value ? JSON.parse(value) : null;
            }
            return result;
        },
        async set(data) {
            for (const [key, value] of Object.entries(data)) {
                localStorage.setItem('reyohoho_' + key, JSON.stringify(value));
            }
        }
    };

    window.__REYOHOHO_USERSCRIPT__ = true;
    window.__REYOHOHO_STORAGE__ = storage;

    // Check proxies in background and save best one
    (async function findBestProxy() {
        for (const proxyUrl of PROXY_SERVERS) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);

                const response = await fetch(proxyUrl + 'https://google.com', {
                    method: 'HEAD',
                    mode: 'no-cors',
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
                localStorage.setItem('reyohoho_proxy_url', proxyUrl);
                console.log('[ReYohoho] Best proxy saved:', proxyUrl);
                return;
            } catch (e) {
                // Try next proxy
            }
        }
        localStorage.setItem('reyohoho_proxy_url', PROXY_SERVERS[0]);
    })();
})();


// ============================================
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

    // Opt-out flag: defaults to `true` when missing/unreadable. Used by
    // the master extension switch and the cached availability probe.
    function readOptOutFlag(key) {
        try {
            return localStorage.getItem(key) !== 'false';
        } catch (e) {
            return true;
        }
    }

    // Opt-in flag: only the literal string `'true'` counts as enabled.
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
    // dispatches this CustomEvent on `window` whenever the IRC proxy
    // toggle or cached availability changes. We close every tracked
    // IRC socket so Twitch's reconnect logic kicks in and the freshly
    // constructed socket reads the updated flags.
    //
    // Reading `e.detail.reason` is wrapped in try/catch because in
    // Firefox content scripts, the detail object lives in a different
    // security compartment and may throw "Permission denied" if it
    // wasn't `cloneInto()`d before dispatch. Either way we still drop.
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


// Inject styles when DOM is ready
(function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `/* ============================================
   ReYohoho Twitch Proxy - Styles
   ============================================ */

.reyohoho-proxy-settings {
    padding: 8px;
    margin: 6px;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, rgba(0, 0, 0, 0.3) 100%);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.1);
}

.reyohoho-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.reyohoho-icon {
    font-size: 14px;
    filter: grayscale(100%);
}

.reyohoho-title {
    font-weight: 600;
    font-size: 11px;
    color: #ffffff;
    letter-spacing: 0.3px;
    text-transform: uppercase;
    flex: 1;
}

.reyohoho-version {
    font-weight: 400;
    font-size: 9px;
    color: rgba(255, 255, 255, 0.5);
    text-transform: lowercase;
    margin-left: 4px;
}

.reyohoho-proxy-status {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 500;
}

.reyohoho-proxy-status[data-status="active"] {
    color: #00ff88;
    background: rgba(0, 255, 136, 0.15);
}

.reyohoho-proxy-status[data-status="ready"] {
    color: #88ccff;
    background: rgba(136, 204, 255, 0.15);
}

.reyohoho-proxy-status[data-status="checking"] {
    color: #ffcc00;
    background: rgba(255, 204, 0, 0.15);
}

.reyohoho-proxy-status[data-status="unavailable"],
.reyohoho-proxy-status[data-status="error"] {
    color: #ff6666;
    background: rgba(255, 102, 102, 0.15);
}

.reyohoho-proxy-status[data-status="disabled"],
.reyohoho-proxy-status[data-status="unknown"] {
    color: #aaaaaa;
    background: rgba(170, 170, 170, 0.15);
}

.reyohoho-options {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.reyohoho-option {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
}

.reyohoho-option:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.15);
}

.reyohoho-option.active {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.3);
}

.reyohoho-option input[type="radio"] {
    display: none;
}

.reyohoho-radio {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-radius: 50%;
    position: relative;
    flex-shrink: 0;
    transition: all 0.15s ease;
}

.reyohoho-option:hover .reyohoho-radio {
    border-color: rgba(255, 255, 255, 0.6);
}

.reyohoho-option.active .reyohoho-radio {
    border-color: #ffffff;
}

.reyohoho-option.active .reyohoho-radio::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 6px;
    height: 6px;
    background: #ffffff;
    border-radius: 50%;
}

.reyohoho-option-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
}

.reyohoho-option-title {
    font-size: 12px;
    font-weight: 500;
    color: #efeff1;
}

.reyohoho-option-desc {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.45);
}

.reyohoho-option.active .reyohoho-option-title {
    color: #ffffff;
}

.reyohoho-option.active .reyohoho-option-desc {
    color: rgba(255, 255, 255, 0.7);
}

/* ============================================
   VAFT Section Styles
   ============================================ */

.reyohoho-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.1);
    margin: 8px 0;
}

.reyohoho-section {
    padding: 6px 8px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 6px;
}

.reyohoho-section:last-of-type {
    margin-bottom: 0;
}

.reyohoho-section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
}

.reyohoho-section-header .reyohoho-section-title {
    flex: 1;
}

.reyohoho-section-header .reyohoho-irc-status {
    font-size: 9px;
    padding: 1px 5px;
    white-space: nowrap;
}

.reyohoho-section-title {
    font-size: 11px;
    font-weight: 500;
    color: #efeff1;
}

.reyohoho-section-desc {
    font-size: 9px;
    color: rgba(255, 255, 255, 0.4);
    display: block;
    line-height: 1.2;
}

/* Toggle Switch */
.reyohoho-toggle {
    position: relative;
    display: inline-block;
    width: 32px;
    height: 18px;
    cursor: pointer;
}

.reyohoho-toggle input {
    opacity: 0;
    width: 0;
    height: 0;
}

.reyohoho-toggle-slider {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(255, 255, 255, 0.2);
    border-radius: 18px;
    transition: all 0.3s ease;
}

.reyohoho-toggle-slider::before {
    position: absolute;
    content: "";
    height: 12px;
    width: 12px;
    left: 3px;
    bottom: 3px;
    background-color: white;
    border-radius: 50%;
    transition: all 0.3s ease;
}

.reyohoho-toggle input:checked + .reyohoho-toggle-slider {
    background-color: #9147ff;
}

.reyohoho-toggle input:checked + .reyohoho-toggle-slider::before {
    transform: translateX(14px);
}

.reyohoho-toggle:hover .reyohoho-toggle-slider {
    background-color: rgba(255, 255, 255, 0.3);
}

.reyohoho-toggle input:checked:hover + .reyohoho-toggle-slider {
    background-color: #a970ff;
}

/* VAFT Test Button */
.reyohoho-vaft-test-btn {
    width: 100%;
    margin-top: 6px;
    padding: 5px 8px;
    background: rgba(145, 71, 255, 0.15);
    border: 1px solid rgba(145, 71, 255, 0.3);
    border-radius: 4px;
    color: #bf94ff;
    font-size: 10px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
}

.reyohoho-vaft-test-btn:hover {
    background: rgba(145, 71, 255, 0.25);
    border-color: rgba(145, 71, 255, 0.5);
    color: #d4b8ff;
}

.reyohoho-vaft-test-btn:disabled {
    background: rgba(255, 165, 0, 0.15);
    border-color: rgba(255, 165, 0, 0.3);
    color: #ffc107;
    cursor: not-allowed;
}

/* ============================================
   Links Styles
   ============================================ */

.reyohoho-links {
    display: flex;
    gap: 4px;
    margin-top: 6px;
}

.reyohoho-tg-link,
.reyohoho-donate-link {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    flex: 1;
    padding: 5px 6px;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: rgba(255, 255, 255, 0.4);
    text-decoration: none;
    font-size: 9px;
    transition: all 0.15s ease;
}

.reyohoho-tg-link:hover {
    background: rgba(255, 255, 255, 0.05);
    color: #29b6f6;
}

.reyohoho-donate-link:hover {
    background: rgba(145, 71, 255, 0.1);
    color: #bf94ff;
}

.reyohoho-tg-icon {
    width: 11px;
    height: 11px;
    opacity: 0.6;
    transition: all 0.15s ease;
}

.reyohoho-tg-link:hover .reyohoho-tg-icon {
    opacity: 1;
    color: #29b6f6;
}

/* ============================================
   Ad Block Banner Styles
   ============================================ */

.adblock-overlay {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1000;
}

.player-adblock-notice {
    color: white;
    background-color: rgba(0, 0, 0, 0.8);
    padding: 5px 10px;
    font-size: 12px;
    border-radius: 0 0 4px 0;
}
`;
    if (document.head) {
        document.head.appendChild(style);
    } else {
        document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
    }
})();

// ============================================
// ReYohoho Twitch Proxy - Constants
// ============================================

const VERSION = '2.3.0';

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

function createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy) {
    const { onExtensionToggle, onVaftToggle, onIrcProxyToggle } = callbacks;
    const irc = getIrcProxyDisplay(extensionEnabled, ircProxy);
    
    const panel = document.createElement('div');
    panel.className = 'reyohoho-proxy-settings';
    panel.innerHTML = `
    <div class="reyohoho-header">
      <span class="reyohoho-icon">🎬</span>
      <span class="reyohoho-title">ReYohoho Proxy <span class="reyohoho-version">v${VERSION}</span></span>
      <span class="reyohoho-proxy-status" data-status="${proxyStatus.status}">${getStatusText(proxyStatus.status)}</span>
    </div>
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

    return panel;
}

function updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxy) {
    const irc = getIrcProxyDisplay(extensionEnabled, ircProxy);

    document.querySelectorAll('.reyohoho-proxy-settings').forEach(panel => {
        const extToggle = panel.querySelector('#reyohoho-ext-toggle');
        if (extToggle) {
            extToggle.checked = extensionEnabled;
        }
        const vaftToggle = panel.querySelector('#reyohoho-vaft-toggle');
        if (vaftToggle) {
            vaftToggle.checked = vaftEnabled;
        }
        const ircToggle = panel.querySelector('#reyohoho-irc-toggle');
        if (ircToggle) {
            ircToggle.checked = irc.enabled;
        }
        const ircStatusEl = panel.querySelector('.reyohoho-irc-status');
        if (ircStatusEl) {
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

function injectIntoElement(container, extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy) {
    if (!container || container.querySelector('.reyohoho-proxy-settings')) {
        return false;
    }

    const panel = createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy);
    container.insertBefore(panel, container.firstChild);
    return true;
}

function tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy) {
    const settingsMenu = document.querySelector('[data-a-target="player-settings-menu"]');

    if (settingsMenu && injectIntoElement(settingsMenu, extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy)) {
        console.log('[ReYohoho] Injected into player settings menu');
        return true;
    }

    return false;
}

function startObserver(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy) {
    const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;

        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldCheck = true;
                break;
            }
        }

        if (shouldCheck) {
            tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy);
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    return observer;
}




// ============================================
// ReYohoho Twitch Proxy - Content Script
// ============================================




(function() {
    'use strict';

    // Detect environment
    const isUserscript = typeof window.__REYOHOHO_USERSCRIPT__ !== 'undefined';
    const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
    const api = (typeof browser !== 'undefined' ? browser : chrome) || null;

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
    let proxyStatus = { status: 'unknown' };

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

    // Inject VAFT into page context
    function injectVAFT() {
        if (vaftInitialized) return;
        
        try {
            const script = document.createElement('script');
            
            // Chromium: use external file due to CSP restrictions
            // Firefox/Userscript: use inline script
            script.textContent = `const VAFT_CONFIG = {
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
// ============================================
// ReYohoho Twitch Proxy - VAFT Ad Blocker
// Based on TwitchAdSolutions/vaft by pixeltris
// ============================================

// @include constants.js

function initVAFT() {
    'use strict';

    const ourTwitchAdSolutionsVersion = 24;
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log("[ReYohoho VAFT] Skipping - another script active. ourVersion:" + ourTwitchAdSolutionsVersion + " activeVersion:" + window.twitchAdSolutionsVersion);
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;

    function declareOptions(scope) {
        scope.AdSignifier = VAFT_CONFIG.AdSignifier;
        scope.ClientID = VAFT_CONFIG.ClientID;
        scope.BackupPlayerTypes = [...VAFT_CONFIG.BackupPlayerTypes];
        scope.FallbackPlayerType = VAFT_CONFIG.FallbackPlayerType;
        scope.ForceAccessTokenPlayerType = VAFT_CONFIG.ForceAccessTokenPlayerType;
        scope.SkipPlayerReloadOnHevc = VAFT_CONFIG.SkipPlayerReloadOnHevc;
        scope.AlwaysReloadPlayerOnAd = VAFT_CONFIG.AlwaysReloadPlayerOnAd;
        scope.ReloadPlayerAfterAd = VAFT_CONFIG.ReloadPlayerAfterAd;
        scope.PlayerReloadMinimalRequestsTime = VAFT_CONFIG.PlayerReloadMinimalRequestsTime;
        scope.PlayerReloadMinimalRequestsPlayerIndex = VAFT_CONFIG.PlayerReloadMinimalRequestsPlayerIndex;
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = [];
        scope.StreamInfosByUrl = [];
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = VAFT_CONFIG.PlayerBufferingFix;
        scope.PlayerBufferingDelay = VAFT_CONFIG.PlayerBufferingDelay;
        scope.PlayerBufferingSameStateCount = VAFT_CONFIG.PlayerBufferingSameStateCount;
        scope.PlayerBufferingDangerZone = VAFT_CONFIG.PlayerBufferingDangerZone;
        scope.PlayerBufferingDoPlayerReload = VAFT_CONFIG.PlayerBufferingDoPlayerReload;
        scope.PlayerBufferingMinRepeatDelay = VAFT_CONFIG.PlayerBufferingMinRepeatDelay;
        scope.PlayerBufferingPrerollCheckEnabled = VAFT_CONFIG.PlayerBufferingPrerollCheckEnabled;
        scope.PlayerBufferingPrerollCheckOffset = VAFT_CONFIG.PlayerBufferingPrerollCheckOffset;
        scope.V2API = false;
        scope.IsAdStrippingEnabled = VAFT_CONFIG.IsAdStrippingEnabled;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
    }

    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    let lastKnownAudioState = null;
    let audioRestoreToken = 0;
    const twitchWorkers = [];
    const workerStringConflicts = ['twitch', 'isVariantA'];
    const workerStringAllow = [];
    const workerStringReinsert = ['isVariantA', 'besuper/', '\${patch_url}'];

    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x)) && !workerStringAllow.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
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
            Object.setPrototypeOf(reinsert[i], parent);
            parent = reinsert[i];
        }
        return parent;
    }

    function isValidWorker(worker) {
        const workerString = worker.toString();
        return !workerStringConflicts.some((x) => workerString.includes(x))
            || workerStringAllow.some((x) => workerString.includes(x))
            || workerStringReinsert.some((x) => workerString.includes(x));
    }

    function hookWindowWorker() {
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends getCleanWorker(window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch { }
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    return;
                }
                const newBlobStr = \`
                    const pendingFetchRequests = new Map();
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
                    const VAFT_CONFIG = \${JSON.stringify(VAFT_CONFIG)};
                    const workerString = getWasmWorkerJs('\${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
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
                                const { resolve, reject } = pendingFetchRequests.get(responseData.id);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                        }
                    });
                    hookWorkerFetch();
                    eval(workerString);
                \`;
                super(URL.createObjectURL(new Blob([newBlobStr])), options);
                twitchWorkers.push(this);
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        updateAdblockBanner(e.data);
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true);
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
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function () {
                return workerInstance;
            },
            set: function (value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('[ReYohoho VAFT] Attempt to set twitch worker denied');
                }
            }
        });
    }

    function getWasmWorkerJs(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        return req.responseText;
    }

    function hookWorkerFetch() {
        console.log('[ReYohoho VAFT] hookWorkerFetch');
        const realFetch = fetch;
        fetch = async function (url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Promise(function (resolve, reject) {
                        const send = function () {
                            return realFetch('data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA', options).then(function (response) {
                                resolve(response);
                            })['catch'](function (err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
                url = url.trimEnd();
                if (url.endsWith('m3u8')) {
                    return new Promise(function (resolve, reject) {
                        const processAfter = async function (response) {
                            if (response.status === 200) {
                                resolve(new Response(await processM3U8(url, await response.text(), realFetch)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function () {
                            return realFetch(url, options).then(function (response) {
                                processAfter(response);
                            })['catch'](function (err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^\\/]+)(?=\\.\\w+$)/)[0];
                    if (ForceAccessTokenPlayerType) {
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    return new Promise(function (resolve, reject) {
                        const processAfter = async function (response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = await response.text();
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null && (await realFetch(streamInfo.EncodingsM3U8.match(/^https:.*\\.m3u8$/m)[0])).status !== 200) {
                                    streamInfo = null;
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    StreamInfos[channelName] = streamInfo = {
                                        ChannelName: channelName,
                                        IsShowingAd: false,
                                        LastPlayerReload: 0,
                                        EncodingsM3U8: encodingsM3u8,
                                        ModifiedM3U8: null,
                                        IsUsingModifiedM3U8: false,
                                        UsherParams: (new URL(url)).search,
                                        RequestedAds: new Set(),
                                        Urls: [],
                                        ResolutionList: [],
                                        BackupEncodingsM3U8Cache: [],
                                        ActiveBackupPlayerType: null,
                                        IsMidroll: false,
                                        IsStrippingAdSegments: false,
                                        NumStrippedAdSegments: 0
                                    };
                                    const lines = encodingsM3u8.replaceAll('\\r', '').split('\\n');
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'],
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                streamInfo.ResolutionList.push(resolutionInfo);
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    const nonHevcResolutionList = streamInfo.ResolutionList.filter((element) => element.Codecs.startsWith('avc') || element.Codecs.startsWith('av0'));
                                    if (AlwaysReloadPlayerOnAd || (nonHevcResolutionList.length > 0 && streamInfo.ResolutionList.some((element) => element.Codecs.startsWith('hev') || element.Codecs.startsWith('hvc')) && !SkipPlayerReloadOnHevc)) {
                                        if (nonHevcResolutionList.length > 0) {
                                            for (let i = 0; i < lines.length - 1; i++) {
                                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(':') + 1));
                                                    const codecsKey = 'CODECS';
                                                    if (resSettings[codecsKey].startsWith('hev') || resSettings[codecsKey].startsWith('hvc')) {
                                                        const oldResolution = resSettings['RESOLUTION'];
                                                        const [targetWidth, targetHeight] = oldResolution.split('x').map(Number);
                                                        const newResolutionInfo = nonHevcResolutionList.sort((a, b) => {
                                                            const [streamWidthA, streamHeightA] = a.Resolution.split('x').map(Number);
                                                            const [streamWidthB, streamHeightB] = b.Resolution.split('x').map(Number);
                                                            return Math.abs((streamWidthA * streamHeightA) - (targetWidth * targetHeight)) - Math.abs((streamWidthB * streamHeightB) - (targetWidth * targetHeight));
                                                        })[0];
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, \`CODECS="\${newResolutionInfo.Codecs}"\`);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);
                                                    }
                                                }
                                            }
                                        }
                                        if (nonHevcResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\\n');
                                        }
                                    }
                                }
                                streamInfo.LastPlayerReload = Date.now();
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function () {
                            return realFetch(url, options).then(function (response) {
                                processAfter(response);
                            })['catch'](function (err) {
                                reject(err);
                            });
                        };
                        send();
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
        const matches = encodingsM3u8.match('SERVER-TIME="([0-9.]+)"');
        return matches && matches.length > 1 ? matches[1] : null;
    }

    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, \`$1\${newServerTime}$2\`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(new RegExp('(SERVER-TIME=")[0-9.]+"'), \`SERVER-TIME="\${newServerTime}"\`) : encodingsM3u8;
    }

    function stripAdSegments(textStr, stripAllSegments, streamInfo) {
        let hasStrippedAdSegments = false;
        const lines = textStr.replaceAll('\\r', '').split('\\n');
        const newAdUrl = 'https://twitch.tv';
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            line = line
                .replaceAll(/(X-TV-TWITCH-AD-URL=")(?:[^"]*)(")/g, \`$1\${newAdUrl}$2\`)
                .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")(?:[^"]*)(")/g, \`$1\${newAdUrl}$2\`);
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments || AllSegmentsAreAdSegments)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            }
            if (line.includes(AdSignifier)) {
                hasStrippedAdSegments = true;
            }
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        AdSegmentCache.forEach((value, key, map) => {
            if (value < Date.now() - 120000) {
                map.delete(key);
            }
        });
        return lines.join('\\n');
    }

    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.replaceAll('\\r', '').split('\\n');
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        let matchedResolutionUrl = null;
        let matchedFrameRate = false;
        let closestResolutionUrl = null;
        let closestResolutionDifference = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && encodingsLines[i + 1].includes('.m3u8')) {
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

    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        if (HasTriggeredPlayerReload) {
            HasTriggeredPlayerReload = false;
            streamInfo.LastPlayerReload = Date.now();
        }
        const haveAdTags = textStr.includes(AdSignifier) || SimulatedAdsDepth > 0;
        if (haveAdTags) {
            streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            if (!streamInfo.IsShowingAd) {
                streamInfo.IsShowingAd = true;
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false
                });
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.replaceAll('\\r', '').split('\\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            fetch(lines[i + 1]).then((response) => { response.blob() });
                            break;
                        }
                    }
                }
            }
            const currentResolution = streamInfo.Urls[url];
            if (!currentResolution) {
                return textStr;
            }
            const isHevc = currentResolution.Codecs.startsWith('hev') || currentResolution.Codecs.startsWith('hvc');
            if (((isHevc && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {
                streamInfo.IsUsingModifiedM3U8 = true;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({ key: 'ReloadPlayer' });
            }
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                startIndex = PlayerReloadMinimalRequestsPlayerIndex;
                isDoingMinimalRequests = true;
            }
            for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < BackupPlayerTypes.length; playerTypeIndex++) {
                const playerType = BackupPlayerTypes[playerTypeIndex];
                const realPlayerType = playerType.replace('-CACHED', '');
                const isFullyCachedPlayerType = playerType != realPlayerType;
                for (let i = 0; i < 2; i++) {
                    let isFreshM3u8 = false;
                    let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
                    if (!encodingsM3u8) {
                        isFreshM3u8 = true;
                        try {
                            const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
                            if (accessTokenResponse.status === 200) {
                                const accessToken = await accessTokenResponse.json();
                                const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                                urlInfo.searchParams.set('sig', accessToken.data.streamPlaybackAccessToken.signature);
                                urlInfo.searchParams.set('token', accessToken.data.streamPlaybackAccessToken.value);
                                const encodingsM3u8Response = await realFetch(urlInfo.href);
                                if (encodingsM3u8Response.status === 200) {
                                    encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                                }
                            }
                        } catch (err) { }
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
                                    if ((!m3u8Text.includes(AdSignifier) && (SimulatedAdsDepth == 0 || playerTypeIndex >= SimulatedAdsDepth - 1)) || (!fallbackM3u8 && playerTypeIndex >= BackupPlayerTypes.length - 1)) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                    if (isFullyCachedPlayerType) break;
                                    if (isDoingMinimalRequests) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                }
                            }
                        } catch (err) { }
                    }
                    streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
                    if (isFreshM3u8) break;
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                backupPlayerType = FallbackPlayerType;
                backupM3u8 = fallbackM3u8;
            }
            if (backupM3u8) {
                textStr = backupM3u8;
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    console.log(\`[ReYohoho VAFT] Blocking\${(streamInfo.IsMidroll ? ' midroll ' : ' ')}ads (\${backupPlayerType})\`);
                }
            }
            const stripHevc = isHevc && streamInfo.ModifiedM3U8;
            if (IsAdStrippingEnabled || stripHevc) {
                textStr = stripAdSegments(textStr, stripHevc, streamInfo);
            }
        } else if (streamInfo.IsShowingAd) {
            console.log('[ReYohoho VAFT] Finished blocking ads');
            streamInfo.IsShowingAd = false;
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
            streamInfo.ActiveBackupPlayerType = null;
            if (streamInfo.IsUsingModifiedM3U8 || ReloadPlayerAfterAd) {
                streamInfo.IsUsingModifiedM3U8 = false;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({ key: 'ReloadPlayer' });
            } else {
                postMessage({ key: 'PauseResumePlayer' });
            }
        }
        postMessage({
            key: 'UpdateAdBlockBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: streamInfo.IsShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments
        });
        return textStr;
    }

    function parseAttributes(str) {
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
                    version: 1,
                    sha256Hash: "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body, playerType);
    }

    function gqlRequest(body, playerType) {
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
            ...(ClientIntegrityHeader && { 'Client-Integrity': ClientIntegrityHeader }),
            ...(ClientVersion && { 'Client-Version': ClientVersion }),
            ...(ClientSession && { 'Client-Session-Id': ClientSession })
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
            pendingFetchRequests.set(requestId, { resolve, reject });
            postMessage({ key: 'FetchRequest', value: fetchRequest });
        });
    }

    let playerForMonitoringBuffering = null;
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        lastFixTime: 0,
        isLive: true
    };

    function monitorPlayerBuffering() {
        if (playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const state = playerForMonitoringBuffering.state;
                if (!player.core) {
                    playerForMonitoringBuffering = null;
                } else if (state.props?.content?.type === 'live' && !player.isPaused() && !player.getHTMLVideoElement()?.ended && playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay && !isActivelyStrippingAds) {
                    const m3u8Url = player.core?.state?.path;
                    if (m3u8Url) {
                        const fileName = new URL(m3u8Url).pathname.split('/').pop();
                        if (fileName?.endsWith('.m3u8')) {
                            const channelName = fileName.slice(0, -5);
                            if (playerBufferState.channelName != channelName) {
                                playerBufferState.channelName = channelName;
                                playerBufferState.hasStreamStarted = false;
                                playerBufferState.numSame = 0;
                            }
                        }
                    }
                    if (player.getState() === 'Playing') {
                        playerBufferState.hasStreamStarted = true;
                    }
                    const position = player.core?.state?.position;
                    const bufferedPosition = player.core?.state?.bufferedPosition;
                    const bufferDuration = player.getBufferDuration();
                    if (position !== undefined && bufferedPosition !== undefined) {
                        if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            (playerBufferState.position == position || bufferDuration < PlayerBufferingDangerZone) &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                console.log('Attempt to fix buffering position:' + playerBufferState.position + ' bufferedPosition:' + playerBufferState.bufferedPosition + ' bufferDuration:' + playerBufferState.bufferDuration);
                                const isPausePlay = !PlayerBufferingDoPlayerReload;
                                const isReload = PlayerBufferingDoPlayerReload;
                                doTwitchPlayerTask(isPausePlay, isReload);
                                playerBufferState.lastFixTime = Date.now();
                                playerBufferState.numSame = 0;
                            }
                        } else {
                            playerBufferState.numSame = 0;
                        }
                        playerBufferState.position = position;
                        playerBufferState.bufferedPosition = bufferedPosition;
                        playerBufferState.bufferDuration = bufferDuration;
                    } else {
                        playerBufferState.numSame = 0;
                    }
                }
            } catch (err) {
                playerForMonitoringBuffering = null;
            }
        }
        if (!playerForMonitoringBuffering) {
            const playerAndState = getPlayerAndState();
            if (playerAndState && playerAndState.player && playerAndState.state) {
                playerForMonitoringBuffering = {
                    player: playerAndState.player,
                    state: playerAndState.state
                };
            }
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({ hasAds: false });
        }
        playerBufferState.isLive = isLive;
        setTimeout(monitorPlayerBuffering, PlayerBufferingDelay);
    }

    function updateAdblockBanner(data) {
        const playerRootDiv = document.querySelector('.video-player');
        if (playerRootDiv != null) {
            let adBlockDiv = playerRootDiv.querySelector('.adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            if (adBlockDiv != null) {
                isActivelyStrippingAds = data.isStrippingAdSegments;
                adBlockDiv.P.textContent = 'ReYohoho Proxy: Блокировка' + (data.isMidroll ? ' midroll' : '') + ' рекламы' + (data.isStrippingAdSegments ? ' (stripping)' : '');
                adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            }
        }
    }

    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) return result;
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            const rootNode = document.querySelector('#root');
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) return null;
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        return { player: player, state: playerState };
    }

    function clampVolume(volume) {
        if (!Number.isFinite(volume)) return 0.5;
        return Math.min(1, Math.max(0, volume));
    }

    function getCurrentVideo() {
        const videos = document.getElementsByTagName('video');
        return videos.length > 0 ? videos[0] : null;
    }

    function getCurrentAudioState(player) {
        const video = getCurrentVideo();
        let muted = typeof video?.muted === 'boolean' ? video.muted : undefined;
        let volume = Number.isFinite(video?.volume) ? video.volume : undefined;
        if (typeof muted !== 'boolean') {
            try {
                if (typeof player?.getMuted === 'function') {
                    muted = player.getMuted();
                } else if (typeof player?.core?.state?.muted === 'boolean') {
                    muted = player.core.state.muted;
                }
            } catch { }
        }
        if (!Number.isFinite(volume)) {
            try {
                if (typeof player?.getVolume === 'function') {
                    volume = player.getVolume();
                } else if (Number.isFinite(player?.core?.state?.volume)) {
                    volume = player.core.state.volume;
                }
            } catch { }
        }
        if (typeof muted !== 'boolean' && !Number.isFinite(volume)) {
            return lastKnownAudioState;
        }
        return {
            muted: typeof muted === 'boolean' ? muted : Boolean(lastKnownAudioState?.muted),
            volume: clampVolume(Number.isFinite(volume) ? volume : lastKnownAudioState?.volume)
        };
    }

    function rememberCurrentAudioState(player) {
        const audioState = getCurrentAudioState(player);
        if (audioState) {
            lastKnownAudioState = audioState;
        }
        return audioState;
    }

    function applyAudioState(audioState, player) {
        if (!audioState) return;
        try {
            const video = getCurrentVideo();
            if (video) {
                video.volume = audioState.volume;
                video.muted = audioState.muted;
            }
        } catch { }
        try {
            if (typeof player?.setVolume === 'function') {
                player.setVolume(audioState.volume);
            }
        } catch { }
        try {
            if (typeof player?.setMuted === 'function') {
                player.setMuted(audioState.muted);
            } else if (typeof player?.setIsMuted === 'function') {
                player.setIsMuted(audioState.muted);
            } else if (typeof player?._sendCommand === 'function') {
                player._sendCommand('setMuted', [audioState.muted]);
            }
        } catch { }
        lastKnownAudioState = audioState;
    }

    function scheduleAudioStateRestore(audioState) {
        if (!audioState) return;
        const restoreId = ++audioRestoreToken;
        let attempts = 0;
        const maxAttempts = 20;
        const tryRestore = () => {
            if (restoreId !== audioRestoreToken) return;
            attempts++;
            const playerAndState = getPlayerAndState();
            applyAudioState(audioState, playerAndState?.player);
            const restoredAudioState = rememberCurrentAudioState(playerAndState?.player);
            const volumeMatches = restoredAudioState && Math.abs(restoredAudioState.volume - audioState.volume) < 0.01;
            const mutedMatches = restoredAudioState && restoredAudioState.muted === audioState.muted;
            if (attempts >= maxAttempts || (mutedMatches && (audioState.muted || volumeMatches))) {
                return;
            }
            setTimeout(tryRestore, attempts < 5 ? 250 : 500);
        };
        setTimeout(tryRestore, 150);
    }

    function doTwitchPlayerTask(isPausePlay, isReload) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) return;
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player || !playerState) return;
        if (player.isPaused() || player.core?.paused) return;
        const audioState = rememberCurrentAudioState(player);
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play();
            return;
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            let currentQualityLS = null;
            let currentMutedLS = null;
            let currentVolumeLS = null;
            try {
                currentQualityLS = localStorage.getItem(lsKeyQuality);
                currentMutedLS = localStorage.getItem(lsKeyMuted);
                currentVolumeLS = localStorage.getItem(lsKeyVolume);
                if (localStorageHookFailed && audioState) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({ default: audioState.muted }));
                    localStorage.setItem(lsKeyVolume, audioState.volume);
                }
                if (localStorageHookFailed && player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({ default: player.core.state.quality.group }));
                }
            } catch { }
            playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            player.play();
            scheduleAudioStateRestore(audioState);
            if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) localStorage.setItem(lsKeyQuality, currentQualityLS);
                        if (currentMutedLS) localStorage.setItem(lsKeyMuted, currentMutedLS);
                        if (currentVolumeLS) localStorage.setItem(lsKeyVolume, currentVolumeLS);
                    } catch { }
                }, 3000);
            }
        }
    }

    window.reloadTwitchPlayer = () => { doTwitchPlayerTask(false, true); };

    // Simulate ads for testing VAFT
    window.simulateVaftAds = (depth = 3) => {
        console.log('[ReYohoho VAFT] Simulating ads with depth:', depth);
        postTwitchWorkerMessage('SimulateAds', depth);
        // Auto-disable after 30 seconds
        setTimeout(() => {
            console.log('[ReYohoho VAFT] Stopping ad simulation');
            postTwitchWorkerMessage('SimulateAds', 0);
        }, 30000);
    };

    window.stopVaftSimulation = () => {
        console.log('[ReYohoho VAFT] Stopping ad simulation');
        postTwitchWorkerMessage('SimulateAds', 0);
    };

    // Listen for CustomEvent from content script (for CSP-restricted environments)
    window.addEventListener('reyohoho-vaft-simulate', (e) => {
        const depth = e.detail?.depth || 3;
        window.simulateVaftAds(depth);
    });

    window.addEventListener('reyohoho-vaft-stop', () => {
        window.stopVaftSimulation();
    });

    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            worker.postMessage({ key: key, value: value });
        });
    }

    async function handleWorkerFetchRequest(fetchRequest) {
        try {
            const response = await window.realFetch(fetchRequest.url, fetchRequest.options);
            const responseBody = await response.text();
            return {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
        } catch (error) {
            return { id: fetchRequest.id, error: error.message };
        }
    }

    function hookFetch() {
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = function (url, init, ...args) {
            if (typeof url === 'string') {
                if (url.includes('gql')) {
                    let deviceId = init?.headers?.['X-Device-Id'];
                    if (typeof deviceId !== 'string') {
                        deviceId = init?.headers?.['Device-ID'];
                    }
                    if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                        GQLDeviceID = deviceId;
                        postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                    }
                    if (typeof init?.headers?.['Client-Version'] === 'string' && init.headers['Client-Version'] !== ClientVersion) {
                        postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = init.headers['Client-Version']);
                    }
                    if (typeof init?.headers?.['Client-Session-Id'] === 'string' && init.headers['Client-Session-Id'] !== ClientSession) {
                        postTwitchWorkerMessage('UpdateClientSession', ClientSession = init.headers['Client-Session-Id']);
                    }
                    if (typeof init?.headers?.['Client-Integrity'] === 'string' && init.headers['Client-Integrity'] !== ClientIntegrityHeader) {
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = init.headers['Client-Integrity']);
                    }
                    if (typeof init?.headers?.['Authorization'] === 'string' && init.headers['Authorization'] !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = init.headers['Authorization']);
                    }
                    // Get rid of mini player above chat - TODO: Reject this locally instead of having server reject it
                    if (init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken') && init.body.includes('picture-by-picture')) {
                        init.body = '';
                    }
                    if (ForceAccessTokenPlayerType && typeof init?.body === 'string' && init.body.includes('PlaybackAccessToken')) {
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
                            init.body = JSON.stringify(newBody);
                        }
                    }
                }
            }
            return realFetch.apply(this, arguments);
        };
    }

    function onContentLoaded() {
        try {
            Object.defineProperty(document, 'visibilityState', { get() { return 'visible'; } });
        } catch { }
        let hidden = document.__lookupGetter__('hidden');
        let webkitHidden = document.__lookupGetter__('webkitHidden');
        try {
            Object.defineProperty(document, 'hidden', { get() { return false; } });
        } catch { }
        const block = e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        let wasVideoPlaying = true;
        const visibilityChange = e => {
            const isChrome = typeof chrome !== 'undefined';
            const videos = document.getElementsByTagName('video');
            if (videos.length > 0) {
                if (hidden?.apply(document) === true || (webkitHidden && webkitHidden.apply(document) === true)) {
                    wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                } else {
                    if (!playerBufferState.hasStreamStarted) {
                        playerBufferState.hasStreamStarted = true;
                    }
                    if (isChrome && wasVideoPlaying && !videos[0].ended && videos[0].paused && videos[0].muted) {
                        videos[0].play();
                    }
                }
            }
            block(e);
        };
        document.addEventListener('visibilitychange', visibilityChange, true);
        document.addEventListener('webkitvisibilitychange', visibilityChange, true);
        document.addEventListener('mozvisibilitychange', visibilityChange, true);
        document.addEventListener('volumechange', (event) => {
            if (event.target instanceof HTMLVideoElement) {
                rememberCurrentAudioState();
            }
        }, true);
        document.addEventListener('hasFocus', block, true);
        try {
            if (/Firefox/.test(navigator.userAgent)) {
                Object.defineProperty(document, 'mozHidden', { get() { return false; } });
            } else {
                Object.defineProperty(document, 'webkitHidden', { get() { return false; } });
            }
        } catch { }
        try {
            const keysToCache = ['video-quality', 'video-muted', 'volume', 'lowLatencyModeEnabled', 'persistenceEnabled'];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = function (key, value) {
                if (cachedValues.has(key)) cachedValues.set(key, value);
                realSetItem.apply(this, arguments);
            };
            const realGetItem = localStorage.getItem;
            localStorage.getItem = function (key) {
                if (cachedValues.has(key)) return cachedValues.get(key);
                return realGetItem.apply(this, arguments);
            };
            if (!localStorage.getItem.toString().includes(Object.keys({ cachedValues })[0])) {
                localStorageHookFailed = true;
            }
        } catch (err) {
            localStorageHookFailed = true;
        }
    }

    // Initialize VAFT
    declareOptions(window);
    hookWindowWorker();
    hookFetch();
    if (PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
    if (document.readyState === "complete" || document.readyState === "loaded" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function () {
            onContentLoaded();
        });
    }

    console.log('[ReYohoho VAFT] Initialized successfully');
}



initVAFT();`;
            
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
            const result = await storageAdapter.get(['extensionEnabled', 'vaftEnabled', 'ircProxyEnabled']);
            
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

            // Last known availability (refreshed by checkIrcProxyAvailability)
            ircProxyAvailable = isIrcProxyAvailableSync();
            
            console.log(`[ReYohoho] Loaded settings: enabled=${extensionEnabled}, vaft=${vaftEnabled}, ircProxy=${ircProxyEnabled} (available=${ircProxyAvailable})`);
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
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
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
        const probeUrl = (typeof IRC_PROXY_HOST !== 'undefined' ? IRC_PROXY_HOST : 'https://ext.rte.net.ru:8443') + '/';
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
        onIrcProxyToggle: saveIrcProxyEnabled
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

    // Initialize UI injection
    function initUI() {
        // Start observer for settings menu
        startObserver(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxyState());
        
        // Periodic check
        setInterval(() => {
            tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxyState());
        }, 500);
        
        // Periodic status update
        setInterval(async () => {
            await fetchProxyStatus();
            updateProxyStatusInPanels(proxyStatus, ircProxyState());
        }, 5000);

        // Periodic IRC proxy availability probe. Runs once immediately so
        // the cached flag reflects current reality on a fresh page load.
        const ircInterval = typeof IRC_PROXY_CHECK_INTERVAL !== 'undefined' ? IRC_PROXY_CHECK_INTERVAL : 30000;
        checkIrcProxyAvailability().then(() => {
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
        });
        setInterval(async () => {
            await checkIrcProxyAvailability();
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
        }, ircInterval);
    }

    // Listen for storage changes (extensions)
    if (isExtension && api && api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local') {
                if (changes.extensionEnabled) {
                    extensionEnabled = changes.extensionEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
                }
                if (changes.vaftEnabled) {
                    vaftEnabled = changes.vaftEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
                }
                if (changes.ircProxyEnabled) {
                    ircProxyEnabled = changes.ircProxyEnabled.newValue;
                    saveIrcProxyEnabledToLocalStorage(ircProxyEnabled);
                    // Mirror the local toggle path so other tabs also drop
                    // their active IRC sockets and reconnect via the new
                    // route without requiring a manual reload.
                    dispatchIrcProxyDrop(ircProxyEnabled ? 'toggle-on-sync' : 'toggle-off-sync');
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
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
