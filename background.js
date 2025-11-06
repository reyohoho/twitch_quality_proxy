const PROXY_DOMAINS = [
  "https://proxy4.rhhhhhhh.live/",
  "https://proxy7.rhhhhhhh.live/",
  "https://proxy5.rhhhhhhh.live/",
  "https://proxy6.rhhhhhhh.live/",

];

let proxyCheckInProgress = false;
let lastProxyStatus = null;
let lastCheckTime = 0;
const CHECK_INTERVAL = 5000;
const PROXY_TIMEOUT = 3000;

let currentProxyUrl = null;

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
      let authToken = "";
      try {
        const cookie = await chrome.cookies.get({
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

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingRuleIds,
        addRules: [
          {
            id: 1,
            priority: 1,
            action: {
              type: "redirect",
              redirect: {
                regexSubstitution: proxyUrl + "\\0" + authToken,
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
      console.log(`Proxy rules enabled with ${proxyUrl} and auth token`);
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

  try {
    const availableProxy = await findAvailableProxy();
    
    if (availableProxy) {
      currentProxyUrl = availableProxy;
      await updateProxyRules(true, availableProxy);
    } else {
      currentProxyUrl = null;
      await updateProxyRules(false, null);
    }
  } finally {
    proxyCheckInProgress = false;
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
  if (details.url.includes("https://twitch.tv") || details.url.includes("https://www.twitch.tv")) {
    checkAndUpdateProxy();
  }
});
chrome.runtime.onStartup.addListener(checkAndUpdateProxy);
chrome.runtime.onInstalled.addListener(checkAndUpdateProxy);

console.log("Twitch proxy service worker initialized");
