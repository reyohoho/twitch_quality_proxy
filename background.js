const api = typeof browser !== 'undefined' ? browser : chrome;

const PROXY_URL = "https://proxy4.rhhhhhhh.live/";
const PROXY_CHECK_URL = "https://proxy4.rhhhhhhh.live/https://google.com";

let proxyCheckInProgress = false;
let lastProxyStatus = null;
let lastCheckTime = 0;
const CHECK_INTERVAL = 5000;
let proxyListener = null;

async function checkProxyAvailability() {
  console.log("Starting proxy availability check...");
  try {
    const response = await fetch(PROXY_CHECK_URL, {
      method: "HEAD",
      mode: "cors",
    });

    const isAvailable = response.ok;
    console.log(
      `Proxy availability check: ${
        isAvailable ? "Available" : "Unavailable"
      } (${response.status})`
    );
    return isAvailable;
  } catch (error) {
    console.error("Proxy availability check failed:", error);
    return false;
  }
}

function createProxyListener() {
  return function(details) {
    console.log("Proxy listener triggered for:", details.url);
    const originalUrl = details.url;
    const redirectUrl = PROXY_URL + originalUrl;
    
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
      proxyListener = createProxyListener();
      api.webRequest.onBeforeRequest.addListener(
        proxyListener,
        {
          urls: ["https://usher.ttvnw.net/*"]
        },
        ["blocking"]
      );
      console.log("Proxy listener enabled");
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
    const isProxyAvailable = await checkProxyAvailability();

    if (isProxyAvailable !== lastProxyStatus) {
      console.log("Proxy status changed from", lastProxyStatus, "to", isProxyAvailable);
      lastProxyStatus = isProxyAvailable;
      await updateProxyRules(isProxyAvailable);
    } else {
      console.log("Proxy status unchanged:", isProxyAvailable);
    }
  } finally {
    proxyCheckInProgress = false;
  }
}

if (api.webNavigation) {
  api.webNavigation.onBeforeNavigate.addListener(function (details) {
    console.log("webNavigation.onBeforeNavigate triggered:", details.url);
    if (details.url.includes("usher.ttvnw.net")) {
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
    urls: ["https://usher.ttvnw.net/*"]
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
