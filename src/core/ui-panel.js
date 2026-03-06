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

function createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks) {
    const { onExtensionToggle, onVaftToggle } = callbacks;
    
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
        <span class="reyohoho-section-title">VAFT Блокировщик рекламы</span>
        <label class="reyohoho-toggle">
          <input type="checkbox" id="reyohoho-vaft-toggle" ${vaftEnabled ? 'checked' : ''}>
          <span class="reyohoho-toggle-slider"></span>
        </label>
      </div>
      <span class="reyohoho-section-desc">Локальная блокировка через подмену потоков</span>
      <!-- @build-vaft-test-button -->
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

    return panel;
}

function updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus) {
    document.querySelectorAll('.reyohoho-proxy-settings').forEach(panel => {
        const extToggle = panel.querySelector('#reyohoho-ext-toggle');
        if (extToggle) {
            extToggle.checked = extensionEnabled;
        }
        const vaftToggle = panel.querySelector('#reyohoho-vaft-toggle');
        if (vaftToggle) {
            vaftToggle.checked = vaftEnabled;
        }
        const statusEl = panel.querySelector('.reyohoho-proxy-status');
        if (statusEl && proxyStatus) {
            statusEl.textContent = getStatusText(proxyStatus.status);
            statusEl.dataset.status = proxyStatus.status;
        }
    });
}

function updateProxyStatusInPanels(proxyStatus) {
    document.querySelectorAll('.reyohoho-proxy-settings').forEach(panel => {
        const statusEl = panel.querySelector('.reyohoho-proxy-status');
        if (statusEl) {
            statusEl.textContent = getStatusText(proxyStatus.status);
            statusEl.dataset.status = proxyStatus.status;
        }
    });
}

function injectIntoElement(container, extensionEnabled, vaftEnabled, proxyStatus, callbacks) {
    if (!container || container.querySelector('.reyohoho-proxy-settings')) {
        return false;
    }

    const panel = createSettingsPanel(extensionEnabled, vaftEnabled, proxyStatus, callbacks);
    container.insertBefore(panel, container.firstChild);
    return true;
}

function tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks) {
    const settingsMenu = document.querySelector('[data-a-target="player-settings-menu"]');

    if (settingsMenu && injectIntoElement(settingsMenu, extensionEnabled, vaftEnabled, proxyStatus, callbacks)) {
        console.log('[ReYohoho] Injected into player settings menu');
        return true;
    }

    return false;
}

function startObserver(extensionEnabled, vaftEnabled, proxyStatus, callbacks) {
    const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;

        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldCheck = true;
                break;
            }
        }

        if (shouldCheck) {
            tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks);
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
        createSettingsPanel, 
        updateAllPanels,
        updateProxyStatusInPanels,
        injectIntoElement,
        tryInjectSettings,
        startObserver
    };
}
