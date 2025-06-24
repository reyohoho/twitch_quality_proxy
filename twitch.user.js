// ==UserScript==
// @name         ReYohoho Twitch Proxy
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  Redirect Twitch usher requests to proxy. Поддержать: https://t.me/send?start=IV7outCFI5B0 или USDT TRON TRC20: TYH7kvPryhSCFWjdRVw68VZ1advYaZw3yJ
// @author       ReYohoho
// @match        https://www.twitch.tv/*
// @match        https://twitch.tv/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';
    
    const PROXY_URL = 'https://proxy4.rhhhhhhh.live/';
    const TARGET_PATTERN = /https:\/\/usher\.ttvnw\.net\//g;
    
    const originalWorker = window.Worker;
    window.Worker = function(scriptURL, options) {
        console.log('IDDQD Twitch Proxy: Intercepting Worker creation:', scriptURL);
        
        if (typeof scriptURL === 'string' && scriptURL.startsWith('blob:')) {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', scriptURL, false);
            xhr.send();
            
            let workerCode = xhr.responseText;
            console.log('IDDQD Twitch Proxy: Worker code length:', workerCode.length);
            
            const hasUsher = workerCode.includes('usher.ttvnw.net');
            const hasUsherDomain = workerCode.includes('usher.ttvnw');
            const hasTtvnw = workerCode.includes('ttvnw.net');
            
            console.log('IDDQD Twitch Proxy: Pattern search - usher.ttvnw.net:', hasUsher, 'usher.ttvnw:', hasUsherDomain, 'ttvnw.net:', hasTtvnw);
            
            const proxyCode = `
                (function() {
                    const PROXY_URL = '${PROXY_URL}';
                    
                    function replaceUrl(url) {
                        if (typeof url === 'string' && url.includes('usher.ttvnw.net')) {
                            const newUrl = url.replace(/https:\\/\\/usher\\.ttvnw\\.net\\//g, PROXY_URL + 'https://usher.ttvnw.net/');
                            console.log('IDDQD Worker Proxy: Redirecting', url, '->', newUrl);
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
                    
                    console.log('IDDQD Worker Proxy: All hooks installed (fetch, XHR, URL)');
                })();
            `;
            
            workerCode = proxyCode + '\n' + workerCode;
            
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const newBlobURL = URL.createObjectURL(blob);
            
            console.log('IDDQD Twitch Proxy: Created patched worker blob with fetch hook');
            return new originalWorker(newBlobURL, options);
        }
        
        return new originalWorker(scriptURL, options);
    };
    
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        let url = args[0];
        if (typeof url === 'string' && url.includes('usher.ttvnw.net')) {
            url = url.replace(TARGET_PATTERN, PROXY_URL + 'https://usher.ttvnw.net/');
            args[0] = url;
            console.log('IDDQD Twitch Proxy: Redirecting fetch:', url);
        } else if (url instanceof Request && url.url.includes('usher.ttvnw.net')) {
            const newUrl = url.url.replace(TARGET_PATTERN, PROXY_URL + 'https://usher.ttvnw.net/');
            args[0] = new Request(newUrl, url);
            console.log('IDDQD Twitch Proxy: Redirecting Request:', newUrl);
        }
        return originalFetch.apply(this, args);
    };
    
    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        if (typeof url === 'string' && url.includes('usher.ttvnw.net')) {
            url = url.replace(TARGET_PATTERN, PROXY_URL + 'https://usher.ttvnw.net/');
            console.log('IDDQD Twitch Proxy: Redirecting XHR:', url);
        }
        return originalXHROpen.call(this, method, url, ...rest);
    };
    

    
    console.log('IDDQD Twitch Proxy userscript v3.0 loaded - Worker interception enabled');
})(); 
