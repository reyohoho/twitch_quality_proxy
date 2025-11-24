const api = typeof browser !== 'undefined' ? browser : chrome;

const PROXY_SERVERS = [
  "https://proxy4.rte.net.ru/",
  "https://proxy7.rte.net.ru/",
  "https://proxy5.rte.net.ru/",
  "https://proxy6.rte.net.ru/"
];

const PROXY_CHECK_TIMEOUT = 3000;

let currentProxyUrl = null;
let proxyCheckInProgress = false;
let lastProxyStatus = null;
let lastCheckTime = 0;
const CHECK_INTERVAL = 5000;
let proxyListener = null;

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

function createProxyListener(authToken = "") {
  return function(details) {
    console.log("Proxy listener triggered for:", details.url);
    const originalUrl = details.url;
    const proxyUrl = currentProxyUrl || PROXY_SERVERS[0];
    const redirectUrl = proxyUrl + originalUrl + authToken;
    console.log(`Using proxy: ${proxyUrl}`);
    
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
      try {
        const cookie = await api.cookies.get({
          url: "https://twitch.tv",
          name: "auth-token"
        });
        if (cookie && cookie.value) {
          authToken = "&auth=" + cookie.value;
          console.log("Auth token retrieved from twitch.tv cookies: ", authToken);
        } else {
          console.log("Auth token not found in twitch.tv cookies");
        }
      } catch (error) {
        console.error("Error retrieving auth token:", error);
      }

      proxyListener = createProxyListener(authToken);
      api.webRequest.onBeforeRequest.addListener(
        proxyListener,
        {
          urls: ["https://usher.ttvnw.net/*"]
        },
        ["blocking"]
      );
      console.log("Proxy listener enabled with auth token");
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
    console.log("Check interval not reached, skipping. Time since last check:", now - lastCheckTime);
    return;
  }

  proxyCheckInProgress = true;
  lastCheckTime = now;

  try {
    const availableProxy = await findAvailableProxy();
    currentProxyUrl = availableProxy;
    
    if (availableProxy === null) {
      console.log("All proxies unavailable, disabling proxy");
      lastProxyStatus = false;
      await updateProxyRules(false);
    } else {
      console.log(`Using proxy: ${availableProxy}`);
      lastProxyStatus = true;
      await updateProxyRules(true);
    }
  } finally {
    proxyCheckInProgress = false;
  }
}

if (api.webNavigation) {
  api.webNavigation.onBeforeNavigate.addListener(function (details) {
    console.log("webNavigation.onBeforeNavigate triggered:", details.url);
    if (details.url.includes("twitch.tv") || details.url.includes("www.twitch.tv")) {
      console.log("Twitch usher URL detected, checking proxy");
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
  api.runtime.onStartup.addListener(() => {
    console.log("Extension startup detected");
    checkAndUpdateProxy();
  });
}

if (api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener(() => {
    console.log("Extension installed/updated");
    checkAndUpdateProxy();
  });
}

console.log("Twitch proxy service worker initialized");
checkAndUpdateProxy();
