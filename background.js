const api = typeof browser !== 'undefined' ? browser : chrome;

api.webRequest.onBeforeRequest.addListener(
  function(details) {
    const originalUrl = details.url;
    const redirectUrl = "https://proxy4.rhhhhhhh.live/" + originalUrl;
    
    return {
      redirectUrl: redirectUrl
    };
  },
  {
    urls: ["https://usher.ttvnw.net/*"]
  },
  ["blocking"]
); 