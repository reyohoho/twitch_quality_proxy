// Список прокси серверов
const PROXY_DOMAINS = [
  "https://proxy4.rte.net.ru/",
  "https://proxy7.rte.net.ru/",
  "https://proxy5.rte.net.ru/",
  "https://proxy6.rte.net.ru/",
];

const TEST_MODE_PARAM = "&proxymode=adblock";

const MODES = {
  OLD: 'old',
  TEST: 'test'
};

let proxyCheckInProgress = false;
let lastProxyStatus = null;
let lastCheckTime = 0;
const CHECK_INTERVAL = 5000;
const PROXY_TIMEOUT = 3000;

let currentProxyUrl = null;
let currentMode = MODES.OLD;

async function loadMode() {
  try {
    const result = await chrome.storage.local.get(['proxyMode']);
    if (result.proxyMode) {
      currentMode = result.proxyMode;
      console.log(`Loaded mode: ${currentMode}`);
    }
  } catch (e) {
    console.error('Error loading mode:', e);
  }
}

async function checkSingleProxyAvailability(proxyUrl, timeout = PROXY_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const checkUrl = proxyUrl + "https://google.com";
    const response = await fetch(checkUrl, {
      method: "HEAD",
      mode: "cors",
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const isAvailable = response.ok;
    console.log(`Proxy ${proxyUrl} check: ${isAvailable ? "Available" : "Unavailable"} (${response.status})`);
    return isAvailable;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`Proxy ${proxyUrl} check failed:`, error.message);
    return false;
  }
}

async function findAvailableProxy() {
  for (const proxyUrl of PROXY_DOMAINS) {
    const isAvailable = await checkSingleProxyAvailability(proxyUrl);
    if (isAvailable) {
      console.log(`Found available proxy: ${proxyUrl}`);
      return proxyUrl;
    }
  }

  console.error("No available proxy servers found!");
  return null;
}

async function updateProxyRules(enable, proxyUrl) {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingRuleIds = existingRules.map((rule) => rule.id);

    if (enable && proxyUrl) {
      let extraParams = "";

      try {
        const cookie = await chrome.cookies.get({
          url: "https://twitch.tv",
          name: "auth-token"
        });
        if (cookie && cookie.value) {
          extraParams += "&auth=" + cookie.value;
          console.log("Auth token retrieved from twitch.tv cookies");
        } else {
          console.log("Auth token not found in twitch.tv cookies");
        }
      } catch (error) {
        console.error("Error retrieving auth token:", error);
      }

      if (currentMode === MODES.TEST) {
        extraParams += TEST_MODE_PARAM;
        console.log("Test mode enabled, adding param:", TEST_MODE_PARAM);
      }

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingRuleIds,
        addRules: [
          {
            id: 1,
            priority: 1,
            action: {
              type: "redirect",
              redirect: {
                regexSubstitution: proxyUrl + "\\0" + extraParams,
              },
            },
            condition: {
              initiatorDomains: ["twitch.tv"],
              regexFilter: "^https://usher\\.ttvnw\\.net/.*",
              resourceTypes: [
                "xmlhttprequest",
                "media"
              ],
            },
          },
        ],
      });
      console.log(`Proxy rules enabled with ${proxyUrl} (mode: ${currentMode})`);
    } else {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingRuleIds,
      });
      console.log("Proxy rules disabled");
    }
  } catch (error) {
    console.error("Error updating proxy rules:", error);
  }
}

async function checkAndUpdateProxy() {
  if (proxyCheckInProgress) return;

  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL) {
    if (currentProxyUrl) {
      return;
    }
  }

  proxyCheckInProgress = true;
  lastCheckTime = now;
  proxyStatus = 'checking';

  try {
    await loadMode();

    const availableProxy = await findAvailableProxy();

    if (availableProxy) {
      currentProxyUrl = availableProxy;
      proxyStatus = 'connected';
      await updateProxyRules(true, availableProxy);
    } else {
      currentProxyUrl = null;
      proxyStatus = 'unavailable';
      await updateProxyRules(false, null);
    }
  } catch (error) {
    proxyStatus = 'error';
    console.error('Error in checkAndUpdateProxy:', error);
  } finally {
    proxyCheckInProgress = false;
  }
}

let proxyStatus = 'unknown'; // 'connected', 'checking', 'error', 'unavailable'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'modeChanged') {
    console.log(`Mode changed to: ${message.mode}`);
    currentMode = message.mode;
    currentProxyUrl = null;
    lastCheckTime = 0;
    proxyStatus = 'checking';
    checkAndUpdateProxy();
    sendResponse({ success: true });
  } else if (message.type === 'getProxyStatus') {
    sendResponse({
      proxyUrl: currentProxyUrl,
      status: proxyStatus,
      mode: currentMode
    });
  }
  return true;
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.proxyMode) {
    console.log(`Storage mode changed: ${changes.proxyMode.oldValue} -> ${changes.proxyMode.newValue}`);
    currentMode = changes.proxyMode.newValue;
    currentProxyUrl = null;
    lastCheckTime = 0;
    checkAndUpdateProxy();
  }
});

chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
  if (details.url.includes("https://twitch.tv") || details.url.includes("https://www.twitch.tv")) {
    checkAndUpdateProxy();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadMode();
  checkAndUpdateProxy();
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadMode();
  checkAndUpdateProxy();
});

loadMode().then(() => {
  console.log(`Twitch proxy service worker initialized (mode: ${currentMode})`);
});
