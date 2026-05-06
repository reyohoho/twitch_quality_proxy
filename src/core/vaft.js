// ============================================
// ReYohoho Twitch Proxy - VAFT Ad Blocker
// Synced with TwitchAdSolutions/vaft v65.3.0 (twitchAdSolutionsVersion=71)
// Upstream: https://github.com/ryanbr/TwitchAdSolutions
// Local additions:
//   - Wrapped in initVAFT() for build-time injection
//   - VAFT_CONFIG-driven defaults (see constants.js)
//   - Audio state restore around hard reloads
//   - CustomEvent bridge (reyohoho-vaft-simulate / reyohoho-vaft-stop)
//   - Russian banner text
//   - module.exports for unit tests / build pipeline
// ============================================

// @include constants.js

function initVAFT() {
    // Skip injection in nested frames that aren't legitimate Twitch embed contexts.
    let _isNested = false;
    try { _isNested = window.frameElement !== null; } catch (_e) { _isNested = true; }
    if (_isNested) {
        const _host = document.location.hostname;
        const _isEmbedContext = _host === 'player.twitch.tv' || _host === 'embed.twitch.tv' || document.location.pathname.startsWith('/embed/');
        if (!_isEmbedContext) {
            console.log('[ReYohoho VAFT] skipped — nested frame on ' + _host + document.location.pathname + ' (not a Twitch embed).');
            return;
        }
    }
    // Skip injection on the Twitch clip editor — clips.twitch.tv host or /<channel>/clip/<slug> path.
    {
        const _clipHost = document.location.hostname;
        const _clipPath = document.location.pathname || '';
        if (_clipHost === 'clips.twitch.tv' || /^\/[^/]+\/clip\/[^/]+/.test(_clipPath)) {
            console.log('[ReYohoho VAFT] skipped — clip editor page (' + _clipHost + _clipPath + ').');
            return;
        }
    }
    'use strict';
    const ourTwitchAdSolutionsVersion = 71;
    console.log('[ReYohoho VAFT] v' + ourTwitchAdSolutionsVersion + ' loading');
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log('[ReYohoho VAFT] CONFLICT: skipped — another script already active (v' + window.twitchAdSolutionsVersion + '). Remove duplicate scripts.');
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;

    // Defaults pulled from VAFT_CONFIG (constants.js). Falls back to upstream literals
    // when VAFT_CONFIG is absent (e.g. unit tests that import vaft.js directly).
    const CFG = (typeof VAFT_CONFIG !== 'undefined' && VAFT_CONFIG) ? VAFT_CONFIG : {};

    // Configuration and state shared between window and worker scopes
    function declareOptions(scope) {
        scope.AdSignifiers = (typeof CFG.AdSignifiers !== 'undefined') ? [...CFG.AdSignifiers] : ['stitched-ad', 'EXT-X-CUE-OUT', 'twitch-stitched', 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"'];
        scope.AdSegmentURLPatterns = (typeof CFG.AdSegmentURLPatterns !== 'undefined') ? [...CFG.AdSegmentURLPatterns] : ['/adsquared/', '/_404/', '/processing'];
        scope.TwitchAdUrlRewriteRegex = /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g;
        scope.UriAttributeRegex = /URI="([^"]+)"/;
        scope.ClientID = CFG.ClientID || 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = (typeof CFG.BackupPlayerTypes !== 'undefined') ? [...CFG.BackupPlayerTypes] : ['site', 'popout', 'mobile_web', 'embed'];
        scope.FallbackPlayerType = CFG.FallbackPlayerType || 'site';
        scope.ForceAccessTokenPlayerType = (typeof CFG.ForceAccessTokenPlayerType !== 'undefined') ? CFG.ForceAccessTokenPlayerType : 'popout';
        scope.PreferLowQualityBackup = (typeof CFG.PreferLowQualityBackup === 'boolean') ? CFG.PreferLowQualityBackup : true;
        scope.FastAutoplayFirstTry = (typeof CFG.FastAutoplayFirstTry === 'boolean') ? CFG.FastAutoplayFirstTry : false;
        scope.BackupSwapFirst = (typeof CFG.BackupSwapFirst === 'boolean') ? CFG.BackupSwapFirst : true;
        scope.SkipPlayerReloadOnHevc = (typeof CFG.SkipPlayerReloadOnHevc === 'boolean') ? CFG.SkipPlayerReloadOnHevc : false;
        scope.AlwaysReloadPlayerOnAd = (typeof CFG.AlwaysReloadPlayerOnAd === 'boolean') ? CFG.AlwaysReloadPlayerOnAd : false;
        scope.ReloadPlayerAfterAd = (typeof CFG.ReloadPlayerAfterAd === 'boolean') ? CFG.ReloadPlayerAfterAd : true;
        scope.ReloadCooldownSeconds = (typeof CFG.ReloadCooldownSeconds === 'number') ? CFG.ReloadCooldownSeconds : 30;
        scope.DisableReloadCap = (typeof CFG.DisableReloadCap === 'boolean') ? CFG.DisableReloadCap : false;
        scope.DriftCorrectionRate = (typeof CFG.DriftCorrectionRate === 'number') ? CFG.DriftCorrectionRate : 1.1;
        scope.EarlyReloadPollThreshold = (typeof CFG.EarlyReloadPollThreshold === 'number') ? CFG.EarlyReloadPollThreshold : 3;
        scope.PinBackupPlayerType = (typeof CFG.PinBackupPlayerType === 'boolean') ? CFG.PinBackupPlayerType : true;
        scope.PlayerReloadMinimalRequestsTime = (typeof CFG.PlayerReloadMinimalRequestsTime === 'number') ? CFG.PlayerReloadMinimalRequestsTime : 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = (typeof CFG.PlayerReloadMinimalRequestsPlayerIndex === 'number') ? CFG.PlayerReloadMinimalRequestsPlayerIndex : 2;
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = Object.create(null);
        scope.StreamInfosByUrl = Object.create(null);
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = (typeof CFG.PlayerBufferingFix === 'boolean') ? CFG.PlayerBufferingFix : true;
        scope.PlayerBufferingDelay = (typeof CFG.PlayerBufferingDelay === 'number') ? CFG.PlayerBufferingDelay : 600;
        scope.PlayerBufferingSameStateCount = (typeof CFG.PlayerBufferingSameStateCount === 'number') ? CFG.PlayerBufferingSameStateCount : 3;
        scope.PlayerBufferingDangerZone = (typeof CFG.PlayerBufferingDangerZone === 'number') ? CFG.PlayerBufferingDangerZone : 1;
        scope.PlayerBufferingDoPlayerReload = (typeof CFG.PlayerBufferingDoPlayerReload === 'boolean') ? CFG.PlayerBufferingDoPlayerReload : false;
        scope.PlayerBufferingMinRepeatDelay = (typeof CFG.PlayerBufferingMinRepeatDelay === 'number') ? CFG.PlayerBufferingMinRepeatDelay : 8000;
        scope.PlayerBufferingPrerollCheckEnabled = (typeof CFG.PlayerBufferingPrerollCheckEnabled === 'boolean') ? CFG.PlayerBufferingPrerollCheckEnabled : false;
        scope.PlayerBufferingPrerollCheckOffset = (typeof CFG.PlayerBufferingPrerollCheckOffset === 'number') ? CFG.PlayerBufferingPrerollCheckOffset : 5;
        scope.V2API = false;
        scope.IsAdStrippingEnabled = (typeof CFG.IsAdStrippingEnabled === 'boolean') ? CFG.IsAdStrippingEnabled : true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
        scope.StreamInfoMaxAgeMs = (typeof CFG.StreamInfoMaxAgeMs === 'number') ? CFG.StreamInfoMaxAgeMs : 30 * 60 * 1000;
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
    function createStreamInfo(channelName, encodingsM3u8, usherParams) {
        return {
            ChannelName: channelName,
            LastSeenAt: Date.now(),
            EncodingsM3U8: encodingsM3u8,
            UsherParams: usherParams,
            Urls: Object.create(null),
            ResolutionList: [],
            RequestedAds: new Set(),
            ModifiedM3U8: null,
            IsUsingModifiedM3U8: false,
            IsShowingAd: false,
            IsMidroll: false,
            AdBreakStartedAt: 0,
            PodLength: 1,
            HasConfirmedAdAttrs: false,
            CleanPlaylistCount: 0,
            PendingAdEndAt: 0,
            AdEndBounceCount: 0,
            ConsecutiveZeroStripBreaks: 0,
            CsaiOnlyThisBreak: false,
            IsStrippingAdSegments: false,
            NumStrippedAdSegments: 0,
            RecoverySegments: [],
            RecoveryStartSeq: undefined,
            FreezeStartedAt: 0,
            ConsecutiveAllStrippedPolls: 0,
            TotalAllStrippedPolls: 0,
            LastCleanNativeM3U8: null,
            LastCleanNativePlaylistAt: 0,
            BackupEncodingsM3U8Cache: [],
            ActiveBackupPlayerType: null,
            PinnedBackupPlayerType: null,
            LastCommittedBackupPlayerType: null,
            FailedBackupPlayerTypes: new Map(),
            LoggedBackupAdsByType: null,
            CycleRescuedThisBreak: false,
            EarlyReloadCount: 0,
            EarlyReloadAtPoll: 0,
            EarlyReloadTriggered: false,
            EarlyReloadAwaitingResult: false,
            EscapeHatchFired: false,
            LastBreakUsedEscapeHatch: false,
            LastPlayerReload: 0,
            ReloadTimestamps: [],
            HasCheckedUnknownTags: false,
            HasLoggedAdAttributes: false,
            HasLoggedUnknownSignifiers: false
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
    let cachedRootNode = null;
    let cachedPlayerRootDiv = null;
    let loggedSdaHide = false;

    // ReYohoho: audio state restore around hard reloads (kept from prior version)
    let lastKnownAudioState = null;
    let audioRestoreToken = 0;
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

    // Strings used to detect and handle conflicting Twitch worker overrides (e.g. TwitchNoSub)
    const workerStringConflicts = [
        'twitch',
        'isVariantA' // TwitchNoSub
    ];
    const workerStringReinsert = [
        'isVariantA',   // TwitchNoSub (prior to (0.9))
        'besuper/',     // TwitchNoSub (0.9)
        '${patch_url}'  // TwitchNoSub (0.9.1)
    ];
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x))) {
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
        const hasConflict = workerStringConflicts.some((x) => workerString.includes(x));
        const hasReinsert = workerStringReinsert.some((x) => workerString.includes(x));
        if (hasConflict && !hasReinsert) {
            console.log('[ReYohoho VAFT] Worker rejected — conflict string found: ' + workerStringConflicts.filter((x) => workerString.includes(x)).join(', '));
        }
        return !hasConflict || hasReinsert;
    }
    let injectedBlobUrl = null;
    let originalRevokeObjectURL = null;
    function hookWindowWorker() {
        if (!URL.revokeObjectURL.__tasMasked) {
            originalRevokeObjectURL = URL.revokeObjectURL;
            URL.revokeObjectURL = maskAsNative(function (url) {
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
                } catch { }
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    return;
                }
                let prefetchedWorkerJs = null;
                try { prefetchedWorkerJs = getWasmWorkerJs(twitchBlobUrl); } catch { }
                if (!prefetchedWorkerJs) {
                    super(twitchBlobUrl, options);
                    console.log('[ReYohoho VAFT] Failed to fetch worker JS — falling back to unmodified worker');
                    return;
                }
                console.log('[ReYohoho VAFT] Worker intercepted — injecting ad-block hooks');
                const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${hasAdTags.toString()}
                    ${getMatchedAdSignifiers.toString()}
                    ${stripAdSegments.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    ${pruneStreamInfos.toString()}
                    ${createStreamInfo.toString()}
                    const CFG = ${JSON.stringify(CFG)};
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    if (!self.__tasPruneInterval) {
                        self.__tasPruneInterval = setInterval(pruneStreamInfos, 5 * 60 * 1000);
                    }
                    GQLDeviceID = ${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = ${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = ${ClientSession ? "'" + ClientSession + "'" : null};
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
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('SimulatedAdsDepth: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments: ' + AllSegmentsAreAdSegments);
                        }
                    });
                    hookWorkerFetch();
                    eval(workerString);
                `;
                if (injectedBlobUrl && originalRevokeObjectURL) {
                    try { originalRevokeObjectURL.call(URL, injectedBlobUrl); } catch { }
                }
                injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                super(injectedBlobUrl, options);
                twitchWorkers.length = 0;
                twitchWorkers.push(this);
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        updateAdblockBanner(e.data);
                        if (e.data.hasAds !== !!playerBufferState.inAdBreak) {
                            playerBufferState.lastBackupSwitchAt = Date.now();
                            if (!e.data.hasAds) {
                                playerBufferState.position = 0;
                            }
                        }
                        playerBufferState.inAdBreak = !!e.data.hasAds;
                        if (e.data.hasAds && (driftCatchUpInterval || driftCatchUpTimeout)) {
                            if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
                            if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
                            try { document.querySelector('video').playbackRate = 1.0; } catch { }
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
                let crashed = false;
                this.addEventListener('error', (e) => {
                    if (crashed) return;
                    crashed = true;
                    console.log('[ReYohoho VAFT] IVS WASM worker crashed: ' + ((e && e.message) || 'unknown error') + ' — triggering hard reload to recover');
                    try { doTwitchPlayerTask(false, true, 'early'); } catch (err) {
                        console.log('[ReYohoho VAFT] Worker crash recovery failed: ' + err.message);
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
    function hookWorkerFetch() {
        console.log('[ReYohoho VAFT] hookWorkerFetch');
        const BLANK_MP4 = new Blob([Uint8Array.from(atob('AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA'), c => c.charCodeAt(0))], { type: 'video/mp4' });
        const realFetch = fetch;
        fetch = async function (url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Response(BLANK_MP4);
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
                        realFetch(url, options).then(function (response) {
                            processAfter(response);
                        })['catch'](function (err) {
                            reject(err);
                        });
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const parsedUrl = new URL(url);
                    const channelName = parsedUrl.pathname.match(/([^\/]+)(?=\.\w+$)/)?.[0];
                    if (ForceAccessTokenPlayerType) {
                        parsedUrl.searchParams.delete('parent_domains');
                        url = parsedUrl.toString();
                    }
                    return new Promise(function (resolve, reject) {
                        const processAfter = async function (response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = await response.text();
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null && (await realFetch(streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m)?.[0])).status !== 200) {
                                    streamInfo = null;
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    HasTriggeredPlayerReload = false;
                                    console.log('[ReYohoho VAFT] New stream session — channel: ' + channelName + ', API: ' + (V2API ? 'v2' : 'v1'));
                                    StreamInfos[channelName] = streamInfo = createStreamInfo(channelName, encodingsM3u8, parsedUrl.search);
                                    const lines = encodingsM3u8.split(/\r?\n/);
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'],
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
                                        console.log('[ReYohoho VAFT] No resolutions parsed from encodings m3u8 — Twitch may have changed the format');
                                    }
                                    const nonHevcResolutionList = streamInfo.ResolutionList.filter((element) => element.Codecs.startsWith('avc') || element.Codecs.startsWith('av0'));
                                    if (AlwaysReloadPlayerOnAd || (nonHevcResolutionList.length > 0 && streamInfo.ResolutionList.some((element) => element.Codecs.startsWith('hev') || element.Codecs.startsWith('hvc')) && !SkipPlayerReloadOnHevc)) {
                                        const replaceOrAppendStreamInfAttr = (line, key, value) => {
                                            if (typeof value !== 'string' || !value) return line;
                                            const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
                                                        console.log('[ReYohoho VAFT] ModifiedM3U8 swap ' + resSettings[codecsKey] + ' to ' + newResolutionInfo.Codecs + ' oldRes:' + oldResolution + ' newRes:' + newResolutionInfo.Resolution);
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${newResolutionInfo.Codecs}"`);
                                                        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'AUDIO', newResolutionInfo.Audio);
                                                        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'VIDEO', newResolutionInfo.Video);
                                                        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'SUBTITLES', newResolutionInfo.Subtitles);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);
                                                    }
                                                }
                                            }
                                        }
                                        if (nonHevcResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\n');
                                        }
                                    }
                                }
                                streamInfo.LastSeenAt = Date.now();
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function (response) {
                            processAfter(response);
                        })['catch'](function (err) {
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
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function hasAdTags(textStr) {
        return AdSignifiers.some((s) => textStr.includes(s));
    }
    function getMatchedAdSignifiers(textStr) {
        return AdSignifiers.filter((s) => textStr.includes(s));
    }
    function stripAdSegments(textStr, stripAllSegments, streamInfo) {
        let hasStrippedAdSegments = false;
        let inCueOut = false;
        const liveSegments = [];
        const lines = textStr.split(/\r?\n/);
        const newAdUrl = 'https://twitch.tv';
        if (!streamInfo.HasLoggedAdAttributes) {
            const adAttrs = textStr.match(/X-TV-TWITCH-AD[A-Z-]*(?==")/g);
            if (adAttrs && adAttrs.length > 0) {
                streamInfo.HasLoggedAdAttributes = true;
                console.log('[ReYohoho VAFT] Ad tracking attributes seen: ' + [...new Set(adAttrs)].join(', '));
            }
        }
        if (!streamInfo.HasLoggedUnknownSignifiers) {
            const candidates = new Set();
            let sm;
            const classRe = /EXT-X-DATERANGE:[^\n]*CLASS="(twitch-[^"]+)"/g;
            while ((sm = classRe.exec(textStr)) !== null) {
                candidates.add('EXT-X-DATERANGE:CLASS="' + sm[1] + '"');
            }
            const tagRe = /(SCTE35-[A-Z-]+|EXT-X-CUE-[A-Z-]+)/g;
            while ((sm = tagRe.exec(textStr)) !== null) {
                candidates.add(sm[1]);
            }
            const unknown = [...candidates].filter(c => !AdSignifiers.some(s => c.includes(s)));
            if (unknown.length > 0) {
                streamInfo.HasLoggedUnknownSignifiers = true;
                console.log('[ReYohoho VAFT] Potential ad markers seen but not in AdSignifiers: ' + unknown.join(', '));
            }
        }
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (line.includes('EXT-X-CUE-OUT')) {
                if (!inCueOut) {
                    console.log('[ReYohoho VAFT] SCTE-35 CUE-OUT — ad boundary entered');
                }
                inCueOut = true;
            } else if (line.includes('EXT-X-CUE-IN')) {
                if (inCueOut) {
                    console.log('[ReYohoho VAFT] SCTE-35 CUE-IN — ad boundary exited');
                }
                inCueOut = false;
            }
            lines[i] = line.replaceAll(TwitchAdUrlRewriteRegex, `$1${newAdUrl}$2`);
            const isLiveSegment = line.includes(',live');
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!isLiveSegment || stripAllSegments || AllSegmentsAreAdSegments || inCueOut)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && AdSegmentURLPatterns.some((p) => lines[i + 1].includes(p))) {
                console.log('[ReYohoho VAFT] Ad segment detected via URL pattern: ' + lines[i + 1]);
                AdSegmentCache.set(lines[i + 1], Date.now());
                hasStrippedAdSegments = true;
                streamInfo.NumStrippedAdSegments++;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && isLiveSegment) {
                liveSegments.push({ extinf: line, url: lines[i + 1] });
            } else if (line.startsWith('#EXT-X-PART:')) {
                const partUriMatch = line.match(UriAttributeRegex);
                const partUri = partUriMatch ? partUriMatch[1] : '';
                if (partUri && (AdSegmentCache.has(partUri) || AdSegmentURLPatterns.some((p) => partUri.includes(p)))) {
                    AdSegmentCache.set(partUri, Date.now());
                    lines[i] = '';
                    hasStrippedAdSegments = true;
                }
            } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:')) {
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
        if (!hasStrippedAdSegments && AdSignifiers.some((s) => textStr.includes(s))) {
            hasStrippedAdSegments = true;
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:') || lines[i].startsWith('#EXT-X-PRELOAD-HINT:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        if (liveSegments.length > 0) {
            streamInfo.RecoverySegments = liveSegments.slice(-6);
            const seq = parseInt((textStr.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1]);
            if (!isNaN(seq)) {
                streamInfo.RecoveryStartSeq = seq + Math.max(0, liveSegments.length - streamInfo.RecoverySegments.length);
            }
        }
        if (hasStrippedAdSegments && liveSegments.length === 0) {
            streamInfo.ConsecutiveAllStrippedPolls = (streamInfo.ConsecutiveAllStrippedPolls || 0) + 1;
            streamInfo.TotalAllStrippedPolls = (streamInfo.TotalAllStrippedPolls || 0) + 1;
            if (!streamInfo.FreezeStartedAt) streamInfo.FreezeStartedAt = Date.now();
            const snapshotAge = streamInfo.LastCleanNativePlaylistAt ? (Date.now() - streamInfo.LastCleanNativePlaylistAt) : Infinity;
            if (streamInfo.LastCleanNativeM3U8 && snapshotAge <= 1500 && !hasAdTags(streamInfo.LastCleanNativeM3U8)) {
                console.log('[ReYohoho VAFT] All segments stripped — reusing last clean native playlist (' + snapshotAge + 'ms old)');
                streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
                return streamInfo.LastCleanNativeM3U8;
            }
            if (streamInfo.RecoverySegments && streamInfo.RecoverySegments.length > 0) {
                console.log('[ReYohoho VAFT] All segments stripped — restoring ' + streamInfo.RecoverySegments.length + ' recovery segments');
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
            streamInfo.ConsecutiveAllStrippedPolls = 0;
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        const now = Date.now();
        if (!streamInfo.LastAdCachePruneAt || now - streamInfo.LastAdCachePruneAt > 60000) {
            streamInfo.LastAdCachePruneAt = now;
            AdSegmentCache.forEach((value, key, map) => {
                if (value < now - 120000) {
                    map.delete(key);
                }
            });
            if (AdSegmentCache.size > 1000) {
                let evicted = 0;
                for (const url of AdSegmentCache.keys()) {
                    AdSegmentCache.delete(url);
                    if (++evicted >= 200) break;
                }
                if (!streamInfo.LoggedAdCacheSize1k) {
                    streamInfo.LoggedAdCacheSize1k = true;
                    console.log('[ReYohoho VAFT] AdSegmentCache exceeded 1000 entries — evicted oldest ' + evicted + ' (now ' + AdSegmentCache.size + ')');
                }
            }
        }
        return lines.join('\n');
    }
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.split(/\r?\n/);
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        let matchedResolutionUrl = null;
        let matchedFrameRate = false;
        let closestResolutionUrl = null;
        let closestResolutionDifference = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
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
        if (!streamInfo.HasCheckedUnknownTags) {
            streamInfo.HasCheckedUnknownTags = true;
            const unknownAdTags = textStr.match(/#EXT[^:\n]*(?:ad|cue|scte|sponsor)[^:\n]*/gi);
            if (unknownAdTags) {
                const unknown = unknownAdTags.filter(t => !AdSignifiers.some(s => t.includes(s)));
                if (unknown.length > 0) {
                    console.log('[ReYohoho VAFT] Unknown ad-related tags found: ' + [...new Set(unknown)].join(', '));
                }
            }
        }
        const haveAdTags = hasAdTags(textStr) || SimulatedAdsDepth > 0;
        if (!haveAdTags && !streamInfo.IsShowingAd && textStr.indexOf('#EXTINF') !== -1) {
            streamInfo.LastCleanNativeM3U8 = textStr;
            streamInfo.LastCleanNativePlaylistAt = Date.now();
        }
        if (haveAdTags) {
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
                const podLengthMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
                const podLength = podLengthMatch ? parseInt(podLengthMatch[1], 10) : 1;
                streamInfo.PodLength = podLength;
                streamInfo.EarlyReloadTriggered = false;
                streamInfo.EarlyReloadCount = 0;
                streamInfo.EarlyReloadAtPoll = 0;
                streamInfo.HasConfirmedAdAttrs = textStr.includes('X-TV-TWITCH-AD-AD-SESSION-ID') || textStr.includes('X-TV-TWITCH-AD-RADS-TOKEN');
                streamInfo.CycleRescuedThisBreak = false;
                streamInfo.LastCommittedBackupPlayerType = null;
                streamInfo.FreezeStartedAt = 0;
                streamInfo.CsaiOnlyThisBreak = false;
                console.log('[ReYohoho VAFT] Ad detected — type: ' + (streamInfo.IsMidroll ? 'midroll' : 'preroll') + ', channel: ' + streamInfo.ChannelName + ', pod: ' + podLength + ' ad(s) (~' + (podLength * 30) + 's expected), signifiers: ' + getMatchedAdSignifiers(textStr).join(', '));
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false
                });
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            fetch(lines[i + 1]).then((response) => response.blob()).catch(() => { });
                            break;
                        }
                    }
                }
            }
            const currentResolution = streamInfo.Urls[url];
            if (!currentResolution) {
                console.log('[ReYohoho VAFT] Ads will leak due to missing resolution info for ' + url);
                return stripAdSegments(textStr, false, streamInfo);
            }
            const isHevc = currentResolution.Codecs.startsWith('hev') || currentResolution.Codecs.startsWith('hvc');
            const postAdReentryGuardMs = 8000;
            const recentlyReloaded = streamInfo.LastPlayerReload && (Date.now() - streamInfo.LastPlayerReload) < postAdReentryGuardMs;
            if (((isHevc && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8 && !recentlyReloaded) {
                streamInfo.IsUsingModifiedM3U8 = true;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({ key: 'ReloadPlayer' });
            }
            if (PreferLowQualityBackup && streamInfo.CsaiOnlyThisBreak && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= 4) {
                const stuckPolls = streamInfo.ConsecutiveAllStrippedPolls;
                const recoveryCacheSize = streamInfo.RecoverySegments?.length || 0;
                const earlyReloadInfo = (streamInfo.EarlyReloadCount || 0) + '/' + Math.max(1, streamInfo.PodLength || 1);
                console.log('[ReYohoho VAFT] Sticky CSAI escape hatch — stuck ' + stuckPolls + ' polls (~' + (stuckPolls * 2) + 's), EarlyReloadCount=' + earlyReloadInfo + ', recovery cache=' + recoveryCacheSize + ' segments, falling through to backup search');
                streamInfo.CsaiOnlyThisBreak = false;
                streamInfo.EscapeHatchFired = true;
            }
            if (streamInfo.CsaiOnlyThisBreak && !streamInfo.IsUsingModifiedM3U8) {
                if (IsAdStrippingEnabled) {
                    textStr = stripAdSegments(textStr, false, streamInfo);
                }
                if (streamInfo.EarlyReloadAwaitingResult) {
                    streamInfo.EarlyReloadAwaitingResult = false;
                    console.log('[ReYohoho VAFT] Early reload result (sticky path): still ads — continuing recovery loop');
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
                    console.log('[ReYohoho VAFT] Early reload triggered (sticky path) — ' + streamInfo.ConsecutiveAllStrippedPolls + ' consecutive all-stripped polls' + stickyReason + ' [' + streamInfo.EarlyReloadCount + '/' + stickyMaxEarlyReloads + ']');
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
            const mainStreamLines = textStr.split(/\r?\n/);
            let hasNonLiveSegment = false;
            for (let i = 0; i < mainStreamLines.length; i++) {
                if (mainStreamLines[i].startsWith('#EXTINF') && !mainStreamLines[i].includes(',live')) {
                    hasNonLiveSegment = true;
                    break;
                }
            }
            if (!hasNonLiveSegment && !streamInfo.IsUsingModifiedM3U8 && !BackupSwapFirst) {
                streamInfo.CsaiOnlyThisBreak = true;
                console.log('[ReYohoho VAFT] CSAI fast path — all segments live, skipping backup search');
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
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                startIndex = PlayerReloadMinimalRequestsPlayerIndex;
                isDoingMinimalRequests = true;
            }
            const playerTypesToTry = PreferLowQualityBackup ? [...BackupPlayerTypes, 'autoplay'] : [...BackupPlayerTypes];
            if (streamInfo.PinnedBackupPlayerType) {
                const pinnedIndex = playerTypesToTry.indexOf(streamInfo.PinnedBackupPlayerType);
                if (pinnedIndex > 0) {
                    playerTypesToTry.splice(pinnedIndex, 1);
                    playerTypesToTry.unshift(streamInfo.PinnedBackupPlayerType);
                }
            }
            if (FastAutoplayFirstTry && streamInfo.LastBreakUsedEscapeHatch && PreferLowQualityBackup) {
                const autoplayIdx = playerTypesToTry.indexOf('autoplay');
                if (autoplayIdx > 0) {
                    playerTypesToTry.splice(autoplayIdx, 1);
                    playerTypesToTry.unshift('autoplay');
                    if (!streamInfo.LoggedFastAutoplayThisBreak) {
                        streamInfo.LoggedFastAutoplayThisBreak = true;
                        console.log('[ReYohoho VAFT] Fast-autoplay first-try — prior break exhausted Source-tier; probing autoplay first');
                    }
                }
            }
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
                        console.log('[ReYohoho VAFT] Contamination-aware reorder — trying [' + clean.join(', ') + '] before known-contaminated [' + contam.join(', ') + ']');
                    }
                }
            }
            for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < playerTypesToTry.length; playerTypeIndex++) {
                const playerType = playerTypesToTry[playerTypeIndex];
                const realPlayerType = playerType.replace('-CACHED', '');
                const failedAt = streamInfo.FailedBackupPlayerTypes.get(realPlayerType);
                if (failedAt && (Date.now() - failedAt) < 15000) {
                    continue;
                }
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
                                const spat = accessToken?.data?.streamPlaybackAccessToken || accessToken?.streamPlaybackAccessToken;
                                if (!spat) {
                                    const errInfo = accessToken?.errors ? ' errors: ' + JSON.stringify(accessToken.errors).substring(0, 300) : '';
                                    console.log('[ReYohoho VAFT] GQL response missing streamPlaybackAccessToken for ' + realPlayerType + '. Response keys: ' + JSON.stringify(Object.keys(accessToken || {})) + errInfo);
                                    streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                                    continue;
                                }
                                const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                                urlInfo.searchParams.set('sig', spat.signature);
                                urlInfo.searchParams.set('token', spat.value);
                                const encodingsM3u8Response = await realFetch(urlInfo.href);
                                if (encodingsM3u8Response.status === 200) {
                                    encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                                } else {
                                    console.log('[ReYohoho VAFT] Usher HTTP ' + encodingsM3u8Response.status + ' for ' + realPlayerType);
                                }
                            } else {
                                let errorBody = '';
                                try { errorBody = ' — ' + (await accessTokenResponse.text()).substring(0, 200); } catch { }
                                console.log('[ReYohoho VAFT] Access token HTTP ' + accessTokenResponse.status + ' for ' + realPlayerType + (accessTokenResponse.status === 403 ? ' (integrity: ' + (ClientIntegrityHeader ? 'present' : 'missing') + ')' : '') + errorBody);
                                streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                            }
                        } catch (err) {
                            console.log('[ReYohoho VAFT] Access token failed for ' + realPlayerType + ': ' + err.message);
                            streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
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
                                                console.log('[ReYohoho VAFT] Cycle switched to different clean type (' + playerType + ', was ' + prevType + ') during freeze — recovered without reload');
                                                streamInfo.CycleRescuedThisBreak = true;
                                            } else {
                                                console.log('[ReYohoho VAFT] Same backup type (' + playerType + ') became clean during freeze — natural recovery');
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
                                            console.log('[ReYohoho VAFT] Backup stream (' + playerType + ') also has ads');
                                        }
                                    }
                                    if (isFullyCachedPlayerType || isDoingMinimalRequests) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                    if (hasAdTags(m3u8Text) && playerTypeIndex >= playerTypesToTry.length - 1) {
                                        console.log('[ReYohoho VAFT] All backup player types ad-laden — taking ' + playerType + ' as last-resort fallback (strip+recovery path will engage)');
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                }
                            } else {
                                console.log('[ReYohoho VAFT] Backup stream fetch failed for ' + playerType + ' (status ' + streamM3u8Response.status + ')');
                            }
                        } catch (err) {
                            console.log('[ReYohoho VAFT] Backup stream error for ' + playerType + ': ' + err.message);
                        }
                    }
                    streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
                    if (isFreshM3u8) {
                        break;
                    }
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                if (streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.has(FallbackPlayerType)) {
                    console.log('[ReYohoho VAFT] Skipping fallback to ' + FallbackPlayerType + ' — marked contaminated this break (' + [...streamInfo.LoggedBackupAdsByType].join(', ') + ' all ad-laden)');
                } else {
                    backupPlayerType = FallbackPlayerType;
                    backupM3u8 = fallbackM3u8;
                }
            }
            if (backupM3u8 && streamInfo.IsShowingAd) {
                textStr = backupM3u8;
                streamInfo.LastCommittedBackupPlayerType = backupPlayerType;
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    const sourceQualityTypes = ['embed', 'site', 'popout'];
                    if ((PinBackupPlayerType && backupPlayerType !== 'autoplay') || sourceQualityTypes.includes(backupPlayerType)) {
                        streamInfo.PinnedBackupPlayerType = backupPlayerType;
                    }
                    console.log(`[ReYohoho VAFT] Blocking${(streamInfo.IsMidroll ? ' midroll ' : ' ')}ads (${backupPlayerType}) — backup found in ${Date.now() - backupSearchStart}ms`);
                    if (streamInfo.EscapeHatchFired) {
                        const qualityTier = backupPlayerType === 'autoplay' ? '360p' : 'Source';
                        console.log('[ReYohoho VAFT] Post-escape backup: ' + backupPlayerType + ' (' + qualityTier + ') — recovered from sticky-path freeze');
                    } else if (backupPlayerType === 'autoplay' && PreferLowQualityBackup) {
                        const sourceTried = streamInfo.LoggedBackupAdsByType?.size || 0;
                        if (sourceTried === 0) {
                            console.log('[ReYohoho VAFT] Autoplay backup committed — 360p pinned from prior break (PreferLowQualityBackup)');
                        } else {
                            console.log('[ReYohoho VAFT] Autoplay backup committed — 360p fallback after ' + sourceTried + ' Source type(s) ad-laden (PreferLowQualityBackup)');
                        }
                        if (FastAutoplayFirstTry && sourceTried >= 4) {
                            streamInfo.LastBreakUsedEscapeHatch = true;
                        }
                    } else if (FastAutoplayFirstTry && backupPlayerType !== 'autoplay') {
                        streamInfo.LastBreakUsedEscapeHatch = false;
                    }
                }
            } else if (backupM3u8 && !streamInfo.IsShowingAd) {
                console.log('[ReYohoho VAFT] Discarded stale backup commit (' + backupPlayerType + ', ' + (Date.now() - backupSearchStart) + 'ms) — break ended during search');
            } else {
                console.log('[ReYohoho VAFT] No ad-free backup stream found — ads may leak. Tried: ' + playerTypesToTry.slice(startIndex).join(', '));
            }
            const stripHevc = isHevc && streamInfo.ModifiedM3U8;
            if (IsAdStrippingEnabled || stripHevc) {
                textStr = stripAdSegments(textStr, stripHevc, streamInfo);
            } else if (!backupM3u8) {
                console.log('[ReYohoho VAFT] Ad stripping disabled and no backup — ads WILL show');
            }
            if (streamInfo.EarlyReloadAwaitingResult) {
                streamInfo.EarlyReloadAwaitingResult = false;
                if (textStr.includes(',live') && streamInfo.IsStrippingAdSegments) {
                    console.log('[ReYohoho VAFT] Early reload result: partial — some live segments returned');
                } else if (!streamInfo.IsStrippingAdSegments) {
                    console.log('[ReYohoho VAFT] Early reload result: clean — freeze ended');
                    streamInfo.EarlyReloadTriggered = false;
                } else {
                    console.log('[ReYohoho VAFT] Early reload result: still ads — continuing recovery loop');
                    streamInfo.EarlyReloadTriggered = false;
                }
            }
            const recoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
            const maxEarlyReloads = recoveryThin ? Math.max(2, streamInfo.PodLength || 1) : Math.max(1, streamInfo.PodLength || 1);
            const effectiveThreshold = recoveryThin ? 1 : EarlyReloadPollThreshold;
            if (EarlyReloadPollThreshold > 0 && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= effectiveThreshold && !streamInfo.EarlyReloadTriggered && (streamInfo.EarlyReloadCount || 0) < maxEarlyReloads) {
                streamInfo.EarlyReloadTriggered = true;
                streamInfo.EarlyReloadAwaitingResult = true;
                streamInfo.EarlyReloadCount = (streamInfo.EarlyReloadCount || 0) + 1;
                streamInfo.EarlyReloadAtPoll = streamInfo.TotalAllStrippedPolls || streamInfo.ConsecutiveAllStrippedPolls;
                const reason = recoveryThin ? ' (thin recovery cache: ' + (streamInfo.RecoverySegments?.length || 0) + ' segments)' : '';
                console.log('[ReYohoho VAFT] Early reload triggered — ' + streamInfo.ConsecutiveAllStrippedPolls + ' consecutive all-stripped polls' + reason + ' [' + streamInfo.EarlyReloadCount + '/' + maxEarlyReloads + ']');
                postMessage({ key: 'ReloadPlayer', kind: 'early' });
            }
        } else if (streamInfo.IsShowingAd) {
            if (!streamInfo.PendingAdEndAt) {
                streamInfo.PendingAdEndAt = Date.now();
            }
            streamInfo.CleanPlaylistCount++;
            const hasLiveSegments = textStr.includes(',live');
            const adEndMaxWaitMs = 12000;
            const elapsedSinceCandidate = Date.now() - streamInfo.PendingAdEndAt;
            const slowPathReady = streamInfo.PendingAdEndAt > 0 && elapsedSinceCandidate >= adEndMaxWaitMs;
            if (streamInfo.CleanPlaylistCount >= 3 || !hasLiveSegments || slowPathReady) {
                if (slowPathReady && streamInfo.CleanPlaylistCount < 3) {
                    console.log('[ReYohoho VAFT] Slow-path ad-end escalation — ' + (streamInfo.AdEndBounceCount || 0) + ' marker bounces, ' + (elapsedSinceCandidate / 1000).toFixed(1) + 's since first clean poll');
                }
                if (!hasLiveSegments) {
                    console.log('[ReYohoho VAFT] Backup stream has no live segments — forcing immediate reload');
                }
                const adBreakDurationSec = streamInfo.AdBreakStartedAt ? ((Date.now() - streamInfo.AdBreakStartedAt) / 1000).toFixed(1) : '?';
                console.log('[ReYohoho VAFT] Finished blocking ads — stripped ' + streamInfo.NumStrippedAdSegments + ' ad segments, duration: ' + adBreakDurationSec + 's');
                if (streamInfo.TotalAllStrippedPolls > 0) {
                    const reloadInfo = streamInfo.EarlyReloadAtPoll ? ', early reload at poll ' + streamInfo.EarlyReloadAtPoll : '';
                    const wallClockFreeze = streamInfo.FreezeStartedAt ? ((Date.now() - streamInfo.FreezeStartedAt) / 1000).toFixed(1) + 's wall-clock' : 'unknown';
                    console.log('[ReYohoho VAFT] Ad break stats: ' + streamInfo.TotalAllStrippedPolls + ' all-stripped polls, freeze duration: ' + wallClockFreeze + reloadInfo);
                }
                const hadStrippedSegments = streamInfo.NumStrippedAdSegments > 0;
                if (!hadStrippedSegments && !streamInfo.HasConfirmedAdAttrs) {
                    streamInfo.ConsecutiveZeroStripBreaks++;
                    if (streamInfo.ConsecutiveZeroStripBreaks >= 3) {
                        console.log('[ReYohoho VAFT] Warning: ' + streamInfo.ConsecutiveZeroStripBreaks + ' consecutive unconfirmed ad breaks with 0 segments stripped — possible false positive from ad signifiers');
                    }
                } else if (hadStrippedSegments || streamInfo.HasConfirmedAdAttrs) {
                    streamInfo.ConsecutiveZeroStripBreaks = 0;
                }
                streamInfo.IsShowingAd = false;
                streamInfo.IsStrippingAdSegments = false;
                streamInfo.NumStrippedAdSegments = 0;
                streamInfo.ActiveBackupPlayerType = null;
                streamInfo.RequestedAds?.clear?.();
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
                if (!hadStrippedSegments) {
                    console.log('[ReYohoho VAFT] CSAI-only ad break (stripped 0) — clearing backup without player action');
                    streamInfo.IsUsingModifiedM3U8 = false;
                    if (streamInfo.LastCommittedBackupPlayerType) {
                        const isAutoplay = streamInfo.LastCommittedBackupPlayerType === 'autoplay';
                        const reason = isAutoplay ? 'autoplay (360p) — restoring Source quality' : streamInfo.LastCommittedBackupPlayerType + ' — flushing MediaSource to prevent A/V desync accumulation';
                        console.log('[ReYohoho VAFT] Post-escape reload: ' + reason);
                        streamInfo.LastPlayerReload = Date.now();
                        if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
                        streamInfo.ReloadTimestamps.push(Date.now());
                        postMessage({ key: 'ReloadPlayer', kind: 'early' });
                    }
                } else {
                    if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
                    streamInfo.ReloadTimestamps = streamInfo.ReloadTimestamps.filter(t => Date.now() - t < 300000);
                    const recentReloads = streamInfo.ReloadTimestamps.filter(t => Date.now() - t < 300000).length;
                    const effectiveCooldown = recentReloads >= 3 ? ReloadCooldownSeconds * 3 : ReloadCooldownSeconds;
                    const tooSoonSinceLastReload = streamInfo.LastPlayerReload && (Date.now() - streamInfo.LastPlayerReload) < (effectiveCooldown * 1000);
                    const cycleRescuedCleanly = streamInfo.CycleRescuedThisBreak &&
                        (streamInfo.TotalAllStrippedPolls || 0) <= 2 &&
                        (streamInfo.EarlyReloadCount || 0) === 0;
                    if (cycleRescuedCleanly) {
                        console.log('[ReYohoho VAFT] Cycle rescue handled the break cleanly — skipping end-of-break reload');
                    }
                    const shouldReload = streamInfo.IsUsingModifiedM3U8 || (ReloadPlayerAfterAd && hadStrippedSegments && !cycleRescuedCleanly);
                    if (shouldReload) {
                        streamInfo.ReloadTimestamps.push(Date.now());
                        streamInfo.IsUsingModifiedM3U8 = false;
                        streamInfo.LastPlayerReload = Date.now();
                        postMessage({ key: 'ReloadPlayer', kind: 'early' });
                    } else {
                        if (tooSoonSinceLastReload) {
                            console.log('[ReYohoho VAFT] Skipping reload — last reload was ' + ((Date.now() - streamInfo.LastPlayerReload) / 1000).toFixed(0) + 's ago (cooldown: ' + effectiveCooldown + 's' + (recentReloads >= 3 ? ', auto-escalated from ' + recentReloads + ' reloads in 5min' : '') + ')');
                        }
                        postMessage({ key: 'PauseResumePlayer' });
                    }
                }
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
        if (str.charCodeAt(0) === 35) {
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
            const timeoutId = setTimeout(() => {
                if (pendingFetchRequests.has(requestId)) {
                    pendingFetchRequests.delete(requestId);
                    reject(new Error('FetchRequest timed out'));
                }
            }, 15000);
            pendingFetchRequests.set(requestId, { resolve, reject, timeoutId });
            postMessage({ key: 'FetchRequest', value: fetchRequest });
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
        console.log('[ReYohoho VAFT] Drift correction: catching up at ' + DriftCorrectionRate + 'x');
        driftCatchUpInterval = setInterval(() => {
            try {
                const vid = document.querySelector('video');
                if (vid && vid.buffered.length > 0) {
                    if (vid.buffered.end(vid.buffered.length - 1) - vid.currentTime <= 1) {
                        vid.playbackRate = 1.0;
                        console.log('[ReYohoho VAFT] Drift correction complete — resumed normal playback speed');
                        clearInterval(driftCatchUpInterval); driftCatchUpInterval = null;
                        if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
                    }
                }
            } catch { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
        }, 500);
        driftCatchUpTimeout = setTimeout(() => {
            try { videoElement.playbackRate = 1.0; } catch { }
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
        inAdBreak: false
    };
    function monitorPlayerBuffering() {
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
                    const videoEl = player.getHTMLVideoElement?.();
                    const videoCurrentTime = videoEl?.currentTime;
                    if (position !== undefined && bufferedPosition !== undefined) {
                        const playerNotActivelyPlaying = videoEl && (videoEl.readyState < 2 || videoEl.paused);
                        if (videoEl && playerBufferState.videoElement && playerBufferState.videoElement !== videoEl) {
                            playerBufferState.numSame = 0;
                            playerBufferState.fixAttempts = 0;
                            playerBufferState.recoveryReloadUsed = false;
                        }
                        playerBufferState.videoElement = videoEl;
                        const positionFrozen = (playerBufferState.position == position) &&
                            (playerBufferState.videoCurrentTime === undefined || playerBufferState.videoCurrentTime === videoCurrentTime);
                        if (playerNotActivelyPlaying) {
                            // hold counters
                        } else if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            (positionFrozen && bufferDuration < PlayerBufferingDangerZone) &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                playerBufferState.fixAttempts++;
                                const wouldEscalate = playerBufferState.fixAttempts >= 3;
                                const escalateToReload = wouldEscalate && (DisableReloadCap || !playerBufferState.recoveryReloadUsed);
                                const reloadCapNote = wouldEscalate && !escalateToReload ? ' (reload cap reached, pause/play only)' : (escalateToReload ? ' (escalating to reload)' : '');
                                console.log('[ReYohoho VAFT] Attempt to fix buffering position:' + playerBufferState.position + ' bufferedPosition:' + playerBufferState.bufferedPosition + ' bufferDuration:' + playerBufferState.bufferDuration + reloadCapNote);
                                const video = player.getHTMLVideoElement?.();
                                if (video && video.buffered.length > 1) {
                                    for (let bi = 0; bi < video.buffered.length; bi++) {
                                        if (video.buffered.start(bi) > video.currentTime + 0.5) {
                                            console.log('[ReYohoho VAFT] Seeking past ' + (video.buffered.start(bi) - video.currentTime).toFixed(1) + 's buffer gap');
                                            video.currentTime = video.buffered.start(bi);
                                            startDriftCorrection(video);
                                            break;
                                        }
                                    }
                                }
                                if (video) {
                                    console.log('[ReYohoho VAFT] Video state: readyState=' + video.readyState + ' networkState=' + video.networkState + ' buffered=' + (video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1).toFixed(1) : 0) + ' currentTime=' + video.currentTime.toFixed(1) + ' paused=' + video.paused);
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
                        if (playerBufferState.position > 0 && position - playerBufferState.position > 5 && !playerBufferState.inAdBreak && (!playerBufferState.lastBackupSwitchAt || Date.now() - playerBufferState.lastBackupSwitchAt >= 10000) && (!playerBufferState.lastDriftStartedAt || Date.now() - playerBufferState.lastDriftStartedAt >= 30000)) {
                            console.log('[ReYohoho VAFT] Position jumped ' + (position - playerBufferState.position).toFixed(1) + 's — starting drift correction');
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
                console.error('[ReYohoho VAFT] error when monitoring player for buffering: ' + err);
                playerForMonitoringBuffering = null;
            }
        }
        // Loading-circle health check during ad strip+recovery
        if (isActivelyStrippingAds && playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const video = player?.getHTMLVideoElement?.();
                if (video && !video.ended && !playerBufferState.userPauseIntent) {
                    if (video.readyState >= 3) {
                        playerBufferState.hasHadData = true;
                    }
                    const isStalled = video.readyState < 3 && (video.paused || video.networkState === 2);
                    const stallReloadCooldown = 15000;
                    const cooldownExpired = !playerBufferState.lastAdStallReloadAt || (Date.now() - playerBufferState.lastAdStallReloadAt) > stallReloadCooldown;
                    const recentReload = playerBufferState.lastReloadAt && (Date.now() - playerBufferState.lastReloadAt) < stallReloadCooldown;
                    if (isStalled && cooldownExpired && !recentReload && playerBufferState.hasHadData) {
                        if (!playerBufferState.adStallStartAt) {
                            playerBufferState.adStallStartAt = Date.now();
                        } else if ((Date.now() - playerBufferState.adStallStartAt) > 3000) {
                            console.log('[ReYohoho VAFT] Loading circle detected during ad break (' + ((Date.now() - playerBufferState.adStallStartAt) / 1000).toFixed(1) + 's stall, readyState=' + video.readyState + ') — early reload');
                            playerBufferState.lastAdStallReloadAt = Date.now();
                            playerBufferState.adStallStartAt = 0;
                            doTwitchPlayerTask(false, true, 'early');
                        }
                    } else if (!isStalled) {
                        playerBufferState.adStallStartAt = 0;
                    }
                }
            } catch { }
        } else if (!isActivelyStrippingAds && playerBufferState.adStallStartAt) {
            playerBufferState.adStallStartAt = 0;
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({ hasAds: false });
        }
        playerBufferState.isLive = isLive;
        if (typeof document !== 'undefined' && !monitorPlayerBuffering.visibilityHooked) {
            monitorPlayerBuffering.visibilityHooked = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && !monitorPlayerBuffering.pendingTick) {
                    monitorPlayerBuffering.pendingTick = true;
                    setTimeout(() => { monitorPlayerBuffering.pendingTick = false; monitorPlayerBuffering(); }, 100);
                }
            });
        }
        try { hideTwitchAdOverlays(); } catch { }
        const shouldThrottle = typeof document !== 'undefined' && document.hidden && !document.pictureInPictureElement;
        const nextDelay = shouldThrottle ? PlayerBufferingDelay * 3 : PlayerBufferingDelay;
        setTimeout(monitorPlayerBuffering, nextDelay);
    }
    function hideTwitchAdOverlays() {
        if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) return;
        const sdaElements = document.querySelectorAll('[data-test-selector="sda-wrapper"]');
        for (let i = 0; i < sdaElements.length; i++) {
            if (!sdaElements[i].dataset.tasHidden) {
                sdaElements[i].dataset.tasHidden = '';
                sdaElements[i].style.setProperty('display', 'none', 'important');
                if (!loggedSdaHide) {
                    loggedSdaHide = true;
                    console.log('[ReYohoho VAFT] Hidden Twitch stream display ad');
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
            let adBlockDiv = playerRootDiv.querySelector('.tas-adblock-overlay');
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
                adBlockDiv.P.textContent = 'ReYohoho Proxy: Блокировка' + (data.isMidroll ? ' midroll' : '') + ' рекламы' + (data.isStrippingAdSegments ? ' (stripping)' : '') + (data.activeBackupPlayerType ? ' (' + data.activeBackupPlayerType + ')' : '');
                adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            }
            if (data.hasAds) {
                hideTwitchAdOverlays();
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
        if (!reactRootNode) return null;
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        if (!player) {
            player = findReactNode(reactRootNode, node => node.getHTMLVideoElement && node.getBufferDuration && node.core?.state);
        }
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        const playerStateFallback = !playerState ? findReactNode(reactRootNode, node => node.setSrc && node.setStreamManagerNode && !node.getHTMLVideoElement) : null;
        const playerStateFallback2 = !playerState && !playerStateFallback ? findReactNode(reactRootNode, node => node.state?.videoPlayerInstance?.playerMode !== undefined)?.state?.videoPlayerInstance : null;
        const finalPlayerState = playerState || playerStateFallback || playerStateFallback2;
        if (!player) {
            if (!getPlayerAndState.firstPlayerNullAt) getPlayerAndState.firstPlayerNullAt = Date.now();
            if (!getPlayerAndState.loggedNoPlayer && (Date.now() - getPlayerAndState.firstPlayerNullAt) > 10000) {
                getPlayerAndState.loggedNoPlayer = true;
                console.log('[ReYohoho VAFT] Player not found for 10s+ — Twitch may have renamed setPlayerActive/mediaPlayerInstance');
            }
        } else {
            getPlayerAndState.firstPlayerNullAt = 0;
        }
        if (!finalPlayerState) {
            if (!getPlayerAndState.firstStateNullAt) getPlayerAndState.firstStateNullAt = Date.now();
            if (!getPlayerAndState.loggedNoState && (Date.now() - getPlayerAndState.firstStateNullAt) > 10000) {
                getPlayerAndState.loggedNoState = true;
                console.log('[ReYohoho VAFT] Player state not found for 10s+ — Twitch may have renamed setSrc/setInitialPlaybackSettings');
            }
        } else {
            getPlayerAndState.firstStateNullAt = 0;
        }
        return { player: player, state: finalPlayerState };
    }
    function doTwitchPlayerTask(isPausePlay, isReload, reloadKind) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('[ReYohoho VAFT] Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('[ReYohoho VAFT] Could not find player');
            return;
        }
        if (!playerState) {
            console.log('[ReYohoho VAFT] Could not find player state');
            return;
        }
        const wasPaused = player.isPaused() || player.core?.paused;
        if (wasPaused) {
            if (playerBufferState.userPauseIntent) {
                if (!playerBufferState.loggedPauseIntent) {
                    playerBufferState.loggedPauseIntent = true;
                    console.log('[ReYohoho VAFT] Respecting user pause intent — skipping auto-resume');
                }
                return;
            }
            if (playerBufferState.weJustPaused && (Date.now() - playerBufferState.weJustPaused) < 10000) {
                try { player.play()?.catch?.(() => { }); } catch { }
            }
            return;
        }
        if (!wasPaused) {
            playerBufferState.weJustPaused = 0;
        }
        // Snapshot audio state for restoration after disruptive operations.
        const audioState = rememberCurrentAudioState(player);
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play()?.catch?.(() => { });
            playerBufferState.weJustPaused = Date.now();
            return;
        }
        if (isReload && document.pictureInPictureElement) {
            player.pause();
            player.play()?.catch?.(() => { });
            console.log('[ReYohoho VAFT] Downgraded reload to pause/play to preserve PiP');
            return;
        }
        if (isReload) {
            const video = player.getHTMLVideoElement?.();
            if (video && video.readyState >= 3 && !video.paused && !video.ended) {
                let latencySec = 0;
                let latencyKnown = false;
                try {
                    if (video.seekable && video.seekable.length > 0) {
                        const seekableEnd = video.seekable.end(video.seekable.length - 1);
                        if (Number.isFinite(seekableEnd)) {
                            const calc = Math.max(0, seekableEnd - video.currentTime);
                            if (calc < 3600) {
                                latencySec = calc;
                                latencyKnown = true;
                            }
                        }
                    }
                } catch (e) { }
                if (!latencyKnown) {
                    console.log('[ReYohoho VAFT] Latency unknown (seekable unavailable) — proceeding with reload');
                } else if (latencySec > 7) {
                    console.log('[ReYohoho VAFT] Player playing but ' + latencySec.toFixed(1) + 's behind live — proceeding with reload to reset latency');
                } else {
                    console.log('[ReYohoho VAFT] Skipping reload — player healthy (readyState=' + video.readyState + ', playing, latency=' + latencySec.toFixed(1) + 's)');
                    return;
                }
            }
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            const lsKeyLowLatency = 'lowLatencyModeEnabled';
            const lsKeyPersistence = 'persistenceEnabled';
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
                if (localStorageHookFailed && audioState) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({ default: audioState.muted }));
                    localStorage.setItem(lsKeyVolume, audioState.volume);
                }
                if (localStorageHookFailed && player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({ default: player.core.state.quality.group }));
                }
            } catch { }
            playerBufferState.lastReloadAt = Date.now();
            playerBufferState.adStallStartAt = 0;
            playerBufferState.userPauseIntent = false;
            playerBufferState.loggedPauseIntent = false;
            const hardReload = reloadKind === 'early';
            console.log('[ReYohoho VAFT] Reloading Twitch player' + (hardReload ? ' (hard)' : ' (soft)'));
            if (hardReload) {
                try {
                    const v = document.querySelector('video');
                    if (v && !v.muted) {
                        v.muted = true;
                        const restore = () => { try { document.querySelector('video').muted = false; } catch { } };
                        v.addEventListener('canplay', restore, { once: true });
                        setTimeout(restore, 1500);
                    }
                } catch { }
            }
            playerState.setSrc({ isNewMediaPlayerInstance: hardReload, refreshAccessToken: hardReload });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            player.play()?.catch?.(() => { });
            // Polling-based audio restore — handles cases where the canplay-restore above misses
            scheduleAudioStateRestore(audioState);
            {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) localStorage.setItem(lsKeyQuality, currentQualityLS);
                        if (currentMutedLS) localStorage.setItem(lsKeyMuted, currentMutedLS);
                        if (currentVolumeLS) localStorage.setItem(lsKeyVolume, currentVolumeLS);
                        if (currentLowLatencyLS !== null) localStorage.setItem(lsKeyLowLatency, currentLowLatencyLS);
                        if (currentPersistenceLS !== null) localStorage.setItem(lsKeyPersistence, currentPersistenceLS);
                        const videos = document.getElementsByTagName('video');
                        const userIntendedMute = currentMutedLS && currentMutedLS.includes('"default":true');
                        if (videos.length > 0 && videos[0].muted && !userIntendedMute) {
                            videos[0].muted = false;
                        }
                        if (videos.length > 0 && videos[0].buffered.length > 0 && videos[0].readyState >= 3) {
                            const liveEdge = videos[0].buffered.end(videos[0].buffered.length - 1);
                            const drift = liveEdge - videos[0].currentTime;
                            if (hardReload && drift > 5 && Number.isFinite(liveEdge) && liveEdge < 3600) {
                                console.log('[ReYohoho VAFT] Post-hard-reload seek to live — ' + drift.toFixed(1) + 's behind, jumping to live edge to flush A/V drift');
                                videos[0].currentTime = liveEdge;
                            } else if (drift > 2) {
                                console.log('[ReYohoho VAFT] Post-reload live drift correction: ' + drift.toFixed(1) + 's behind');
                                startDriftCorrection(videos[0]);
                            }
                        }
                    } catch { }
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
                ok: response.ok,
                redirected: response.redirected,
                type: response.type,
                url: response.url,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
        } catch (error) {
            return { id: fetchRequest.id, error: error.message };
        }
    }
    // Universal header reader — Twitch passes init.headers as either a plain
    // object OR a Headers instance, depending on which internal code path is
    // making the request. Bracket-notation only works for plain objects, so
    // older code missed Client-Integrity (and other tokens) on every request
    // that used a Headers instance — leading to ad-laden backup tokens on
    // SSAI-uniform channels. This helper handles both representations plus
    // case-insensitive lookup.
    function getHeaderValue(headers, name) {
        if (!headers) return undefined;
        if (typeof headers.get === 'function') {
            try {
                const v = headers.get(name);
                if (typeof v === 'string') return v;
            } catch (e) { /* not a real Headers instance */ }
        }
        if (typeof headers === 'object') {
            if (typeof headers[name] === 'string') return headers[name];
            const lower = name.toLowerCase();
            for (const k of Object.keys(headers)) {
                if (k.toLowerCase() === lower && typeof headers[k] === 'string') {
                    return headers[k];
                }
            }
        }
        return undefined;
    }

    function hookFetch() {
        console.log('[ReYohoho VAFT] Window fetch hook installed');
        let hasLoggedHeaders = false;
        let hasLoggedIntegrityLate = false;
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = maskAsNative(function (url, init, ...args) {
            // Normalise inputs: window.fetch can be called with either
            // (urlString, init) or (Request) — handle both so we don't miss
            // GQL/PlaybackAccessToken requests that Twitch issues via
            // `new Request(...)` (common in Apollo's HTTP link).
            let requestUrl = null;
            let requestHeaders = null;
            if (typeof url === 'string') {
                requestUrl = url;
                requestHeaders = init?.headers;
            } else if (url && typeof url === 'object') {
                if (typeof url.url === 'string') requestUrl = url.url;
                requestHeaders = init?.headers || url.headers;
            }
            if (typeof requestUrl === 'string') {
                if (requestUrl.includes('gql')) {
                    let deviceId = getHeaderValue(requestHeaders, 'X-Device-Id');
                    if (typeof deviceId !== 'string') {
                        deviceId = getHeaderValue(requestHeaders, 'Device-ID');
                    }
                    if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                        GQLDeviceID = deviceId;
                        postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                    }
                    const cv = getHeaderValue(requestHeaders, 'Client-Version');
                    if (typeof cv === 'string' && cv !== ClientVersion) {
                        postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = cv);
                    }
                    const cs = getHeaderValue(requestHeaders, 'Client-Session-Id');
                    if (typeof cs === 'string' && cs !== ClientSession) {
                        postTwitchWorkerMessage('UpdateClientSession', ClientSession = cs);
                    }
                    const ci = getHeaderValue(requestHeaders, 'Client-Integrity');
                    if (typeof ci === 'string' && ci !== ClientIntegrityHeader) {
                        const wasEmpty = !ClientIntegrityHeader;
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = ci);
                        if (wasEmpty && hasLoggedHeaders && !hasLoggedIntegrityLate) {
                            hasLoggedIntegrityLate = true;
                            console.log('[ReYohoho VAFT] Client-Integrity captured (after initial GQL handshake)');
                        }
                    }
                    const auth = getHeaderValue(requestHeaders, 'Authorization');
                    if (typeof auth === 'string' && auth !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = auth);
                    }
                    if (!hasLoggedHeaders && GQLDeviceID && AuthorizationHeader) {
                        hasLoggedHeaders = true;
                        console.log('[ReYohoho VAFT] GQL headers captured — DeviceId: ' + (GQLDeviceID ? 'yes' : 'no') + ', Auth: ' + (AuthorizationHeader ? 'yes' : 'no') + ', Integrity: ' + (ClientIntegrityHeader ? 'yes' : 'no'));
                    }
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
                if (requestUrl.includes('edge.ads.twitch.tv')) {
                    const csaiType = requestUrl.includes('bp=midroll') ? 'midroll' : requestUrl.includes('bp=preroll') ? 'preroll' : 'unknown';
                    if (!loggedCsaiTypes.has(csaiType)) {
                        loggedCsaiTypes.add(csaiType);
                        console.log('[ReYohoho VAFT] CSAI ad request detected — type: ' + csaiType + ' (client-side ad insertion, not blockable via m3u8)');
                    }
                }
            }
            return realFetch.apply(this, arguments);
        }, 'fetch');
    }
    function onContentLoaded() {
        if (document.getElementById('seventv-extension')) {
            console.log('[ReYohoho VAFT] Warning: 7TV extension detected — may cause black screen or buffering issues. If you experience problems, try disabling 7TV.');
        }
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
                videos[0].play()?.catch?.(() => { });
            }
        };
        document.addEventListener('visibilitychange', visibilityChange);
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',
                'persistenceEnabled'
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = maskAsNative(function (key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            }, 'setItem');
            const realGetItem = localStorage.getItem;
            localStorage.getItem = maskAsNative(function (key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            }, 'getItem');
            if (localStorage.getItem === realGetItem) {
                localStorageHookFailed = true;
            }
            // Audio volumechange listener — keeps lastKnownAudioState fresh
            document.addEventListener('volumechange', (event) => {
                if (event.target instanceof HTMLVideoElement) {
                    rememberCurrentAudioState();
                }
            }, true);
        } catch (err) {
            console.log('[ReYohoho VAFT] localStorageHooks failed ' + err);
            localStorageHookFailed = true;
        }
    }
    declareOptions(window);
    // localStorage runtime overrides (sync'd with TwitchAdSolutions opt-in keys)
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
            console.log('[ReYohoho VAFT] PreferLowQualityBackup disabled via localStorage');
        }
        const lsFastAutoplay = localStorage.getItem('twitchAdSolutions_fastAutoplayFirstTry');
        if (lsFastAutoplay === 'true') {
            FastAutoplayFirstTry = true;
            console.log('[ReYohoho VAFT] FastAutoplayFirstTry enabled via localStorage');
        }
        const lsBackupSwapFirst = localStorage.getItem('twitchAdSolutions_backupSwapFirst');
        if (lsBackupSwapFirst === 'false') {
            BackupSwapFirst = false;
            console.log('[ReYohoho VAFT] BackupSwapFirst disabled via localStorage');
        }
        const lsHideAdOverlay = localStorage.getItem('twitchAdSolutions_hideAdOverlay');
        if (lsHideAdOverlay === 'true') {
            const style = document.createElement('style');
            style.textContent = '.tas-adblock-overlay { display: none !important; }';
            (document.head || document.documentElement).appendChild(style);
        }
    } catch { }
    console.log('[ReYohoho VAFT] Config: ReloadPlayerAfterAd=' + ReloadPlayerAfterAd + ', ForceAccessTokenPlayerType=' + ForceAccessTokenPlayerType + ', PinBackupPlayerType=' + PinBackupPlayerType + ', BackupSwapFirst=' + BackupSwapFirst + ', PreferLowQualityBackup=' + PreferLowQualityBackup);
    hookWindowWorker();
    hookFetch();
    // Hook XHR to detect CSAI ad requests that bypass fetch
    const realXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = maskAsNative(function (method, url) {
        if (typeof url === 'string' && url.includes('edge.ads.twitch.tv')) {
            const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
            const xhrKey = csaiType + '-xhr';
            if (!loggedCsaiTypes.has(xhrKey)) {
                loggedCsaiTypes.add(xhrKey);
                console.log('[ReYohoho VAFT] CSAI ad request (XHR) detected — type: ' + csaiType);
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
        window.addEventListener("DOMContentLoaded", function () {
            onContentLoaded();
        });
    }

    // ReYohoho test helpers — exposed for the UI panel button + CustomEvent bridge.
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('[ReYohoho VAFT] Ad depth required (0 = stop, 1+ = use backup player for given depth)');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
    // Wrapper that auto-stops simulation after 30s — used by the ReYohoho UI test button
    window.simulateVaftAds = (depth = 3) => {
        console.log('[ReYohoho VAFT] Simulating ads with depth:', depth);
        postTwitchWorkerMessage('SimulateAds', depth);
        setTimeout(() => {
            console.log('[ReYohoho VAFT] Stopping ad simulation');
            postTwitchWorkerMessage('SimulateAds', 0);
        }, 30000);
    };
    window.stopVaftSimulation = () => {
        console.log('[ReYohoho VAFT] Stopping ad simulation');
        postTwitchWorkerMessage('SimulateAds', 0);
    };
    // CustomEvent bridge — UI panel runs in the content-script world (CSP-restricted on
    // Chromium MV3), so it can't call window.simulateVaftAds directly. The UI panel
    // dispatches these events on window; the listeners run in the page world where VAFT lives.
    window.addEventListener('reyohoho-vaft-simulate', (e) => {
        const depth = e.detail?.depth || 3;
        window.simulateVaftAds(depth);
    });
    window.addEventListener('reyohoho-vaft-stop', () => {
        window.stopVaftSimulation();
    });

    console.log('[ReYohoho VAFT] Initialized successfully');
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initVAFT };
}
