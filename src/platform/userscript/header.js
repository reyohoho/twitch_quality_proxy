// ==UserScript==
// @name         ReYohoho Twitch Proxy + VAFT
// @namespace    https://github.com/reyohoho
// @version      2.1.0
// @description  Прокси для Twitch с поддержкой 1080p/1440p
// @author       ReYohoho
// @match        https://www.twitch.tv/*
// @match        https://twitch.tv/*
// @grant        none
// @run-at       document-start
// @updateURL    https://github.com/reyohoho/twitch_quality_universal/raw/main/dist/userscript/reyohoho-twitch.user.js
// @downloadURL  https://github.com/reyohoho/twitch_quality_universal/raw/main/dist/userscript/reyohoho-twitch.user.js
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

    // Get current auth token for Worker injection
    const currentAuthToken = getAuthToken();

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
