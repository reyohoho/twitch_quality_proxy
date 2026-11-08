// ============================================
// ReYohoho Twitch Proxy - Media playlist sequencer (VAFT)
// ============================================
// Port of ReTwitch's MediaSequencer (ads/MediaSequencer.java), minus the ad
// stripping, which VAFT does itself. VAFT serves one variant from several
// sources (the stream, clean backups, replayed snapshots); the player needs
// one numbering across them:
//  - numbers only grow, stay fixed per segment and are shared by all variants
//    of a master (the player carries its position over a quality switch);
//  - #EXT-X-DISCONTINUITY wherever the timeline jumps (source switch, gap);
//  - on a jump, no segment whose PROGRAM-DATE-TIME was already served (a new
//    source's whole window replayed ~30 s per switch);
//  - on a jump, numbers past the served prefetch hints (low latency plays them
//    as the next numbers, so a reused number hid the discontinuity: frozen
//    video on the timestamp jump while audio went on).
// Segments are keyed by source (the playlist's session id: every quality of
// a session shares it and its numbers) plus number and, outside ad breaks, by
// the broadcast's own #EXT-X-TWITCH-LIVE-SEQUENCE (the same in every viewer
// session), so another session lines up with what was served, without a gap.
// A single clean source keeps its numbering untouched.
// Self-contained on purpose: VAFT copies it into the player worker via toString().
function createMediaSequencer() {
    const MAPPED_SEGMENTS = 768;
    // Polls in a row whose new segments were all held back by the time check:
    // then the check goes, a source with a lagging clock must not stall playback.
    const MAX_HELD_POLLS = 3;
    // On that escape only this many newest segments go out (a live edge, not the window).
    const LIVE_EDGE_SEGMENTS = 3;

    const outSeq = new Map(); // '<source>#<n>' / 'live#<n>' -> output number of a served segment
    const discontinuities = new Set(); // output numbers that start a discontinuity
    const last = new Map(); // variant -> last playlist served
    let discontinuityBase = 0;
    let nextSeq = -1; // -1: nothing served yet
    let servedUntilMs = -Infinity; // end time of the latest served segment
    let reservedSeq = -1; // first number past every served segment and prefetch hint
    let reservedUntilMs = -Infinity; // estimated end time of the served prefetch hints
    let heldPolls = 0;
    let lastSource = null; // source of the latest newly numbered segment
    // After a switch that kept the broadcast's numbering: the first number the
    // player can't hold yet, where the switch gets its discontinuity; -1 when
    // none is pending. Until then no prefetch hint goes out (a hint can't carry it).
    let switchAt = -1;

    function remember(key, seq) {
        outSeq.set(key, seq);
        if (outSeq.size > MAPPED_SEGMENTS) outSeq.delete(outSeq.keys().next().value);
    }

    function isSegmentTag(line) {
        return line.startsWith('#EXT-X-PROGRAM-DATE-TIME') || line.startsWith('#EXT-X-DATERANGE')
            || line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-BYTERANGE')
            || line.startsWith('#EXT-X-TWITCH-PREFETCH') || line.startsWith('#EXT-X-PRELOAD-HINT');
    }

    function parseNumber(value) {
        const n = parseInt(value, 10);
        return isNaN(n) ? -1 : n;
    }

    // @param variant  the media playlist being polled (its URL)
    // @param fallbackSource  source name when the playlist has no session id
    // @param text  the playlist VAFT is about to serve
    // @param adBreak  inside an ad break (LIVE-SEQUENCE is then not trusted)
    // @return the playlist to serve, or null when no segment is left to serve
    //         (the caller then holds last(variant))
    function rewrite(variant, fallbackSource, text, adBreak) {
        const session = text.match(/X-TV-TWITCH-SESSIONID="([^"]+)"/);
        const source = session ? session[1] : fallbackSource;
        const header = [];
        let pending = [];
        let kept = [];
        let pendingDiscontinuity = false;
        let seenSegment = false;
        let mediaSeq = 0;
        let liveSeq = -1;
        let map = null;
        let index = 0;

        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\r$/, '');
            if (!line) continue;
            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                mediaSeq = Math.max(0, parseNumber(line.slice(line.indexOf(':') + 1)));
            } else if (line.startsWith('#EXT-X-TWITCH-LIVE-SEQUENCE:')) {
                // Trusted only without a break: where an ad window numbers from is unknown.
                liveSeq = adBreak ? -1 : parseNumber(line.slice(line.indexOf(':') + 1));
                header.push(line);
            } else if (line.startsWith('#EXT-X-MAP')) {
                map = line; // applies to every following segment, re-emitted before the first one
            } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
                // re-emitted from our own count
            } else if (line === '#EXT-X-DISCONTINUITY') {
                pendingDiscontinuity = true;
                seenSegment = true;
            } else if (line.startsWith('#EXTINF')) {
                seenSegment = true;
                const uri = i + 1 < lines.length ? lines[++i].trim() : '';
                let startMs = -1;
                for (const tag of pending) {
                    if (tag.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                        const t = Date.parse(tag.slice(tag.indexOf(':') + 1).trim());
                        startMs = isNaN(t) ? -1 : t;
                    }
                }
                const comma = line.indexOf(',');
                const duration = parseFloat(line.slice(line.indexOf(':') + 1, comma < 0 ? line.length : comma));
                if (uri) {
                    kept.push({
                        sourceSeq: mediaSeq + index,
                        liveSeq: liveSeq < 0 ? -1 : liveSeq + index,
                        tags: pending, extinf: line, uri, map,
                        discontinuity: pendingDiscontinuity,
                        startMs,
                        durationMs: isNaN(duration) ? 0 : Math.round(duration * 1000),
                        seq: -1
                    });
                }
                pendingDiscontinuity = false;
                pending = [];
                index++;
            } else if (!seenSegment && !isSegmentTag(line)) {
                header.push(line);
            } else {
                seenSegment = true;
                pending.push(line);
            }
        }
        const footer = pending; // tags after the last segment (prefetch hints, ENDLIST)
        if (kept.length === 0) return null;

        const escape = heldPolls >= MAX_HELD_POLLS;
        const edge = kept.length - LIVE_EDGE_SEGMENTS;
        let heldBack = false;
        let servedNew = false;
        const numbered = [];
        for (let i = 0; i < kept.length; i++) {
            const s = kept[i];
            const key = source + '#' + s.sourceSeq;
            const liveKey = s.liveSeq >= 0 ? 'live#' + s.liveSeq : null;
            let known = liveKey !== null ? outSeq.get(liveKey) : undefined;
            if (known === undefined) known = outSeq.get(key);
            if (known !== undefined) {
                s.seq = known;
            } else {
                let prev = s.liveSeq >= 0 ? outSeq.get('live#' + (s.liveSeq - 1)) : undefined;
                if (prev === undefined) prev = outSeq.get(source + '#' + (s.sourceSeq - 1));
                if (prev !== undefined && prev + 1 >= nextSeq) {
                    s.seq = prev + 1;
                    if (lastSource !== null && lastSource !== source) {
                        // Same broadcast timeline from another session: mark the switch,
                        // past the prefetch hints already served (they may have been an ad).
                        switchAt = Math.max(s.seq, reservedSeq);
                    }
                } else if (nextSeq < 0) {
                    s.seq = s.sourceSeq;
                } else if (s.startMs >= 0 && servedUntilMs !== -Infinity
                    && s.startMs + s.durationMs / 2 <= Math.max(servedUntilMs, reservedUntilMs)
                    && !(escape && i >= edge)) {
                    // Another source's window reaches back over time already played: skip it
                    // (not mapped, so later polls skip it too).
                    heldBack = true;
                    continue;
                } else {
                    // Gap or another source: continue after anything the player may hold
                    // (prefetched numbers too), mark the jump.
                    s.seq = Math.max(nextSeq, reservedSeq);
                    discontinuities.add(s.seq);
                    switchAt = -1;
                }
                if (s.discontinuity) discontinuities.add(s.seq);
                if (switchAt >= 0 && s.seq >= switchAt) {
                    discontinuities.add(s.seq);
                    switchAt = -1;
                }
                lastSource = source;
                servedNew = true;
            }
            remember(key, s.seq);
            if (liveKey !== null) remember(liveKey, s.seq);
            numbered.push(s);
            nextSeq = Math.max(nextSeq, s.seq + 1);
            if (s.startMs >= 0) servedUntilMs = Math.max(servedUntilMs, s.startMs + s.durationMs);
        }
        if (servedNew) {
            heldPolls = 0;
        } else if (heldBack) {
            heldPolls++;
        }
        kept = numbered;
        if (kept.length === 0) return null;
        // A playlist numbers its segments consecutively: drop older ones before a gap.
        for (let i = kept.length - 1; i > 0; i--) {
            if (kept[i].seq !== kept[i - 1].seq + 1) {
                kept = kept.slice(i);
                break;
            }
        }

        const first = kept[0].seq;
        for (const d of [...discontinuities]) {
            if (d < first) {
                discontinuities.delete(d);
                discontinuityBase++;
            }
        }

        const out = [...header, '#EXT-X-MEDIA-SEQUENCE:' + first];
        if (discontinuityBase > 0) out.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + discontinuityBase);
        let lastMap = null;
        for (const s of kept) {
            if (discontinuities.has(s.seq)) out.push('#EXT-X-DISCONTINUITY');
            if (s.map !== null && s.map !== lastMap) {
                // Before the first segment that uses it, and again when another source brings its own.
                lastMap = s.map;
                out.push(s.map);
            }
            out.push(...s.tags, s.extinf, s.uri);
        }
        let hints = 0;
        for (const line of footer) {
            const isHint = line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:');
            if (isHint && switchAt >= 0) continue;
            out.push(line);
            if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) hints++;
        }
        const tail = kept[kept.length - 1];
        reservedSeq = Math.max(reservedSeq, tail.seq + 1 + hints);
        if (tail.startMs >= 0) reservedUntilMs = Math.max(reservedUntilMs, tail.startMs + tail.durationMs * (1 + hints));
        const playlist = out.join('\n') + '\n';
        last.set(variant, playlist);
        return playlist;
    }

    return {
        rewrite,
        last: (variant) => last.get(variant) || null
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createMediaSequencer };
}
