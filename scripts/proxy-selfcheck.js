#!/usr/bin/env node
/**
 * Self-check for the playlist server choice in the backgrounds: overloaded
 * ReYohoho servers are skipped, third-party ones take live playlists when no
 * ReYohoho server is usable. Runs the shipped constants.js + proxy-checker.js
 * against a stubbed fetch. Run: npm test
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const core = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'core', f), 'utf8');

// url prefix -> { status, body } ; anything else = network error
let routes = {};
const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    AbortController, setTimeout, clearTimeout, Date,
    fetch: async (url) => {
        const key = Object.keys(routes).find((k) => url.startsWith(k));
        if (!key) throw new TypeError('NetworkError');
        const r = routes[key];
        if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
        return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body, json: async () => JSON.parse(r.body) };
    }
});
vm.runInContext(core('constants.js') + '\n' + core('proxy-checker.js') + '\n' + core('ui-panel.js')
    + '\nthis.api = { checkSingleProxy, findAvailableProxy, findLiveProvider, getProxyProvider, fallbackNotice };', ctx);
const { checkSingleProxy, findAvailableProxy, findLiveProvider, getProxyProvider, fallbackNotice } = ctx.api;

const status = (inflight) => ({ status: 200, body: JSON.stringify({ overload: { maxInflight: 64, inflight } }) });
const master = { status: 200, body: '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,FRAME-RATE=60\nhttps://cdn/1080.m3u8\n' };
const P4 = 'https://proxy4.rte.net.ru/', P7 = 'https://proxy7.rte.net.ru/';
const auto = getProxyProvider('auto'), p4 = getProxyProvider('proxy4'), p5 = getProxyProvider('proxy5'), lumEu = getProxyProvider('luminous-eu'), lumEu2 = getProxyProvider('luminous-eu2');

(async () => {
    routes = { [P4 + 'proxy/status']: status(3) };
    assert.strictEqual(await checkSingleProxy(P4), true, 'idle server is usable');
    routes = { [P4 + 'proxy/status']: status(60) };
    assert.strictEqual(await checkSingleProxy(P4), false, 'server near the in-flight cap is skipped');
    routes = { [P4 + 'proxy/status']: { status: 502, body: 'Bad Gateway' } };
    assert.strictEqual(await checkSingleProxy(P4), false, 'HTTP error = unusable');
    routes = { [P4 + 'proxy/status']: { status: 200, body: '{}' } };
    assert.strictEqual(await checkSingleProxy(P4), true, 'server without overload stats is usable');

    routes = { [P4 + 'proxy/status']: status(64), [P7 + 'proxy/status']: status(1) };
    assert.strictEqual(await findAvailableProxy([P4, P7]), P7, 'overloaded first server falls through to the next');
    routes = { [P4 + 'proxy/status']: { ...status(1), delay: 50 }, [P7 + 'proxy/status']: status(1) };
    assert.strictEqual(await findAvailableProxy([P4, P7]), P4, 'checked at once, but the order still decides');

    // auto, ReYohoho usable: no third-party at all
    routes = { 'https://eu.luminous.dev/': master };
    assert.strictEqual(await findLiveProvider(auto, P4), null, 'auto with a ReYohoho server keeps live on it');
    // auto, no ReYohoho: first answering third-party, a down one skipped
    routes = { 'https://eu.luminous.dev/': { status: 503, body: '' }, 'https://eu2.luminous.dev/': master };
    assert.strictEqual(await findLiveProvider(auto, null), lumEu2, 'auto falls back to the first answering third-party');
    routes = { 'https://eu.luminous.dev/': { status: 404, body: '' } };
    assert.strictEqual(await findLiveProvider(auto, null), lumEu, 'a 4xx answer (probe channel offline) still counts as up');
    routes = { 'https://eu.luminous.dev/': { status: 403, body: '' }, 'https://eu2.luminous.dev/': { status: 429, body: '' }, 'https://as.luminous.dev/': master };
    assert.strictEqual(await findLiveProvider(auto, null), getProxyProvider('luminous-as'), '403 / 429 = the provider won\'t serve us');
    routes = {};
    assert.strictEqual(await findLiveProvider(auto, null), null, 'nothing answers = Twitch directly');
    // picked third-party
    routes = { 'https://eu2.luminous.dev/': master, 'https://eu.luminous.dev/': master };
    assert.strictEqual(await findLiveProvider(lumEu2, P4), lumEu2, 'picked third-party while it answers');
    assert.strictEqual(await findLiveProvider(lumEu2, null), lumEu2, 'picked third-party goes first in the fallback order');
    routes = { 'https://eu.luminous.dev/': master };
    assert.strictEqual(await findLiveProvider(lumEu2, P4), null, 'picked third-party down -> ReYohoho takes live');
    assert.strictEqual(await findLiveProvider(lumEu2, null), lumEu, 'picked third-party down, no ReYohoho -> another third-party');

    // Panel notice: silent while the pick is served, names the route otherwise
    assert.strictEqual(fallbackNotice(auto, p4, 'active'), '', 'auto on a ReYohoho server');
    assert.strictEqual(fallbackNotice(p5, p5, 'active'), '', 'picked server in use');
    assert.strictEqual(fallbackNotice(lumEu, lumEu, 'active'), '', 'picked third-party in use');
    assert.strictEqual(fallbackNotice(p5, undefined, 'checking'), '', 'nothing while checking');
    assert.strictEqual(fallbackNotice(p5, p4, 'active'), 'proxy5 недоступен · поток идёт через proxy4');
    assert.strictEqual(fallbackNotice(p5, lumEu, 'active'), 'proxy5 недоступен · поток идёт через Luminous EU · Drops не засчитываются');
    assert.strictEqual(fallbackNotice(auto, lumEu, 'active'), 'Серверы ReYohoho недоступны · поток идёт через Luminous EU · Drops не засчитываются');
    assert.strictEqual(fallbackNotice(lumEu, p4, 'active'), 'Luminous EU недоступен · поток идёт через proxy4');
    assert.strictEqual(fallbackNotice(auto, undefined, 'direct'), 'Все прокси недоступны · поток идёт напрямую через Twitch');
    assert.strictEqual(fallbackNotice(p5, undefined, 'direct'), 'Все прокси недоступны · поток идёт напрямую через Twitch');

    console.log('proxy-selfcheck: ok');
})().catch((e) => { console.error(e); process.exit(1); });
