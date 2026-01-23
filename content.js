const api = typeof browser !== 'undefined' ? browser : chrome;

const MODES = {
    OLD: 'old',
    TEST: 'test'
};

let currentMode = MODES.OLD;

async function loadMode() {
    try {
        const result = await api.storage.local.get(['proxyMode']);
        if (result.proxyMode) {
            currentMode = result.proxyMode;
        }
    } catch (e) {
        console.error('Error loading mode:', e);
    }
}

async function saveMode(mode) {
    const oldMode = currentMode;
    currentMode = mode;
    try {
        await api.storage.local.set({ proxyMode: mode });
        api.runtime.sendMessage({ type: 'modeChanged', mode: mode });

        if (oldMode !== mode) {
            location.reload();
        }
    } catch (e) {
        console.error('Error saving mode:', e);
    }
}

async function getProxyStatus() {
    try {
        const response = await api.runtime.sendMessage({ type: 'getProxyStatus' });
        return response || { proxyUrl: null, status: 'unknown' };
    } catch (e) {
        console.error('Error getting proxy status:', e);
        return { proxyUrl: null, status: 'error' };
    }
}

function formatProxyUrl(url) {
    if (!url) return 'Не подключен';
    try {
        const parsed = new URL(url);
        return parsed.hostname;
    } catch {
        return url;
    }
}

function getStatusInfo(status) {
    switch (status) {
        case 'connected':
            return { text: 'Подключен', class: 'status-connected' };
        case 'checking':
            return { text: 'Проверка...', class: 'status-checking' };
        case 'error':
        case 'unavailable':
            return { text: 'Недоступен', class: 'status-error' };
        default:
            return { text: 'Неизвестно', class: 'status-unknown' };
    }
}

function createSettingsPanel() {
    const panel = document.createElement('div');
    panel.className = 'reyohoho-proxy-settings';
    panel.innerHTML = `
    <div class="reyohoho-header">
      <span class="reyohoho-icon">🎬</span>
      <span class="reyohoho-title">ReYohoho Twitch Proxy</span>
    </div>
    <div class="reyohoho-status">
      <div class="reyohoho-status-row">
        <span class="reyohoho-status-label">Прокси:</span>
        <span class="reyohoho-status-value proxy-url">Загрузка...</span>
      </div>
      <div class="reyohoho-status-row">
        <span class="reyohoho-status-label">Статус:</span>
        <span class="reyohoho-status-value proxy-status status-checking">Проверка...</span>
      </div>
    </div>
    <div class="reyohoho-options">
      <label class="reyohoho-option" data-mode="${MODES.OLD}">
        <input type="radio" name="reyohoho-mode" value="${MODES.OLD}" ${currentMode === MODES.OLD ? 'checked' : ''}>
        <span class="reyohoho-radio"></span>
        <div class="reyohoho-option-text">
          <span class="reyohoho-option-title">Макс 1440p(возможна реклама твича)</span>
          <span class="reyohoho-option-desc">Обычный режим</span>
        </div>
      </label>
      <label class="reyohoho-option" data-mode="${MODES.TEST}">
        <input type="radio" name="reyohoho-mode" value="${MODES.TEST}" ${currentMode === MODES.TEST ? 'checked' : ''}>
        <span class="reyohoho-radio"></span>
        <div class="reyohoho-option-text">
          <span class="reyohoho-option-title">Макс 1080p(без рекламы)</span>
          <span class="reyohoho-option-desc">Тестовый режим</span>
        </div>
      </label>
    </div>
  `;

    panel.querySelectorAll('input[name="reyohoho-mode"]').forEach(input => {
        input.addEventListener('change', (e) => {
            e.stopPropagation();
            saveMode(e.target.value);
            updateActiveState(panel);
        });
    });

    panel.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    updateProxyStatusInPanel(panel);

    return panel;
}

async function updateProxyStatusInPanel(panel) {
    const proxyUrlEl = panel.querySelector('.proxy-url');
    const proxyStatusEl = panel.querySelector('.proxy-status');

    if (!proxyUrlEl || !proxyStatusEl) return;

    const { proxyUrl, status } = await getProxyStatus();
    const statusInfo = getStatusInfo(status);

    proxyUrlEl.textContent = formatProxyUrl(proxyUrl);
    proxyStatusEl.textContent = statusInfo.text;
    proxyStatusEl.className = `reyohoho-status-value proxy-status ${statusInfo.class}`;
}

function updateActiveState(panel) {
    panel.querySelectorAll('.reyohoho-option').forEach(option => {
        const input = option.querySelector('input');
        if (input.checked) {
            option.classList.add('active');
        } else {
            option.classList.remove('active');
        }
    });
}

function updateAllPanels() {
    document.querySelectorAll('.reyohoho-proxy-settings').forEach(panel => {
        panel.querySelectorAll('input[name="reyohoho-mode"]').forEach(input => {
            input.checked = input.value === currentMode;
        });
        updateActiveState(panel);
    });
}

function injectIntoElement(container) {
    if (!container || container.querySelector('.reyohoho-proxy-settings')) {
        return false;
    }

    const panel = createSettingsPanel();
    updateActiveState(panel);

    container.insertBefore(panel, container.firstChild);
    return true;
}

function isMainSettingsMenu(menu) {
    const backButton = menu.querySelector('[data-a-target="player-settings-back-button"]');
    if (backButton) {
        return false;
    }

    const qualityOption = menu.querySelector('[data-a-target="player-settings-menu-item-quality"]');
    if (qualityOption) {
        return true;
    }

    return false;
}

function removeFromSubmenus() {
    const settingsMenu = document.querySelector('[data-a-target="player-settings-menu"]');
    if (settingsMenu && !isMainSettingsMenu(settingsMenu)) {
        const panel = settingsMenu.querySelector('.reyohoho-proxy-settings');
        if (panel) {
            panel.remove();
        }
    }
}

function tryInjectSettings() {
    removeFromSubmenus();

    const settingsMenu = document.querySelector('[data-a-target="player-settings-menu"]');

    if (settingsMenu && isMainSettingsMenu(settingsMenu) && injectIntoElement(settingsMenu)) {
        console.log('ReYohoho: Injected into player settings menu');
        return true;
    }

    return false;
}

function startObserver() {
    const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;

        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldCheck = true;
                break;
            }
        }

        if (shouldCheck) {
            tryInjectSettings();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}

api.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.proxyMode) {
        currentMode = changes.proxyMode.newValue;
        updateAllPanels();
    }
});

async function init() {
    await loadMode();
    startObserver();

    setInterval(() => {
        tryInjectSettings();
    }, 500);
}

init();
