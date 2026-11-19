// ============================================
// ReYohoho Twitch Proxy - Proxy Checker
// ============================================

// A ReYohoho server is usable when /proxy/status answers and its playlist
// builds aren't at the in-flight cap: past it the server answers playlists
// with 503 at once, while plain relays (the old HEAD google.com check) still pass.
async function checkSingleProxy(proxyUrl, timeout = PROXY_CHECK_TIMEOUT) {
    console.log(`[ReYohoho] Checking proxy: ${proxyUrl}`);
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(proxyUrl + "proxy/status", {
            cache: "no-store",
            mode: "cors",
            signal: controller.signal
        });
        const status = response.ok ? await response.json() : null;
        clearTimeout(timeoutId);

        const load = status && status.overload;
        // 90%: a sample at the cap misses the 503s right after it, the cap is hit in bursts.
        const overloaded = !!load && load.inflight >= load.maxInflight * 0.9;
        const isAvailable = !!status && !overloaded;
        console.log(`[ReYohoho] Proxy ${proxyUrl} status: ${isAvailable ? "Available" : "Unavailable"} (${response.status}${load ? `, inflight ${load.inflight}/${load.maxInflight}` : ""})`);
        return isAvailable;
    } catch (error) {
        console.error(`[ReYohoho] Proxy ${proxyUrl} check failed:`, error.name, error.message);
        return false;
    }
}

// All checked at once (a hung server costs one timeout, not one each), the
// first usable one in `servers` order wins.
async function findAvailableProxy(servers = PROXY_SERVERS) {
    console.log("[ReYohoho] Starting search for available proxy...");

    const checks = servers.map((s) => checkSingleProxy(s));
    for (let i = 0; i < servers.length; i++) {
        if (await checks[i]) {
            console.log(`[ReYohoho] Found available proxy: ${servers[i]}`);
            return servers[i];
        }
    }

    console.warn("[ReYohoho] No available proxy found");
    return null;
}

// Third-party provider for live playlists: the picked one while it answers,
// any of them (picked first) when no ReYohoho server is usable. null = the
// ReYohoho server takes live too, or with none, Twitch directly.
// Drops don't count through them: they build the master with their own token.
async function findLiveProvider(picked, reyohohoBase) {
    const order = PROXY_PROVIDERS
        .filter((p) => p.live && (p === picked || !reyohohoBase))
        .sort((a, b) => (b === picked) - (a === picked));
    const checks = order.map((p) => checkProxyProvider(p));
    for (let i = 0; i < order.length; i++) {
        const r = await checks[i];
        // 404 = up, only the probe channel is offline; 403/429/5xx/no answer = can't serve us
        if (r.ok || r.code === 404) return order[i];
        console.warn(`[ReYohoho] Live provider ${order[i].id} unavailable (${r.code})`);
    }
    return null;
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { checkSingleProxy, findAvailableProxy, findLiveProvider };
}
