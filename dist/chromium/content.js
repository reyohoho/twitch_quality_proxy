// ============================================
// ReYohoho Twitch Proxy - Content Script
// ============================================

// ============================================
// ReYohoho Twitch Proxy - Constants
// ============================================

const VERSION = '2.6.2';
const PROXY_SERVERS = [
    "https://proxy4.rte.net.ru/",
    "https://proxy7.rte.net.ru/",
    "https://proxy5.rte.net.ru/",
    "https://proxy6.rte.net.ru/"
];

const TEST_MODE_PARAM = "&proxymode=adblock";

// Sponsor block (shown at the top of the settings panel)
// Gated behind a backend toggle: GET {ad_enabled: bool}. On timeout, network
// error or `false` the sponsor block stays hidden (fail-closed); only an
// explicit `true` reveals it.
const TUBERNET_AD_ENABLED_URL = 'https://ext.rte.net.ru:8443/api/tubernet/ad-enabled';
const TUBERNET_AD_FETCH_TIMEOUT = 4000;

// Resolve whether the Tubernet sponsor block should be shown. Returns false on
// any failure (timeout, network error, non-OK status, malformed body) so a
// flaky/unreachable backend never surfaces the sponsor block.
async function fetchTubernetAdEnabled() {
    try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), TUBERNET_AD_FETCH_TIMEOUT);
        const res = await fetch(TUBERNET_AD_ENABLED_URL, {
            method: 'GET',
            cache: 'no-store',
            mode: 'cors',
            signal: ctrl.signal
        });
        clearTimeout(tid);
        if (!res.ok) {
            console.warn(`[ReYohoho] tubernet ad-enabled -> HTTP ${res.status}`);
            return false;
        }
        const data = await res.json();
        return data && data.ad_enabled === true;
    } catch (e) {
        console.warn('[ReYohoho] tubernet ad-enabled fetch failed:', e.name || e.message);
        return false;
    }
}

const SPONSOR_NAME = 'ТУБЕРНЕТ';
const SPONSOR_DESC = 'Доступ к любимым сервисам';
const SPONSOR_URL_CHROMIUM = 'https://chromewebstore.google.com/detail/%D1%82%D1%83%D0%B1%D0%B5%D1%80%D0%BD%D0%B5%D1%82-%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF-%D0%BA-%D0%BB%D1%8E%D0%B1%D0%B8%D0%BC%D1%8B%D0%BC/gbecllcmfddeffkfmjlndaokefpaehie';
const SPONSOR_URL_FIREFOX = 'https://addons.mozilla.org/ru/firefox/addon/tubernet/';

// Pick the sponsor link for the current browser. In the userscript build the
// same bundle runs on both Chromium and Firefox, so we detect at runtime.
function getSponsorUrl() {
    try {
        const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
        const isFirefox = /firefox/i.test(ua) || (typeof InstallTrigger !== 'undefined');
        return isFirefox ? SPONSOR_URL_FIREFOX : SPONSOR_URL_CHROMIUM;
    } catch (e) {
        return SPONSOR_URL_CHROMIUM;
    }
}

