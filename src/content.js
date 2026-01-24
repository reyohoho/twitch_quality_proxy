// ============================================
// ReYohoho Twitch Proxy - Content Script
// ============================================

// @build-include core/constants.js
// @build-include core/ui-panel.js

(function() {
    'use strict';

    // Detect environment
    const isUserscript = typeof window.__REYOHOHO_USERSCRIPT__ !== 'undefined';
    const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
    const api = (typeof browser !== 'undefined' ? browser : chrome) || null;

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
            const result = await storageAdapter.get(['extensionEnabled', 'vaftEnabled']);
            
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
            
            console.log(`[ReYohoho] Loaded settings: enabled=${extensionEnabled}, vaft=${vaftEnabled}`);
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

    // UI Callbacks
    const callbacks = {
        onExtensionToggle: saveExtensionEnabled,
        onVaftToggle: saveVaftEnabled
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


    // Initialize UI injection
    function initUI() {
        // Start observer for settings menu
        startObserver(extensionEnabled, vaftEnabled, proxyStatus, callbacks);
        
        // Periodic check
        setInterval(() => {
            tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks);
        }, 500);
        
        // Periodic status update
        setInterval(async () => {
            await fetchProxyStatus();
            updateProxyStatusInPanels(proxyStatus);
        }, 5000);
    }

    // Listen for storage changes (extensions)
    if (isExtension && api && api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local') {
                if (changes.extensionEnabled) {
                    extensionEnabled = changes.extensionEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus);
                }
                if (changes.vaftEnabled) {
                    vaftEnabled = changes.vaftEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus);
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
