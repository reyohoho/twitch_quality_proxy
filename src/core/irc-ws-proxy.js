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
