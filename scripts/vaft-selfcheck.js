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
// CLASS first, as Twitch sends it (the upstream signifier matches that exact prefix).
const trigger = '#EXT-X-DATERANGE:CLASS="twitch-trigger",ID="t1",START-DATE="2026-11-08T10:00:00.000Z"\n';

assert.strictEqual(hasAdTags(head + live(0) + live(1)), false, 'clean playlist');
assert.strictEqual(hasAdTags(head + trigger + live(0) + live(1)), false, 'twitch-trigger over live segments is not an ad');
assert.strictEqual(hasAdTags(head + trigger + live(0) + '#EXTINF:2.000,Amazon|123\nhttps://cdn/ad.ts\n'), true,
    'twitch-trigger next to an ad segment is an ad');
assert.strictEqual(hasAdTags(head + '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad"\n' + live(0)), true,
    'stitched-ad still counts over live segments');
assert.strictEqual(hasAdTags(head + '#EXT-X-DATERANGE:CLASS="twitch-maf-ad",ID="m1"\n' + live(0)), true,
    'twitch-maf-ad still counts (CSAI cue is stripped by the fast path)');

console.log('vaft self-check: ok');
