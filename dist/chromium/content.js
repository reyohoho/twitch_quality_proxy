// ============================================
// ReYohoho Twitch Proxy - Content Script
// ============================================

// ============================================
// ReYohoho Twitch Proxy - Constants
// ============================================

const VERSION = '2.4.1';

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

function createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly) {
    const { onExtensionToggle, onVaftToggle, onIrcProxyToggle, onHideAudioOnlyToggle } = callbacks;
    const irc = getIrcProxyDisplay(extensionEnabled, ircProxy);
    const hideAudioOnlyEnabled = hideAudioOnly === true;
    
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
        <span class="reyohoho-section-title">Скрыть Audio Only</span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-audio-only-toggle" ${hideAudioOnlyEnabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
      <span class="reyohoho-section-desc">Удалять audio_only вариант из плейлиста</span>
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

    // Audio Only hide toggle handler
    const audioOnlyToggle = panel.querySelector('#reyohoho-audio-only-toggle');
    if (audioOnlyToggle) {
        audioOnlyToggle.addEventListener('change', (e) => {
            e.stopPropagation();
            if (onHideAudioOnlyToggle) onHideAudioOnlyToggle(e.target.checked);
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

function updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxy, hideAudioOnly) {
    const irc = getIrcProxyDisplay(extensionEnabled, ircProxy);
    const hideAudioOnlyEnabled = hideAudioOnly === true;

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
        const audioOnlyToggle = panel.querySelector('#reyohoho-audio-only-toggle');
        if (audioOnlyToggle) {
            audioOnlyToggle.checked = hideAudioOnlyEnabled;
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

function injectIntoElement(container, extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly) {
    if (!container || container.querySelector('.reyohoho-proxy-settings')) {
        return false;
    }

    const panel = createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly);
    container.insertBefore(panel, container.firstChild);
    return true;
}

function tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly) {
    const settingsMenu = document.querySelector('[data-a-target="player-settings-menu"]');

    if (settingsMenu && injectIntoElement(settingsMenu, extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly)) {
        console.log('[ReYohoho] Injected into player settings menu');
        return true;
    }

    return false;
}

function startObserver(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly) {
    const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;

        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldCheck = true;
                break;
            }
        }

        if (shouldCheck) {
            tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly);
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    return observer;
}




(function() {
    'use strict';

    // Detect environment.
    //
    // Firefox userscripts (MAIN world) expose neither `browser` nor `chrome`,
    // so we MUST `typeof`-guard both sides — referencing an undeclared
    // identifier would throw `ReferenceError` in strict mode and abort the
    // entire IIFE, which is what was breaking the userscript UI.
    const isUserscript = typeof window.__REYOHOHO_USERSCRIPT__ !== 'undefined';
    const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
    const api = (typeof browser !== 'undefined')
        ? browser
        : (typeof chrome !== 'undefined' ? chrome : null);

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
    let hideAudioOnlyEnabled = false;
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

    // Hide audio_only quality from the master playlist. Default is OFF
    // (audio_only stays visible like vanilla Twitch); user opts in via the
    // UI toggle. Only the literal string 'true' counts as enabled.
    function isHideAudioOnlyEnabledSync() {
        try {
            return localStorage.getItem('reyohoho_hide_audio_only') === 'true';
        } catch (e) {
            return false;
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

    function saveHideAudioOnlyToLocalStorage(enabled) {
        try {
            localStorage.setItem('reyohoho_hide_audio_only', enabled ? 'true' : 'false');
        } catch (e) {}
    }

    // Inject VAFT into page context
    function injectVAFT() {
        if (vaftInitialized) return;
        
        try {
            const script = document.createElement('script');
            
            // Chromium: use external file due to CSP restrictions
            // Firefox/Userscript: use inline script
            script.src = chrome.runtime.getURL('vaft.js');
            
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
            const result = await storageAdapter.get(['extensionEnabled', 'vaftEnabled', 'ircProxyEnabled', 'hideAudioOnlyEnabled']);
            
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

            if (typeof result.hideAudioOnlyEnabled === 'boolean') {
                hideAudioOnlyEnabled = result.hideAudioOnlyEnabled;
                saveHideAudioOnlyToLocalStorage(hideAudioOnlyEnabled);
            } else {
                hideAudioOnlyEnabled = isHideAudioOnlyEnabledSync();
            }

            // Last known availability (refreshed by checkIrcProxyAvailability)
            ircProxyAvailable = isIrcProxyAvailableSync();
            
            console.log(`[ReYohoho] Loaded settings: enabled=${extensionEnabled}, vaft=${vaftEnabled}, ircProxy=${ircProxyEnabled} (available=${ircProxyAvailable}), hideAudioOnly=${hideAudioOnlyEnabled}`);
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

    // Save "hide audio_only" toggle. The proxy URL passed via background
    // (DNR/webRequest) bakes in the &hide_audio_only param, and the
    // userscript reads localStorage at script-load time. In all cases the
    // active player has already cached its master playlist, so we reload
    // to make Twitch refetch with the new flag.
    async function saveHideAudioOnlyEnabled(enabled) {
        hideAudioOnlyEnabled = enabled;
        try {
            await storageAdapter.set({ hideAudioOnlyEnabled: enabled });
            saveHideAudioOnlyToLocalStorage(enabled);
            console.log(`[ReYohoho] Hide audio_only ${enabled ? 'enabled' : 'disabled'}`);
            location.reload();
        } catch (e) {
            console.error('[ReYohoho] Error saving hideAudioOnly state:', e);
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
        onIrcProxyToggle: saveIrcProxyEnabled,
        onHideAudioOnlyToggle: saveHideAudioOnlyEnabled
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
        startObserver(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxyState(), hideAudioOnlyEnabled);
        
        // Periodic check
        setInterval(() => {
            tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxyState(), hideAudioOnlyEnabled);
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
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled);
        });
        setInterval(async () => {
            await checkIrcProxyAvailability();
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled);
        }, ircInterval);
    }

    // Listen for storage changes (extensions)
    if (isExtension && api && api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local') {
                if (changes.extensionEnabled) {
                    extensionEnabled = changes.extensionEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled);
                }
                if (changes.vaftEnabled) {
                    vaftEnabled = changes.vaftEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled);
                }
                if (changes.ircProxyEnabled) {
                    ircProxyEnabled = changes.ircProxyEnabled.newValue;
                    saveIrcProxyEnabledToLocalStorage(ircProxyEnabled);
                    // Mirror the local toggle path so other tabs also drop
                    // their active IRC sockets and reconnect via the new
                    // route without requiring a manual reload.
                    dispatchIrcProxyDrop(ircProxyEnabled ? 'toggle-on-sync' : 'toggle-off-sync');
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled);
                }
                if (changes.hideAudioOnlyEnabled) {
                    hideAudioOnlyEnabled = changes.hideAudioOnlyEnabled.newValue;
                    saveHideAudioOnlyToLocalStorage(hideAudioOnlyEnabled);
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled);
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
