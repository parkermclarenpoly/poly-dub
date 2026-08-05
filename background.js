const POLYMARKET_URL_PATTERN = /^https?:\/\/([^/]+\.)?polymarket\.com(?:\/|$)/i;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await createAndCopyDubLink(tab);
  } catch (error) {
    console.error("Poly Dub failed:", error);
    await showBadge("ERR", "#d92d20");
    await showPageError(tab, error);
  }
});

async function createAndCopyDubLink(tab) {
  if (!tab?.id || !POLYMARKET_URL_PATTERN.test(tab.url || "")) {
    await showBadge("POLY", "#667085");
    return;
  }

  const settings = await chrome.storage.local.get({
    dubApiKey: "",
    dubTagName: "",
  });
  const token = String(settings.dubApiKey || "").trim();
  const tagName = String(settings.dubTagName || "").trim();

  if (!token || !tagName) {
    await showBadge("SET", "#175cd3");
    await chrome.runtime.openOptionsPage();
    return;
  }

  await chrome.scripting.executeScript({
    files: ["content-script.js"],
    target: { tabId: tab.id },
  });

  const page = await chrome.tabs.sendMessage(tab.id, {
    type: "POLY_DUB_GET_PAGE",
  });
  if (!page?.ok || !page.url) {
    throw new Error(page?.error || "Could not read the Polymarket page");
  }

  const body = {
    tagNames: tagName,
    title: page.title ? String(page.title).slice(0, 190) : undefined,
    url: page.url,
  };
  const response = await fetch("https://api.dub.co/links", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(getDubErrorMessage(data) || `Dub returned HTTP ${response.status}`);
  }
  if (!data.shortLink) {
    throw new Error("Dub did not return a short link");
  }

  const copied = await chrome.tabs.sendMessage(tab.id, {
    shortLink: data.shortLink,
    tagName,
    type: "POLY_DUB_COPY_LINK",
  });
  if (!copied?.ok) {
    throw new Error(copied?.error || "Could not copy the Dub link");
  }

  await showBadge("OK", "#039855");
}

function getDubErrorMessage(data) {
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.error?.message === "string") return data.error.message;
  if (typeof data?.message === "string") return data.message;
  return "";
}

async function showPageError(tab, error) {
  if (!tab?.id || !POLYMARKET_URL_PATTERN.test(tab.url || "")) return;
  try {
    await chrome.scripting.executeScript({
      files: ["content-script.js"],
      target: { tabId: tab.id },
    });
    await chrome.tabs.sendMessage(tab.id, {
      message: error instanceof Error ? error.message : "Could not create Dub link",
      type: "POLY_DUB_SHOW_ERROR",
    });
  } catch (displayError) {
    console.error("Could not show Poly Dub error:", displayError);
  }
}

async function showBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1800);
}
