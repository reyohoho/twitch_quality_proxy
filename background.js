const api = typeof browser !== 'undefined' ? browser : chrome;

const PROXY_SERVERS = [
  "https://proxy4.rte.net.ru/",
  "https://proxy7.rte.net.ru/",
  "https://proxy5.rte.net.ru/",
  "https://proxy6.rte.net.ru/"
];

const TEST_MODE_PARAM = "&proxymode=adblock";

const MODES = {
  OLD: 'old',
  TEST: 'test'
};

const PROXY_CHECK_TIMEOUT = 3000;

let currentProxyUrl = null;
let proxyCheckInProgress = false;
let lastCheckTime = 0;
const CHECK_INTERVAL = 5000;
let proxyListener = null;
let proxyStatus = 'unknown'; // 'connected', 'checking', 'error', 'unavailable'
let currentMode = MODES.OLD;

async function loadMode() {
  try {
    const result = await api.storage.local.get(['proxyMode']);
    if (result.proxyMode) {
      currentMode = result.proxyMode;
      console.log(`Loaded mode: ${currentMode}`);
    }
  } catch (e) {
    console.error('Error loading mode:', e);
  }
}

async function checkSingleProxy(proxyUrl) {
  console.log(`Checking proxy: ${proxyUrl}`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_CHECK_TIMEOUT);
    
    const checkUrl = proxyUrl + "https://google.com";
    const response = await fetch(checkUrl, {
      method: "HEAD",
      mode: "cors",
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    
    const isAvailable = response.ok;
    console.log(`Proxy ${proxyUrl} status: ${isAvailable ? "Available" : "Unavailable"} (${response.status})`);
    return isAvailable;
  } catch (error) {
    console.error(`Proxy ${proxyUrl} check failed:`, error.name, error.message);
    return false;
  }
}

async function findAvailableProxy() {
  console.log("Starting search for available proxy...");
  
  for (const proxyUrl of PROXY_SERVERS) {
    const isAvailable = await checkSingleProxy(proxyUrl);
    if (isAvailable) {
      console.log(`Found available proxy: ${proxyUrl}`);
      return proxyUrl;
    }
  }
  
  console.warn("No available proxy found, proxy will be disabled");
  return null;
}

function createProxyListener(authToken = "", extraParams = "") {
  return function(details) {
    console.log("Proxy listener triggered for:", details.url);
    const originalUrl = details.url;
    const proxyUrl = currentProxyUrl || PROXY_SERVERS[0];
    const redirectUrl = proxyUrl + originalUrl + authToken + extraParams;
    console.log(`Using proxy: ${proxyUrl} (mode: ${currentMode})`);
    
    return {
      redirectUrl: redirectUrl
    };
  };
}

async function updateProxyRules(enable) {
  console.log("Updating proxy rules, enable:", enable);
  try {
    if (proxyListener) {
      api.webRequest.onBeforeRequest.removeListener(proxyListener);
      proxyListener = null;
      console.log("Proxy listener removed");
    }

    if (enable) {
      let authToken = "";
      let extraParams = "";

      try {
        const cookie = await api.cookies.get({
          url: "https://twitch.tv",
          name: "auth-token"
        });
        if (cookie && cookie.value) {
          authToken = "&auth=" + cookie.value;
          console.log("Auth token retrieved from twitch.tv cookies");
        } else {
          console.log("Auth token not found in twitch.tv cookies");
        }
      } catch (error) {
        console.error("Error retrieving auth token:", error);
      }

      if (currentMode === MODES.TEST) {
        extraParams = TEST_MODE_PARAM;
        console.log("Test mode enabled, adding param:", TEST_MODE_PARAM);
      }

      proxyListener = createProxyListener(authToken, extraParams);
      api.webRequest.onBeforeRequest.addListener(
        proxyListener,
        {
          urls: ["https://usher.ttvnw.net/*"]
        },
        ["blocking"]
      );
      console.log(`Proxy listener enabled (mode: ${currentMode})`);
    }
  } catch (error) {
    console.error("Error updating proxy rules:", error);
  }
}

async function checkAndUpdateProxy() {
  console.log("checkAndUpdateProxy called, proxyCheckInProgress:", proxyCheckInProgress);
  
  if (proxyCheckInProgress) {
    console.log("Proxy check already in progress, skipping");
    return;
  }

  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL) {
    if (currentProxyUrl) {
      console.log("Check interval not reached and proxy exists, skipping");
      return;
    }
  }

  proxyCheckInProgress = true;
  lastCheckTime = now;
  proxyStatus = 'checking';

  try {
    await loadMode();
    
    const availableProxy = await findAvailableProxy();
    currentProxyUrl = availableProxy;
    
    if (availableProxy === null) {
      console.log("All proxies unavailable, disabling proxy");
      proxyStatus = 'unavailable';
      await updateProxyRules(false);
    } else {
      console.log(`Using proxy: ${availableProxy}`);
      proxyStatus = 'connected';
      await updateProxyRules(true);
    }
  } catch (error) {
    proxyStatus = 'error';
    console.error('Error in checkAndUpdateProxy:', error);
  } finally {
    proxyCheckInProgress = false;
  }
}

// Message listener for communication with content script
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

// Storage change listener
api.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.proxyMode) {
    console.log(`Storage mode changed: ${changes.proxyMode.oldValue} -> ${changes.proxyMode.newValue}`);
    currentMode = changes.proxyMode.newValue;
    currentProxyUrl = null;
    lastCheckTime = 0;
    checkAndUpdateProxy();
  }
});

if (api.webNavigation) {
  api.webNavigation.onBeforeNavigate.addListener(function (details) {
    console.log("webNavigation.onBeforeNavigate triggered:", details.url);
    if (details.url.includes("twitch.tv") || details.url.includes("www.twitch.tv")) {
      console.log("Twitch URL detected, checking proxy");
      checkAndUpdateProxy();
    }
  });
  console.log("webNavigation listener added");
} else {
  console.warn("webNavigation API not available");
}

api.webRequest.onBeforeRequest.addListener(
  function(details) {
    console.log("webRequest.onBeforeRequest triggered for proxy check:", details.url);
    checkAndUpdateProxy();
  },
  {
    urls: ["https://twitch.tv/*", "https://www.twitch.tv/*"]
  },
  []
);

if (api.runtime.onStartup) {
  api.runtime.onStartup.addListener(async () => {
    console.log("Extension startup detected");
    await loadMode();
    checkAndUpdateProxy();
  });
}

if (api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener(async () => {
    console.log("Extension installed/updated");
    await loadMode();
    checkAndUpdateProxy();
  });
}

loadMode().then(() => {
  console.log(`Twitch proxy service worker initialized (mode: ${currentMode})`);
  checkAndUpdateProxy();
});
