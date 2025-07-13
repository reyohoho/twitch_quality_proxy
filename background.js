const PROXY_URL = "https://proxy4.rhhhhhhh.live/";
const PROXY_CHECK_URL = "https://proxy4.rhhhhhhh.live/https://google.com";

let proxyCheckInProgress = false;
let lastProxyStatus = null;
let lastCheckTime = 0;
const CHECK_INTERVAL = 5000;

async function checkProxyAvailability() {
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

async function updateProxyRules(enable) {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingRuleIds = existingRules.map((rule) => rule.id);

    if (enable) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingRuleIds,
        addRules: [
          {
            id: 1,
            priority: 1,
            action: {
              type: "redirect",
              redirect: {
                regexSubstitution: PROXY_URL + "\\0",
              },
            },
            condition: {
              initiatorDomains: ["twitch.tv"],
              regexFilter: "^https://usher\\.ttvnw\\.net/.*",
              resourceTypes: [
                "main_frame",
                "sub_frame",
                "stylesheet",
                "script",
                "image",
                "font",
                "object",
                "xmlhttprequest",
                "ping",
                "csp_report",
                "media",
                "websocket",
                "other",
              ],
            },
          },
        ],
      });
      console.log("Proxy rules enabled");
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
    return;
  }

  proxyCheckInProgress = true;
  lastCheckTime = now;

  try {
    const isProxyAvailable = await checkProxyAvailability();

    if (isProxyAvailable !== lastProxyStatus) {
      lastProxyStatus = isProxyAvailable;
      await updateProxyRules(isProxyAvailable);
    }
  } finally {
    proxyCheckInProgress = false;
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
  if (details.url.includes("usher.ttvnw.net")) {
    checkAndUpdateProxy();
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    checkAndUpdateProxy();
  },
  { urls: ["https://usher.ttvnw.net/*"] },
  []
);

chrome.runtime.onStartup.addListener(checkAndUpdateProxy);
chrome.runtime.onInstalled.addListener(checkAndUpdateProxy);

console.log("Twitch proxy service worker initialized");