// True when running inside a browser extension that exposes runtime.getURL.
// Used to load packaged (CSP-safe) resources; false in the userscript build.
function hasExtensionRuntime() {
    try {
        const api = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime
            : (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime
            : null;
        return !!(api && typeof api.getURL === 'function');
    } catch (e) {
        return false;
    }
}

// Resolve the sponsor icon. In the extensions we load it as a packaged
// web-accessible resource via runtime.getURL — Firefox enforces the page's
// CSP on content-script-injected <img>, which blocks data: URIs, but allows
// the extension's own moz-extension:// resources. The data URI is kept as a
// fallback for the userscript build (no extension API available).
function getSponsorIcon() {
    try {
        const api = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime
            : (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime
            : null;
        if (api && typeof api.getURL === 'function') {
            return api.getURL('static/tubernet.png');
        }
    } catch (e) { /* fall through to data URI */ }
    return SPONSOR_ICON;
}

// Decode a data: URI into a Blob (used to bypass CSP in the userscript build).
function dataUriToBlob(dataUri) {
    const comma = dataUri.indexOf(',');
    const meta = dataUri.slice(0, comma);
    const b64 = dataUri.slice(comma + 1);
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

// In the userscript build the sponsor icon falls back to a data: URI, which
// Firefox blocks via the page CSP for content-injected <img>. Painting the
// decoded bitmap onto a <canvas> sidesteps img-src entirely, so swap the
// <img> for a <canvas> when no extension runtime is available.
function renderSponsorIconFallback(rootEl) {
    if (!rootEl || hasExtensionRuntime()) return;
    const img = rootEl.querySelector('.reyohoho-sponsor-icon');
    if (!img || typeof createImageBitmap !== 'function') return;
    try {
        const blob = dataUriToBlob(SPONSOR_ICON);
        createImageBitmap(blob).then((bmp) => {
            const canvas = document.createElement('canvas');
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            canvas.className = img.className;
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.drawImage(bmp, 0, 0);
            if (img.parentNode) img.parentNode.replaceChild(canvas, img);
        }).catch(() => { /* leave the (broken) img in place */ });
    } catch (e) { /* ignore */ }
}
const SPONSOR_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAA3NCSVQICAjb4U/gAAADAFBMVEVHcEwuvMK6K57KN63QObJhJk4ppKsvCgU7CTwfAABbV4suwsO7PbQhcHjyO7/DLZ2sLpiKQaOGY8XsOLffNbAw1dLJKp4rusRhSpEttr4iAwAAAAAyOIbsOLeeKo9hVI4vx8mNQqSdR7NJE2splJEtscgu09ItzM0txcexN6Yu0dAtg53MM6sunLbZPb5QlM2IWr12XraeV8bfObeVU7wrs8jpOLjnNrUx3dgx3tgrytCzVc3BR8Msuc/5Orw6lb4v0s8lSXststDxOr7aOLYvna3tPcPlNLMu1tX0NrhodcJzbsJ0bcI0o8qRU7uSWsLcP8EzosWASaU0nsN2ab8ssct+T6urSLwqx9IxfoAvlq/EScYqxc5HhLMrzNEtrsDkN7Z5cchTh8PaQ8o4nsjWRMkqrr8t09QyoMJ3a8TvObzxOLxHjsJcgcYx3tgryNhSiMUu1dQmmaAw2tayR7stzc4/iLOuR7nfP8IqydGUADpzhNTrRtSLbM+ZatRqbLmEacguqsmzS8CmUMAousuyUMavUMXmPsMt0NBDkMP1P8kszdTmP8b21rn2PL/2Or0t1tP3ObkqytMu2NQowNH2Ororz9Mt0dJHiMQv3Nkt09NUfcIpts8pw9P8Obwsrc0u2tdddsEsp8ooutD4PcQpuNCDXcB6YsBvacApsM0pxtIovc/rP8M0mcc/jsVPgcLSRMcps84x39oovtH7PcbdQsXzPcE6ncs7ksWLWL9Ci8RncMIpwtLDScYwpMqhVcYx4dsx2dIr0dWwSsOlTcI3lcUxnchXesEvoMjvPcArzdJOisbXRMa7ScSQXcZ8aMWVWcStUcYpx9Iqzde3TsdClcneR9Ax5N0zqc90ZsDjQsbMRcbJR8diesUt1NMu19fzOr2YU8FqbcBkccGfUcJtcsfmQMS+Tskr09lAmsrvQMeKXsWXVMFzbMRXgsY5o8/tRdToRdCNcNWQVsBLhMNidMIpyNOqVstJj8hKhcOZWcfGTMtdm9tui9jMT9FHcExjmNt0AAABAHRSTlMAWDBSXgEmCg4GAk5bE+44KzL+tGizIm8hRAQCGb8bBG8/WRcah9GEeUqLK0FbrNOLXs16eLenjtD7wf284f1qqBf95XM9xYDZ+5l8yeSo25e1Nqdry0iG1wtH1LBJyWvOtIjg0sad7nzm1Nmp+uzy0PQexZygUma37RT17efyRbft6++m6O3p7pHx8+v///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8A4wz1XAAAB1ZJREFUWIWdVwdYU0kQXqQkQUGK0gQUBBURC2JDPXs9e++9dz379V6/5BFKDCQQJagQiiQYFJFIrBQRQhOVEAsioCIWrHffzb60FxLK3Xxf8t7uzL9v5t+ZLQi1JIx+E+cc3rh8+fJR+xd727do1oJ0nvPr4ztl+XfvXawpKSkpGvlWFhh0tN1o+jBVXd2ds/ln1PiioiLZo6eFHwpmD2oXvKcjU5r4GOPvfaypqRkJX5fJCgsLC+odbt36vG380GhmTmLinbNlZ9aPWuzt5eW1yDto1myAnwf8s+qdB1uHm7M+k+YkPk4829+PZqCYN9Dh1K2K6jfX8wbQW8E7RoercnLqJliYUnrNeHbh+PO8d7VjWoLTbENU0hyhbb+WDFxmVD7PKy1tGGJa7ckKYTGlwoktO2htvfL5u9LarNujTWmdVOGAt20tQjzG3IYTt2PG76YZaeisECZT6NE63HKpi/2O0phUka8r2e5urdd9Bv4L+7eOhxFQN+QcJxodHKBxSKfxwPihbeHVwiD/J/UO3txL19clGgiY3D48yL4+qyKeRCqJrroxQ8JZLNt2on18x/MTFLkRkcpLZto+j5BwFcuYWFOybkD6bZ6Iz87lRBJchqazMwSQ1qU98EGVeaUwgCSBHOALbfc2YHBCO+D2WytT8mqzYuIk4EGkUqyNwA470KFt/KzTb6KOgQPjY/kJ7Ah5JBdmlRTHkPB2zMC8+mcPo14np83chtCSJuBQ0FergilI69wWfmBBxYXrKRnp83FjRVNuJIdA6IANbllABG0xQJtdX/HgeMqx0rm45SaHCMABf64zbnpADkxpHe9VcPLUg+NRx5Jnks3gJnYER4zQVMUqdQSqaHfL5ph+5iCdsHj7zfpw/hQQ+D4j3R+rnIsBz+2DVkewI6Ec8BwYJ+GUtLq6xjJYWC+WXJbdB/xDCODcBqxaXQwUckYgxpEjEVX+ZBkwjapomDDxMV7XL968efnK0/MnKy7gAJKAQZ8VbJhDTjnU85+5EQIzvAyHG2XhFCFe2OHzNy9fvnL/1UkgMCol+eqNE0NGZ/JxFpJltKJYHtoboTXGkzhYiBd2Df4Rxr+5DgFcy4rnxZFZrBxBcvFEToxFyDacKfU0wE8Uwsp+9sxd7D7+PhAA+OSkGydSebGZCqgCsRW2W1Ylx+UwLZzJ7EbFd0nD+HyIH/AQ/6nTQMD75KvXsmJS40T8plyOpgiswINe6gEM/E+TSnEAdwH/SIt/nXEOHIjnicISIAN6qC3HCZTEVJwGhgP42ds5OTl5OtF+uPLovgafQuLBAShDjriPxpIeqRvAjTqCJbK0hrxyL9LjgQAIIJ4XG5aQy+2hNexZpcQhNPdAK4u1eEwgEKBhgNsRdddYWFUpQ7tiDlhSU7vJj2T8D45fhwwiAyAd2Gyjt3AVENkwjdtDmEITq4mf7JUWn3EOHDgRDw6EFVNNenAJLiSSIyRS890YexSkjT8j+arGAQl/FdWqq5K4BBk9OFolHGYAp5V1Ag4LcQFp8JhB7EBTb6rdXoLgjiOXZOZ2ar99mTn8fTgJ+Rf1WoOHACAH+PKOFLueXIKowi8wDUI9i9YWL1zg4VlfAfn7HvgDPBmASMJXyMfp7ZAzDEBuTXhb1JfjnDL1BrOomvy8Dh8ryUxgCxBlgKlKQkx6ZBHNUm3T9m9cTz6+c0PTgf30+UlJWd/PJPFhCraSejTpKQYK1K8W/ZlpduRbt6/IDZ72ci38b0iv3YeysraguVDFUATs3Coqh30FRKhmc3WMZkrJfYH2YjDJ4kv1cXAL/HDdLoQqliTgKqRwaCkgiHJ/jTPRLCnemTq8MMfNQS+/xQ/9WYzH01RxD0MHxMO1DUc4HP4BE4oXJuuBL3G2Wg4YoNXaxOEADL+P6Fxi7yZ3S01ZeKpUUuFh9XvgN3iFZ3xap2N7mQRSMJczwp2CR71CidDh+uYwVk6OijzfjQwkWfi0Uq/0lYjCFPJdDCq+D5dQllN7pqlUa/5yQox/9uPWgr9ddFwtRQtFkkx5MBWOJl2CMqAyAjs8y5aGjpYdwpjpX1LWSEsUJ5E8MagBNA7wguEGXWgKbK92jeQh9+u1lH7r7nSJqNjMwJZeThC/7dKtKzrpB0UAabyg2Z1gUlixlUGHVXmoQCkwPlFZvKAji8ZORv2+uw3oQ2aXsrMJsauRXefJDMDnl41qrvAxbI4tBzy3Y3MrUvwa8X768ZBJpVpcR3Czs7PFpvGQy2vOwIZY84u3abW1VS+xMjtbILYyrQexw/iSoreyIIax0myJHE6nUAFuxjq9jPoI1zxZYb3DjAUulG4fsyGZxQo4FxAGFWVK5v38VlZY4AAXtMqde3b8PmbMat9NC3mxfAmsSIqIqrGtfl4tiwIL8A3vQiW+YKU33I6JSeXxRLESCZt9wKZtOBabgVurqyvVA9zIghtOKnZhiXP70GqhD5q+Jy+vtLaB9CBu9E8BS/8LXOuJ/8qAgICDk3zaNv3/8i++K68pJyXuQAAAAABJRU5ErkJggg==';

const MODES = {
    OLD: 'old',      // Макс 1440p (возможна реклама)
    TEST: 'test'     // Макс 1080p (возможно без рекламы)
};

const PROXY_CHECK_TIMEOUT = 3000;
const CHECK_INTERVAL = 5000;

const RUSSIA_ONLY_ENDPOINT_PATH = 'russia-only-channels';
const RUSSIA_ONLY_STORAGE_KEY = 'russiaOnlyChannels';
const RUSSIA_ONLY_LS_KEY = 'reyohoho_russia_only_channels';
const RUSSIA_ONLY_FETCH_INTERVAL = 5 * 60 * 1000; // 5 минут
const RUSSIA_ONLY_FETCH_TIMEOUT = 4000;

function extractTwitchChannelFromUsherUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.match(/usher\.ttvnw\.net\/api\/v[12]\/channel\/hls\/([^\/.?&#]+)\.m3u8/i);
    return m ? m[1].toLowerCase() : null;
}

async function fetchRussiaOnlyChannels(servers) {
    if (!Array.isArray(servers) || servers.length === 0) return null;
    for (const base of servers) {
        const url = String(base || '').replace(/\/?$/, '/') + RUSSIA_ONLY_ENDPOINT_PATH;
        try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), RUSSIA_ONLY_FETCH_TIMEOUT);
            const res = await fetch(url, {
                method: 'GET',
                cache: 'no-store',
                mode: 'cors',
                signal: ctrl.signal
            });
            clearTimeout(tid);
            if (!res.ok) {
                console.warn(`[ReYohoho] russia-only fetch ${url} -> HTTP ${res.status}`);
                continue;
            }
            const data = await res.json();
            if (data && Array.isArray(data.channels)) {
                return data.channels
                    .map(c => String(c || '').toLowerCase().trim())
                    .filter(c => c.length > 0);
            }
            console.warn(`[ReYohoho] russia-only fetch ${url}: invalid response shape`);
        } catch (e) {
            console.warn(`[ReYohoho] russia-only fetch ${url} failed:`, e.name || e.message);
        }
    }
    return null;
}

// IRC chat WebSocket proxy
const IRC_PROXY_HOST = 'https://ext.rte.net.ru:8443';
const IRC_PROXY_TARGET_URL = 'wss://ext.rte.net.ru:8443/tw-irc-proxy';
const IRC_PROXY_SOURCE_PREFIX = 'wss://irc-ws.chat.twitch.tv';
const IRC_PROXY_CHECK_INTERVAL = 30000; // 30 seconds
const IRC_PROXY_CHECK_TIMEOUT = 3000;



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
      <span class="reyohoho-icon">🎬</span>
      <span class="reyohoho-title">ReYohoho Proxy <span class="reyohoho-version">v${VERSION}</span></span>
      <span class="reyohoho-proxy-status" data-status="${proxyStatus.status}">${getStatusText(proxyStatus.status)}</span>
    </div>
    <a href="${getSponsorUrl()}" target="_blank" rel="noopener noreferrer" class="reyohoho-sponsor" style="display: ${sponsorDisplay}">
      <span class="reyohoho-sponsor-label">Спонсор</span>
      <span class="reyohoho-sponsor-body">
        <img class="reyohoho-sponsor-icon" src="${getSponsorIcon()}" alt="${SPONSOR_NAME}">
        <span class="reyohoho-sponsor-text">
          <span class="reyohoho-sponsor-name">${SPONSOR_NAME}</span>
          <span class="reyohoho-sponsor-desc">${SPONSOR_DESC}</span>
        </span>
        <span class="reyohoho-sponsor-arrow">↗</span>
      </span>
    </a>
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
    // Tubernet sponsor block gate. Fail-closed: starts hidden and is only
    // revealed once the backend explicitly returns ad_enabled=true. A timeout,
    // network error or `false` keeps it hidden.
    let tubernetAdEnabled = false;

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
            vaftInitialized = true; return; // vaft.js is loaded as MAIN-world content script via manifest
            
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
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
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
        const probeUrl = (typeof IRC_PROXY_HOST !== 'undefined' ? IRC_PROXY_HOST : 'https://ext.rte.net.ru:8443') + '/https://google.com';
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

    // Live snapshot used by the MutationObserver to render the panel
    // against current state instead of values captured at initUI() time.
    // Critical for toggles that don't reload the page (e.g. IRC proxy):
    // without this, closing and reopening the Twitch settings menu after
    // a toggle would re-render the panel with the pre-toggle state.
    function getCurrentUIState() {
        return {
            extensionEnabled,
            vaftEnabled,
            proxyStatus,
            callbacks,
            ircProxy: ircProxyState(),
            hideAudioOnly: hideAudioOnlyEnabled,
            tubernetAdEnabled
        };
    }

    // Initialize UI injection
    function initUI() {
        // Start observer for settings menu
        startObserver(getCurrentUIState);
        
        // Periodic check
        setInterval(() => {
            tryInjectSettings(extensionEnabled, vaftEnabled, proxyStatus, callbacks, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
        }, 500);
        
        // Periodic status update
        setInterval(async () => {
            await fetchProxyStatus();
            updateProxyStatusInPanels(proxyStatus, ircProxyState());
        }, 5000);

        // Resolve the Tubernet sponsor gate once on load. Fail-closed: only an
        // explicit ad_enabled=true reveals the sponsor block; timeout/error/false
        // keeps it hidden.
        refreshTubernetAdEnabled();

        // Periodic IRC proxy availability probe. Runs once immediately so
        // the cached flag reflects current reality on a fresh page load.
        const ircInterval = typeof IRC_PROXY_CHECK_INTERVAL !== 'undefined' ? IRC_PROXY_CHECK_INTERVAL : 30000;
        checkIrcProxyAvailability().then(() => {
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
        });
        setInterval(async () => {
            await checkIrcProxyAvailability();
            updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
        }, ircInterval);
    }

    // Ask the backend whether the Tubernet sponsor block should be shown and
    // push the result into any live panels.
    async function refreshTubernetAdEnabled() {
        try {
            tubernetAdEnabled = await fetchTubernetAdEnabled();
        } catch (e) {
            tubernetAdEnabled = false;
        }
        updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
    }

    // Listen for storage changes (extensions)
    if (isExtension && api && api.storage && api.storage.onChanged) {
        api.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local') {
                if (changes.extensionEnabled) {
                    extensionEnabled = changes.extensionEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
                }
                if (changes.vaftEnabled) {
                    vaftEnabled = changes.vaftEnabled.newValue;
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
                }
                if (changes.ircProxyEnabled) {
                    ircProxyEnabled = changes.ircProxyEnabled.newValue;
                    saveIrcProxyEnabledToLocalStorage(ircProxyEnabled);
                    // Mirror the local toggle path so other tabs also drop
                    // their active IRC sockets and reconnect via the new
                    // route without requiring a manual reload.
                    dispatchIrcProxyDrop(ircProxyEnabled ? 'toggle-on-sync' : 'toggle-off-sync');
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
                }
                if (changes.hideAudioOnlyEnabled) {
                    hideAudioOnlyEnabled = changes.hideAudioOnlyEnabled.newValue;
                    saveHideAudioOnlyToLocalStorage(hideAudioOnlyEnabled);
                    updateAllPanels(extensionEnabled, vaftEnabled, proxyStatus, ircProxyState(), hideAudioOnlyEnabled, tubernetAdEnabled);
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
