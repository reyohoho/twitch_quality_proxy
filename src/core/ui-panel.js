// ============================================
// ReYohoho Twitch Proxy - UI Panel
// ============================================

// @include constants.js

// Status pill text; its colored dot comes from CSS (data-status).
function getStatusText(status) {
    switch (status) {
        case 'active': return 'Активен';
        case 'ready': return 'Готов';
        case 'checking': return 'Проверка';
        case 'disabled': return 'Выключен';
        case 'unavailable': return 'Недоступен';
        case 'error': return 'Ошибка';
        default: return 'Ожидание';
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
        badgeText = 'Выключен';
    } else if (!enabled) {
        badgeStatus = 'disabled';
        badgeText = 'Выключен';
    } else if (!available) {
        badgeStatus = 'unavailable';
        badgeText = 'Напрямую';
    } else {
        badgeStatus = 'active';
        badgeText = 'Активен';
    }

    return { enabled, available, badgeStatus, badgeText };
}

// One provider health check for the picker: { status: idle|checking|ok|bad, text }.
// Quality is shown only when it was measured on the stream being watched.
function providerCheckView(check, channel) {
    if (!check) return { status: 'idle', text: '' };
    if (check.checking) return { status: 'checking', text: 'Проверка…' };
    if (!check.ok) return { status: 'bad', text: check.code ? 'Недоступен · ' + check.code : 'Нет ответа' };
    const parts = [check.country || '—'];
    if (check.quality && check.channel === channel) parts.push(check.quality);
    parts.push(check.ms + ' мс');
    return { status: 'ok', text: parts.join(' · ') };
}

// Server picker: summary row and list. `state` = callbacks.getProviderState():
// { id, checks, currentId (ReYohoho server in use), channel }.
function renderProviderSection(panel, state) {
    const root = panel.querySelector('.reyohoho-server');
    if (!root || !state) return;
    const selected = getProxyProvider(state.id);
    const shown = selected.id === 'auto' ? PROXY_PROVIDERS.find((p) => p.id === state.currentId) : selected;
    const view = shown ? providerCheckView(state.checks[shown.id], state.channel) : { status: 'idle', text: '' };
    root.querySelector('.reyohoho-server-name').textContent = selected.id === 'auto' && shown ? 'Авто · ' + shown.label : selected.label;
    const meta = root.querySelector('.reyohoho-server-toggle .reyohoho-meta');
    meta.textContent = view.text;
    meta.dataset.status = view.status;
    root.querySelectorAll('.reyohoho-server-option').forEach((option) => {
        const id = option.dataset.id;
        const v = id === 'auto'
            ? { status: 'idle', text: shown && selected.id === 'auto' ? 'Сейчас ' + shown.label : 'Первый доступный' }
            : providerCheckView(state.checks[id], state.channel);
        const optionMeta = option.querySelector('.reyohoho-meta');
        optionMeta.textContent = v.text;
        optionMeta.dataset.status = v.status;
        option.setAttribute('aria-checked', String(id === selected.id));
        option.tabIndex = id === selected.id ? 0 : -1;
    });
}

function serverOptionsHtml(providers) {
    return providers.map((p) => `
        <button type="button" role="radio" class="reyohoho-server-option" data-id="${p.id}" aria-checked="false" tabindex="-1">
          <span class="reyohoho-radio" aria-hidden="true"></span>
          <span class="reyohoho-server-option-text">
            <span class="reyohoho-server-option-name">${p.label}</span>
            <span class="reyohoho-meta" data-status="idle"></span>
          </span>
        </button>`).join('');
}

function updateProviderInPanels(state) {
    document.querySelectorAll('.reyohoho-proxy-settings').forEach((panel) => renderProviderSection(panel, state));
}

// Show/hide the sponsor block on a single panel. Kept in the DOM (toggled via
// display) so an async backend response can reveal it after injection without
// re-rendering the whole panel. Fail-closed: anything other than `true` hides.
function applyTubernetAdState(rootEl, tubernetAdEnabled) {
    if (!rootEl) return;
    const sponsor = rootEl.querySelector('.reyohoho-sponsor');
    if (sponsor) {
        sponsor.style.display = tubernetAdEnabled === true ? '' : 'none';
    }
}

function createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled) {
    const { onExtensionToggle, onVaftToggle, onIrcProxyToggle, onHideAudioOnlyToggle } = callbacks;
    const irc = getIrcProxyDisplay(extensionEnabled, ircProxy);
    const hideAudioOnlyEnabled = hideAudioOnly === true;
    const sponsorDisplay = tubernetAdEnabled === true ? '' : 'none';
    
    const panel = document.createElement('div');
    panel.className = 'reyohoho-proxy-settings';
    panel.innerHTML = `
    <div class="reyohoho-header">
      <svg class="reyohoho-logo" viewBox="0 0 20 20" aria-hidden="true"><rect width="20" height="20" rx="6" fill="#9147ff"/><path d="M8 6.3v7.4c0 .4.44.64.77.42l5.6-3.7a.5.5 0 0 0 0-.84l-5.6-3.7A.5.5 0 0 0 8 6.3z" fill="#fff"/></svg>
      <span class="reyohoho-title">ReYohoho</span>
      <span class="reyohoho-version">v${VERSION}</span>
      <span class="reyohoho-proxy-status" data-status="${proxyStatus.status}">${getStatusText(proxyStatus.status)}</span>
    </div>
    <a href="${getSponsorUrl()}" target="_blank" rel="noopener noreferrer" class="reyohoho-sponsor" style="display: ${sponsorDisplay}">
      <span class="reyohoho-sponsor-label">Спонсор</span>
      <span class="reyohoho-sponsor-body">
        <img class="reyohoho-sponsor-icon" src="${getSponsorIcon()}" alt="">
        <span class="reyohoho-sponsor-text">
          <span class="reyohoho-sponsor-name">${SPONSOR_NAME}</span>
          <span class="reyohoho-sponsor-desc">${SPONSOR_DESC}</span>
        </span>
        <svg class="reyohoho-sponsor-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5h6v6M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
    </a>
    <div class="reyohoho-group">
      <div class="reyohoho-row">
        <span class="reyohoho-row-text">
          <span class="reyohoho-row-title">Прокси</span>
          <span class="reyohoho-row-desc">1080p/1440p и доступ к Twitch через ReYohoho</span>
        </span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-ext-toggle" aria-label="Прокси" ${extensionEnabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
      <div class="reyohoho-row reyohoho-server">
        <button type="button" class="reyohoho-server-toggle" aria-expanded="false" aria-controls="reyohoho-server-list">
          <span class="reyohoho-row-text">
            <span class="reyohoho-row-title">Сервер</span>
            <span class="reyohoho-server-summary">
              <span class="reyohoho-server-name"></span>
              <span class="reyohoho-meta" data-status="idle"></span>
            </span>
          </span>
          <svg class="reyohoho-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="reyohoho-server-list" id="reyohoho-server-list" role="radiogroup" aria-label="Сервер плейлистов" hidden>
          <span class="reyohoho-server-group">ReYohoho</span>
          ${serverOptionsHtml(PROXY_PROVIDERS.filter((p) => !p.live))}
          <span class="reyohoho-server-group">Сторонние</span>
          ${serverOptionsHtml(PROXY_PROVIDERS.filter((p) => p.live))}
          <span class="reyohoho-server-note">Сторонним уходит только имя канала, без вашего аккаунта. Записи всегда идут через ReYohoho.</span>
        </div>
      </div>
      <div class="reyohoho-row">
        <span class="reyohoho-row-text">
          <span class="reyohoho-row-title">Скрыть Audio Only</span>
          <span class="reyohoho-row-desc">Убрать «только звук» из списка качества</span>
        </span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-audio-only-toggle" aria-label="Скрыть Audio Only" ${hideAudioOnlyEnabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
      <div class="reyohoho-row">
        <span class="reyohoho-row-text">
          <span class="reyohoho-row-title">Чат через прокси <span class="reyohoho-proxy-status reyohoho-irc-status" data-status="${irc.badgeStatus}">${irc.badgeText}</span></span>
          <span class="reyohoho-row-desc">Если сервер недоступен, чат идёт напрямую</span>
        </span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-irc-toggle" aria-label="Чат через прокси" ${irc.enabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
      <div class="reyohoho-row">
        <span class="reyohoho-row-text">
          <span class="reyohoho-row-title">Блокировка рекламы</span>
          <span class="reyohoho-row-desc">VAFT подменяет рекламу чистым потоком</span>
          <!-- @build-vaft-test-button -->
        </span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-vaft-toggle" aria-label="Блокировка рекламы" ${vaftEnabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="reyohoho-links">
      <a href="https://t.me/reyohoho_twitch_ext" target="_blank" rel="noopener noreferrer" class="reyohoho-tg-link">
        <svg class="reyohoho-tg-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
        <span>Новости</span>
      </a>
      <a href="https://boosty.to/sentryward/donate" target="_blank" rel="noopener noreferrer" class="reyohoho-donate-link">
        <svg class="reyohoho-heart-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 14.2 6.9 13.2C3.1 9.8.6 7.5.6 4.7.6 2.4 2.4.6 4.7.6c1.3 0 2.5.6 3.3 1.5C8.8 1.2 10 .6 11.3.6c2.3 0 4.1 1.8 4.1 4.1 0 2.8-2.5 5.1-6.3 8.5L8 14.2z"/></svg>
        <span>Поддержать</span>
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

    // Server picker: a disclosure with a radio list. The whole list is probed
    // only when opened (not on every menu open, so 90k viewers don't keep
    // hitting third-party servers); the server in use is probed on menu open.
    const serverRoot = panel.querySelector('.reyohoho-server');
    if (serverRoot) {
        const toggleBtn = serverRoot.querySelector('.reyohoho-server-toggle');
        const list = serverRoot.querySelector('.reyohoho-server-list');
        const options = () => Array.from(list.querySelectorAll('.reyohoho-server-option'));
        const setOpen = (open) => {
            list.hidden = !open;
            toggleBtn.setAttribute('aria-expanded', String(open));
            if (open) {
                if (callbacks.onProviderCheck) callbacks.onProviderCheck();
                (list.querySelector('[aria-checked="true"]') || options()[0]).focus();
            }
        };
        renderProviderSection(panel, callbacks.getProviderState && callbacks.getProviderState());
        toggleBtn.addEventListener('click', () => setOpen(list.hidden));
        list.addEventListener('click', (e) => {
            const option = e.target.closest('.reyohoho-server-option');
            if (!option) return;
            if (option.getAttribute('aria-checked') === 'true') {
                setOpen(false);
                toggleBtn.focus();
            } else if (callbacks.onProviderChange) {
                callbacks.onProviderChange(option.dataset.id);
            }
        });
        list.addEventListener('keydown', (e) => {
            const all = options();
            const i = all.indexOf(document.activeElement);
            let next = null;
            if (e.key === 'ArrowDown') next = all[(i + 1) % all.length];
            else if (e.key === 'ArrowUp') next = all[(i - 1 + all.length) % all.length];
            else if (e.key === 'Home') next = all[0];
            else if (e.key === 'End') next = all[all.length - 1];
            else if (e.key !== 'Escape') return;
            // Keep the keys from Twitch's menu, which would move its own focus or close.
            e.preventDefault();
            e.stopPropagation();
            if (next) {
                next.focus();
            } else {
                setOpen(false);
                toggleBtn.focus();
            }
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
    
    // @build-vaft-test-handler

    panel.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // Userscript fallback: render the sponsor icon via <canvas> to bypass the
    // page CSP (Firefox blocks data: <img>). No-op inside the extensions.
    renderSponsorIconFallback(panel);

    return panel;
}

// Updates all live panels. Each toggle is only touched when the caller
// passed a defined value for it — so a partial update (e.g. only the
// IRC proxy state) won't accidentally flip unrelated toggles to their
// boolean default. This guards against bugs where an `undefined`
// argument would coerce to `false` and visually animate a user-enabled
// toggle (e.g. Audio Only) into the OFF position without actually
// changing any persisted state.
function updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxy, hideAudioOnly, tubernetAdEnabled) {
    const irc = ircProxy !== undefined
        ? getIrcProxyDisplay(extensionEnabled, ircProxy)
        : null;

    document.querySelectorAll('.reyohoho-proxy-settings').forEach(panel => {
        if (typeof tubernetAdEnabled === 'boolean') {
            applyTubernetAdState(panel, tubernetAdEnabled);
        }
        const extToggle = panel.querySelector('#reyohoho-ext-toggle');
        if (extToggle && typeof extensionEnabled === 'boolean') {
            extToggle.checked = extensionEnabled;
        }
        const vaftToggle = panel.querySelector('#reyohoho-vaft-toggle');
        if (vaftToggle && typeof vaftEnabled === 'boolean') {
            vaftToggle.checked = vaftEnabled;
        }
        const ircToggle = panel.querySelector('#reyohoho-irc-toggle');
        if (ircToggle && irc) {
            ircToggle.checked = irc.enabled;
        }
        const audioOnlyToggle = panel.querySelector('#reyohoho-audio-only-toggle');
        if (audioOnlyToggle && typeof hideAudioOnly === 'boolean') {
            audioOnlyToggle.checked = hideAudioOnly;
        }
        const ircStatusEl = panel.querySelector('.reyohoho-irc-status');
        if (ircStatusEl && irc) {
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

function injectIntoElement(container, extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled) {
    if (!container || container.querySelector('.reyohoho-proxy-settings')) {
        return false;
    }

    const panel = createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled);
    container.insertBefore(panel, container.firstChild);
    if (callbacks && callbacks.onPanelShown) callbacks.onPanelShown();
    return true;
}

function tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled) {
    const settingsMenu = document.querySelector('[data-a-target="player-settings-menu"]');

    if (settingsMenu && injectIntoElement(settingsMenu, extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxy, hideAudioOnly, tubernetAdEnabled)) {
        console.log('[ReYohoho] Injected into player settings menu');
        return true;
    }

    return false;
}

// `getState` is invoked on every relevant mutation so the freshly
// (re)opened settings menu is rendered against the *current* state
// (extension toggle, IRC proxy on/off + availability, etc.) rather than
// the snapshot captured when this observer was first wired up. Without
// this getter, closing and reopening the player settings menu after
// flipping the IRC proxy toggle would re-inject a panel showing the
// stale pre-toggle UI.
function startObserver(getState) {
    const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;

        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldCheck = true;
                break;
            }
        }

        if (shouldCheck) {
            const s = getState();
            tryInjectSettings(
                s.extensionEnabled,
                s.vaftEnabled,
                s.proxyStatus,
                s.callbacks,
                s.ircProxy,
                s.hideAudioOnly,
                s.tubernetAdEnabled
            );
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    return observer;
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { 
        getStatusText,
        getIrcProxyDisplay,
        providerCheckView,
        renderProviderSection,
        updateProviderInPanels,
        applyTubernetAdState,
        createSettingsPanel, 
        updateAllPanels,
        updateProxyStatusInPanels,
        injectIntoElement,
        tryInjectSettings,
        startObserver
    };
}
