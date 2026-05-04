// ============================================
// ReYohoho Twitch Proxy - Content Script
// ============================================

// @build-include core/constants.js
// @build-include core/ui-panel.js

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

    // Inject VAFT into page context
    function injectVAFT() {
        if (vaftInitialized) return;
        
        try {
            const script = document.createElement('script');
            
            // Chromium: use external file due to CSP restrictions
            // Firefox/Userscript: use inline script
            // @build-vaft-injection
            
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
            const result = await storageAdapter.get(['extensionEnabled', 'vaftEnabled', 'ircProxyEnabled']);
            
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

            // Last known availability (refreshed by checkIrcProxyAvailability)
            ircProxyAvailable = isIrcProxyAvailableSync();
            
            console.log(`[ReYohoho] Loaded settings: enabled=${extensionEnabled}, vaft=${vaftEnabled}, ircProxy=${ircProxyEnabled} (available=${ircProxyAvailable})`);
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
        onIrcProxyToggle: saveIrcProxyEnabled
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
        startObserver(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxyState());
        
        // Periodic check
        setInterval(() => {
            tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxyState());
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
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
        });
        setInterval(async () => {
            await checkIrcProxyAvailability();
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
        }, ircInterval);
    }

    // Listen for storage changes (extensions)
    if (isExtension && api && api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local') {
                if (changes.extensionEnabled) {
                    extensionEnabled = changes.extensionEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
                }
                if (changes.vaftEnabled) {
                    vaftEnabled = changes.vaftEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
                }
                if (changes.ircProxyEnabled) {
                    ircProxyEnabled = changes.ircProxyEnabled.newValue;
                    saveIrcProxyEnabledToLocalStorage(ircProxyEnabled);
                    // Mirror the local toggle path so other tabs also drop
                    // their active IRC sockets and reconnect via the new
                    // route without requiring a manual reload.
                    dispatchIrcProxyDrop(ircProxyEnabled ? 'toggle-on-sync' : 'toggle-off-sync');
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState());
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
