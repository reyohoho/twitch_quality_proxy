#!/usr/bin/env node
/**
 * Self-check for the ReYohoho VAFT patches. Pulls functions out of the
 * generated src/core/vaft.js (so it tests exactly what ships) and runs them on
 * synthetic playlists. Run: npm test
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const VAFT = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'vaft.js'), 'utf8');

// Source of `function name(...) {...}` from vaft.js, found by brace counting.
function extractFunction(code, name) {
    const start = code.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `function ${name} not found in vaft.js`);
    let depth = 0;
    for (let i = code.indexOf('{', start); i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
    }
    throw new Error(`function ${name} is not closed`);
}

function load(name, globals) {
    const names = Object.keys(globals);
    return new Function(...names, `${extractFunction(VAFT, name)}\nreturn ${name};`)(...names.map((n) => globals[n]));
}

const AdSignifiers = VAFT.match(/scope\.AdSignifiers = (\[[^\n]*\]);/)[1];
const hasAdTags = load('hasAdTags', { AdSignifiers: eval(AdSignifiers) });

const live = (n) => `#EXT-X-PROGRAM-DATE-TIME:2026-11-08T10:00:0${n}.000Z\n#EXTINF:2.000,live\nhttps://cdn/seg${n}.ts\n`;
const head = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n';
// CLASS first: the only form the upstream signifier matches. Clean playlists
// seen live (2026-11-08) put ID first, which the signifier never matched.
const trigger = '#EXT-X-DATERANGE:CLASS="twitch-trigger",ID="t1",START-DATE="2026-11-08T10:00:00.000Z"\n';

assert.strictEqual(hasAdTags(head + live(0) + live(1)), false, 'clean playlist');
assert.strictEqual(hasAdTags(head + trigger + live(0) + live(1)), false, 'twitch-trigger over live segments is not an ad');
assert.strictEqual(hasAdTags(head + trigger + live(0) + '#EXTINF:2.000,Amazon|123\nhttps://cdn/ad.ts\n'), true,
    'twitch-trigger next to an ad segment is an ad');
assert.strictEqual(hasAdTags(head + '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad"\n' + live(0)), true,
    'stitched-ad still counts over live segments');
assert.strictEqual(hasAdTags(head + '#EXT-X-DATERANGE:CLASS="twitch-maf-ad",ID="m1"\n' + live(0)), true,
    'twitch-maf-ad still counts (CSAI cue is stripped by the fast path)');

// ---- MediaSequencer (port of ReTwitch's PlaylistSelfCheck, minus ad stripping) ----
const { createMediaSequencer } = require('../src/core/media-sequencer.js');
const T0 = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();
const HEAD = (first) => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
// Segments first..first+n-1 of one source, no clock.
const plain = (first, n, host = 's') => HEAD(first)
    + Array.from({ length: n }, (_, i) => `#EXTINF:2.000,live\nhttps://${host}/${first + i}.ts\n`).join('');
// Broadcast segments from..to numbered from base, clock `lag` segments behind.
const timed = (base, from, to, lag = 0) => HEAD(base + from)
    + Array.from({ length: to - from + 1 }, (_, k) => from + k)
        .map((i) => `#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + (i - lag) * 2000)}\n#EXTINF:2.000,live\nhttps://s/${base + i}.ts\n`).join('');
// One viewer session: own MEDIA-SEQUENCE, the broadcast's LIVE-SEQUENCE, own URIs.
const session = (host, mediaBase, from, to, lag) => HEAD(mediaBase + from) + `#EXT-X-TWITCH-LIVE-SEQUENCE:${15170 + from}\n`
    + Array.from({ length: to - from + 1 }, (_, k) => from + k)
        .map((i) => `#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + (i - lag) * 2000)}\n#EXTINF:2.000,live\nhttps://${host}/${i}.ts\n`).join('');
const HINTS = '#EXT-X-TWITCH-PREFETCH:https://s/h1.ts\n#EXT-X-TWITCH-PREFETCH:https://s/h2.ts\n';
const ok = (cond, msg, out) => assert.ok(cond, msg + '\n' + out);

{ // A clean source keeps its numbers; a backup with its own numbers continues after them behind a jump.
    const seq = createMediaSequencer();
    let out = seq.rewrite('v', 'primary', plain(100, 3), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:100\n') && !out.includes('DISCONTINUITY'), 'clean untouched', out);
    out = seq.rewrite('v', 'primary', plain(101, 3), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:101\n') && !out.includes('DISCONTINUITY'), 'clean next poll', out);
    out = seq.rewrite('v', 'backup b', plain(5000, 2), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:104\n#EXT-X-DISCONTINUITY\n'), 'backup jump', out);
    // The jump leaves the window: DISCONTINUITY-SEQUENCE counts it.
    out = seq.rewrite('v', 'backup b', plain(5001, 3), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:105\n#EXT-X-DISCONTINUITY-SEQUENCE:1\n') && !out.includes('#EXT-X-DISCONTINUITY\n'),
        'discontinuity counted', out);
}
{ // Source switch by time: a backup window over time already played only adds what is new.
    const seq = createMediaSequencer();
    let out = seq.rewrite('v', 'primary', timed(100, 0, 4), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:100\n'), 'primary served', out);
    out = seq.rewrite('v', 'backup b', timed(5000, 1, 5), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:105\n#EXT-X-DISCONTINUITY\n') && out.includes('/5005.ts') && !out.includes('/5004.ts'),
        'only new time goes out', out);
    out = seq.rewrite('v', 'backup b', timed(5000, 2, 6), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:105\n') && out.includes('/5006.ts') && !out.includes('/5003.ts'), 'backup continues', out);
    assert.strictEqual(seq.rewrite('v', 'backup c', timed(9000, 2, 5), false), null, 'a backup behind serves nothing');
    ok(seq.last('v').includes('/5006.ts'), 'caller holds the last playlist', seq.last('v'));
    out = seq.rewrite('v', 'primary', timed(100, 3, 7), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:107\n') && out.includes('#EXT-X-DISCONTINUITY\n') && out.includes('/107.ts')
        && !out.includes('/106.ts'), 'back to primary', out);
}
{ // Low latency plays prefetch hints as the next numbers: a jump numbers past them.
    let seq = createMediaSequencer();
    let out = seq.rewrite('v', 'primary', plain(100, 3) + HINTS, false);
    ok(out.includes('/h2.ts'), 'hints served', out);
    out = seq.rewrite('v', 'backup b', plain(5000, 2), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:105\n#EXT-X-DISCONTINUITY\n'), 'jump past hints', out);
    seq = createMediaSequencer();
    seq.rewrite('v', 'primary', plain(100, 3) + HINTS, false);
    out = seq.rewrite('v', 'primary', plain(101, 4), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:101\n') && !out.includes('DISCONTINUITY'), 'hints that become segments keep numbers', out);
}
{ // A source whose clock lags is held back, then after a few polls its live edge plays.
    const seq = createMediaSequencer();
    seq.rewrite('v', 'primary', timed(100, 0, 9), false);
    for (let poll = 0; poll < 3; poll++) {
        assert.strictEqual(seq.rewrite('v', 'backup b', timed(5000, 6 + poll, 10 + poll, 10), false), null, 'held back ' + poll);
    }
    let out = seq.rewrite('v', 'backup b', timed(5000, 9, 13, 10), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:110\n#EXT-X-DISCONTINUITY\n') && out.includes('/5011.ts') && out.includes('/5013.ts')
        && !out.includes('/5010.ts'), 'escape serves the live edge only', out);
    out = seq.rewrite('v', 'backup b', timed(5000, 10, 14, 10), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:110\n') && out.includes('/5014.ts') && !out.includes('/5010.ts'), 'continues after escape', out);
}
{ // Sessions of one broadcast line up by LIVE-SEQUENCE, whatever their own numbers and clocks.
    let seq = createMediaSequencer();
    let out = seq.rewrite('v', 'primary', session('p', 15, 0, 4, 0), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:15\n') && !out.includes('DISCONTINUITY'), 'first session', out);
    out = seq.rewrite('v', 'backup b', session('b', 9000, 2, 6, 10), false);
    let at = out.indexOf('#EXT-X-DISCONTINUITY\n');
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:17\n') && at > out.indexOf('https://b/4.ts') && at < out.indexOf('https://b/5.ts'),
        'other session lines up, switch marked', out);
    out = seq.rewrite('v', 'primary', session('p', 15, 4, 8, 0), false);
    at = out.lastIndexOf('#EXT-X-DISCONTINUITY\n');
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:19\n') && at > out.indexOf('https://p/6.ts') && at < out.indexOf('https://p/7.ts'),
        'back to the first session', out);
    // Hints served before the switch: it is marked past them, and no hint goes out until then.
    seq = createMediaSequencer();
    seq.rewrite('v', 'primary', session('p', 15, 0, 4, 0) + HINTS, false);
    out = seq.rewrite('v', 'backup b', session('b', 9000, 2, 5, 10) + HINTS, false);
    ok(out.includes('https://b/5.ts') && !out.includes('DISCONTINUITY') && !out.includes('PREFETCH'), 'switch held behind hints', out);
    out = seq.rewrite('v', 'backup b', session('b', 9000, 3, 7, 10) + HINTS, false);
    at = out.indexOf('#EXT-X-DISCONTINUITY\n');
    ok(at > out.indexOf('https://b/6.ts') && at < out.indexOf('https://b/7.ts') && out.includes('PREFETCH'), 'switch marked past hints', out);
    // In an ad break LIVE-SEQUENCE is not trusted: the other session is a plain jump.
    seq = createMediaSequencer();
    seq.rewrite('v', 'primary', session('p', 15, 0, 4, 0), false);
    out = seq.rewrite('v', 'backup b', session('b', 9000, 5, 6, 0), true);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:20\n#EXT-X-DISCONTINUITY\n'), 'no live alignment during a break', out);
}
{ // Variants of a master share one numbering.
    let seq = createMediaSequencer();
    seq.rewrite('720', 'primary', plain(22889, 3, '720'), false);
    let active = null;
    for (let first = 22889; first <= 23062; first++) active = seq.rewrite('480', 'primary', plain(first, 3, '480'), false);
    ok(active.includes('#EXT-X-MEDIA-SEQUENCE:23062\n'), 'active variant', active);
    let woken = seq.rewrite('720', 'primary', plain(23062, 3, '720'), false);
    ok(woken.includes('#EXT-X-MEDIA-SEQUENCE:23062\n') && !woken.includes('DISCONTINUITY') && woken.includes('https://720/23064.ts')
        && !woken.includes('https://480/'), 'woken variant keeps the stream numbers', woken);
    seq = createMediaSequencer();
    seq.rewrite('480', 'primary', session('480', 15, 0, 4, 0), false);
    const fresh = seq.rewrite('audio', 'primary', session('audio', 15, 2, 6, 0), false);
    ok(fresh.includes('#EXT-X-MEDIA-SEQUENCE:17\n') && !fresh.includes('DISCONTINUITY'), 'first-seen variant lines up', fresh);
    seq = createMediaSequencer();
    seq.rewrite('480', 'primary', timed(100, 0, 4), false);
    seq.rewrite('480', 'backup b', timed(5000, 1, 5), false);
    woken = seq.rewrite('720', 'backup b', timed(5000, 2, 6), false);
    ok(woken.includes('#EXT-X-MEDIA-SEQUENCE:105\n#EXT-X-DISCONTINUITY\n') && woken.includes('/5006.ts'), 'backup alike on every variant', woken);
}
{ // The playlist's session id is the source; every quality of a session shares it.
    const sid = (id) => `#EXT-X-DATERANGE:ID="s",CLASS="twitch-session",START-DATE="${iso(T0)}",X-TV-TWITCH-SESSIONID="${id}"\n`;
    const withSid = (text, id) => text.replace('#EXTINF', sid(id) + '#EXTINF');
    const seq = createMediaSequencer();
    seq.rewrite('720', 'primary', withSid(plain(100, 3, '720'), 'A'), false);
    let out = seq.rewrite('480', 'primary', withSid(plain(101, 3, '480'), 'A'), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:101\n') && !out.includes('DISCONTINUITY'), 'same session: shared numbers', out);
    // Another session whose own numbers overlap the served ones: still new segments, after a jump.
    out = seq.rewrite('720', 'primary', withSid(plain(102, 3, 'b'), 'B'), false);
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:104\n#EXT-X-DISCONTINUITY\n') && out.includes('https://b/102.ts'), 'new session id = new source', out);
}
{ // An fMP4 init segment goes out once, before the first segment.
    const map = '#EXT-X-MAP:URI="https://s/init.mp4"';
    const out = createMediaSequencer().rewrite('v', 'primary', HEAD(10) + map + '\n#EXTINF:2.000,live\nhttps://s/10.mp4\n#EXTINF:2.000,live\nhttps://s/11.mp4\n', false);
    ok(out.includes(map + '\n#EXTINF:2.000,live\nhttps://s/10.mp4') && out.indexOf('#EXT-X-MAP') === out.lastIndexOf('#EXT-X-MAP'), 'map once', out);
}
{ // Twitch's real live shape over steady polls: numbers, segments and hints pass through untouched.
    const real = (first) => '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n'
        + `#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-TWITCH-LIVE-SEQUENCE:${first}\n#EXT-X-TWITCH-ELAPSED-SECS:69652.000\n`
        + `#EXT-X-DATERANGE:ID="a",CLASS="twitch-session",START-DATE="${iso(T0)}",END-ON-NEXT=YES,X-TV-TWITCH-SESSIONID="5834"\n`
        + `#EXT-X-DATERANGE:ID="b",CLASS="twitch-trigger",START-DATE="${iso(T0)}",END-ON-NEXT=YES\n`
        + Array.from({ length: 6 }, (_, i) => `#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + (first + i) * 2000)}\n#EXTINF:2.000,live\nhttps://c/${first + i}.ts\n`).join('')
        + `#EXT-X-TWITCH-PREFETCH:https://c/${first + 6}.ts\n#EXT-X-TWITCH-PREFETCH:https://c/${first + 7}.ts\n`;
    const seq = createMediaSequencer();
    for (let first = 34826; first < 34840; first++) {
        const input = real(first);
        const out = seq.rewrite('1080', 'primary', input, false);
        const segs = (t) => t.split('\n').filter((l) => !l.startsWith('#EXT-X-MEDIA-SEQUENCE')).sort().join('\n');
        ok(out.includes(`#EXT-X-MEDIA-SEQUENCE:${first}\n`) && !out.includes('DISCONTINUITY') && segs(out) === segs(input),
            'steady poll ' + first, out);
    }
}

{ // The glue as shipped in vaft.js: per-master sequencer, kill switch, fallback to VAFT's text.
    const self = {};
    const StreamInfosByUrl = { 'https://v/1080.m3u8': { IsShowingAd: false, ActiveBackupPlayerType: null } };
    const createSeq = load('createMediaSequencer', {});
    const sequenceM3U8 = load('sequenceM3U8', { self, StreamInfosByUrl, createMediaSequencer: createSeq });
    const url = 'https://v/1080.m3u8';
    let out = sequenceM3U8(url, plain(100, 3));
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:100\n'), 'glue sequences', out);
    StreamInfosByUrl[url].ActiveBackupPlayerType = 'embed';
    out = sequenceM3U8(url, plain(5000, 2));
    ok(out.includes('#EXT-X-MEDIA-SEQUENCE:103\n#EXT-X-DISCONTINUITY\n'), 'backup player type is the source', out);
    assert.strictEqual(sequenceM3U8('https://v/unknown.m3u8', 'x'), 'x', 'unknown variant passes through');
    StreamInfosByUrl[url].ReyohohoSequencer = { rewrite() { throw new Error('boom'); } };
    assert.strictEqual(sequenceM3U8(url, plain(1, 1)), plain(1, 1), 'failure serves VAFT text');
    self.ReyohohoSequencerEnabled = false;
    assert.strictEqual(sequenceM3U8(url, plain(1, 1)), plain(1, 1), 'kill switch passes through');
}

console.log('vaft self-check: ok');
