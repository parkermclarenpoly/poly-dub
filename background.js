const POLYMARKET_URL_PATTERN = /^https?:\/\/([^/]+\.)?polymarket\.com(?:\/|$)/i;
const POLY_DUB_API_URL = "https://poly-dub-api.vercel.app/api/create-link";
const POLY_DUB_ACCESS_TOKEN = "__POLY_DUB_ACCESS_TOKEN__";
const TAG_MENU_PREFIX = "poly-dub-tag:";
const TAG_PICKER_PATH = "popup.html";
const STORAGE_DEFAULTS = {
  defaultTag: "",
  dubApiKey: "",
  dubTagName: "",
  dubTags: [],
  tagSelectionMode: "default",
};

chrome.runtime.onInstalled.addListener(({ reason }) => {
  initializeExtension().then(() => {
    if (reason === "install") chrome.runtime.openOptionsPage();
  }).catch((error) => console.error("Poly Dub setup failed:", error));
});

chrome.runtime.onStartup.addListener(() => {
  initializeExtension().catch((error) => console.error("Poly Dub startup failed:", error));
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "local") return;
  syncExtensionUi().catch((error) => console.error("Poly Dub settings sync failed:", error));
});

chrome.action.onClicked.addListener(async (tab) => {
  await runLinkAction(tab).catch((error) => handleActionError(tab, error));
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!String(info.menuItemId).startsWith(TAG_MENU_PREFIX)) return;
  const tagName = decodeURIComponent(String(info.menuItemId).slice(TAG_MENU_PREFIX.length));
  await runLinkAction(tab, tagName).catch((error) => handleActionError(tab, error));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "POLY_DUB_CREATE_WITH_TAG") return undefined;

  chrome.tabs.get(message.tabId)
    .then((tab) => runLinkAction(tab, message.tagName))
    .then(() => sendResponse({ ok: true }))
    .catch(async (error) => {
      const tab = await chrome.tabs.get(message.tabId).catch(() => null);
      await handleActionError(tab, error);
      sendResponse({ ok: false, error: getErrorMessage(error) });
    });
  return true;
});

async function initializeExtension() {
  await migrateLegacySettings();
  await syncExtensionUi();
}

async function migrateLegacySettings() {
  const raw = await chrome.storage.local.get(STORAGE_DEFAULTS);
  const settings = normalizeSettings(raw);
  await chrome.storage.local.set({
    defaultTag: settings.defaultTag,
    dubTags: settings.dubTags,
    tagSelectionMode: settings.tagSelectionMode,
  });
  await chrome.storage.local.remove(["accessToken", "dubApiKey", "dubTagName"]);
}

async function syncExtensionUi() {
  const settings = normalizeSettings(await chrome.storage.local.get(STORAGE_DEFAULTS));
  const shouldAsk = settings.tagSelectionMode === "ask" && settings.dubTags.length > 1;
  await chrome.action.setPopup({ popup: shouldAsk ? TAG_PICKER_PATH : "" });

  await chrome.contextMenus.removeAll();
  if (shouldAsk) return;

  for (const tagName of settings.dubTags) {
    if (tagName === settings.defaultTag) continue;
    chrome.contextMenus.create({
      contexts: ["action"],
      id: `${TAG_MENU_PREFIX}${encodeURIComponent(tagName)}`,
      title: `Create link with ${tagName}`,
    });
  }
}

async function runLinkAction(tab, requestedTag = "") {
  if (!tab?.id || !POLYMARKET_URL_PATTERN.test(tab.url || "")) {
    await showBadge("POLY", "#667085");
    return;
  }

  const settings = normalizeSettings(await chrome.storage.local.get(STORAGE_DEFAULTS));
  const tagName = String(requestedTag || settings.defaultTag).trim();

  if (!tagName) {
    await showBadge("SET", "#175cd3");
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (!settings.dubTags.includes(tagName)) {
    throw new Error("That tag is no longer saved. Reopen Poly Dub settings.");
  }

  await chrome.scripting.executeScript({
    files: ["content-script.js"],
    target: { tabId: tab.id },
  });

  const page = await chrome.tabs.sendMessage(tab.id, { type: "POLY_DUB_GET_PAGE" });
  if (!page?.ok || !page.url) {
    throw new Error(page?.error || "Could not read the Polymarket page");
  }

  const response = await fetch(POLY_DUB_API_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${POLY_DUB_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      tagName,
      title: page.title ? String(page.title).slice(0, 190) : undefined,
      url: page.url,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(getApiErrorMessage(data) || `Poly Dub returned HTTP ${response.status}`);
  }
  if (!data.shortLink) throw new Error("Dub did not return a short link");

  const copied = await chrome.tabs.sendMessage(tab.id, {
    shortLink: data.shortLink,
    tagName,
    type: "POLY_DUB_COPY_LINK",
  });
  if (!copied?.ok) throw new Error(copied?.error || "Could not copy the Dub link");

  await showBadge("OK", "#039855");
}

function normalizeSettings(raw) {
  const legacyTag = String(raw.dubTagName || "").trim();
  const tags = Array.isArray(raw.dubTags) ? raw.dubTags : [];
  const dubTags = [...new Set(tags.map((tag) => String(tag || "").trim()).filter(Boolean))];
  if (legacyTag && !dubTags.includes(legacyTag)) dubTags.push(legacyTag);

  const requestedDefault = String(raw.defaultTag || legacyTag).trim();
  const defaultTag = dubTags.includes(requestedDefault) ? requestedDefault : (dubTags[0] || "");
  return {
    defaultTag,
    dubTags,
    tagSelectionMode: raw.tagSelectionMode === "ask" ? "ask" : "default",
  };
}

function getApiErrorMessage(data) {
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.error?.message === "string") return data.error.message;
  if (typeof data?.message === "string") return data.message;
  return "";
}

async function handleActionError(tab, error) {
  console.error("Poly Dub failed:", error);
  await showBadge("ERR", "#d92d20");
  await showPageError(tab, error);
}

async function showPageError(tab, error) {
  if (!tab?.id || !POLYMARKET_URL_PATTERN.test(tab.url || "")) return;
  try {
    await chrome.scripting.executeScript({
      files: ["content-script.js"],
      target: { tabId: tab.id },
    });
    await chrome.tabs.sendMessage(tab.id, {
      message: getErrorMessage(error),
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

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Could not create Dub link");
}
