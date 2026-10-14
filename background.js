const POLYMARKET_URL_PATTERN = /^https:\/\/(?:www\.)?polymarket\.(?:com|us)(?:\/|$)/i;
const POLY_DUB_API_URL = "https://poly-dub-api.vercel.app/api/create-link";
const TAG_MENU_PREFIX = "poly-dub-tag:";
const TAG_PICKER_PATH = "popup.html";
const PENDING_CONFIRMATION_PREFIX = "poly-dub-pending:";
const inFlightActions = new Map();
const STORAGE_DEFAULTS = {
  defaultTag: "",
  dubApiKey: "",
  dubTagName: "",
  dubTags: [],
  tagSelectionMode: "default",
  sessionExpiresAt: 0,
  sessionToken: "",
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
  const settingsChanged = ["sessionToken", "sessionExpiresAt", "dubTags", "defaultTag"].some((key) => key in _changes);
  if (settingsChanged) {
    for (const action of inFlightActions.values()) action.valid = false;
  }
  const invalidation = settingsChanged ? clearPendingConfirmations() : Promise.resolve();
  return invalidation.then(syncExtensionUi).catch((error) => console.error("Poly Dub settings sync failed:", error));
});

chrome.action.onClicked.addListener(async (tab) => {
  await runLinkAction(tab).catch((error) => handleActionError(tab, error));
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!String(info.menuItemId).startsWith(TAG_MENU_PREFIX)) return;
  const tagName = decodeURIComponent(String(info.menuItemId).slice(TAG_MENU_PREFIX.length));
  await runLinkAction(tab, tagName).catch((error) => handleActionError(tab, error));
});

chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  return invalidateTabConfirmation(tabId).catch((error) => console.error("Could not invalidate Poly Dub confirmation:", error));
});
chrome.tabs.onRemoved?.addListener((tabId) => {
  return invalidateTabConfirmation(tabId).catch((error) => console.error("Could not clear Poly Dub confirmation:", error));
});

function pendingConfirmationKey(tabId) {
  return `${PENDING_CONFIRMATION_PREFIX}${tabId}`;
}

async function clearPendingConfirmations() {
  const stored = await chrome.storage.session.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(PENDING_CONFIRMATION_PREFIX));
  if (keys.length) await chrome.storage.session.remove(keys);
}

async function invalidateTabConfirmation(tabId) {
  const action = inFlightActions.get(tabId);
  if (action) action.valid = false;
  await chrome.storage.session.remove(pendingConfirmationKey(tabId));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let action;
  let tabId;
  if (message?.type === "POLY_DUB_CREATE_WITH_TAG") {
    tabId = message.tabId;
    action = chrome.tabs.get(tabId).then((tab) => runLinkAction(tab, message.tagName));
  } else if (message?.type === "POLY_DUB_CONFIRM_DEFI_ONLY") {
    tabId = sender.tab?.id;
    action = confirmDefiOnly(message.requestId, sender);
  } else {
    return undefined;
  }
  action.then(sendResponse).catch(async (error) => {
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
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
    return { ok: false, error: "Open a Polymarket DeFi or US page first." };
  }
  if (inFlightActions.has(tab.id)) return { ok: true, pending: true, inProgress: true };

  // A fresh action always starts without consent from an earlier request.
  const action = { sourceUrl: tab.url, valid: true };
  inFlightActions.set(tab.id, action);
  try {
    await chrome.storage.session.remove(pendingConfirmationKey(tab.id));
    const settings = normalizeSettings(await chrome.storage.local.get(STORAGE_DEFAULTS));
    const tagName = String(requestedTag || settings.defaultTag).trim();
    await validateActionSettings(settings, tagName);
    await chrome.scripting.executeScript({ files: ["content-script.js"], target: { tabId: tab.id } });
    await chrome.tabs.sendMessage(tab.id, { type: "POLY_DUB_CLEAR_CONFIRMATION" });
    const page = await chrome.tabs.sendMessage(tab.id, { type: "POLY_DUB_GET_PAGE" });
    if (!page?.ok || !page.url) throw new Error(page?.error || "Could not read the Polymarket page");
    if (page.url !== action.sourceUrl) throw new Error("The page changed. Click Poly Dub again on the current market.");
    const payload = {
      description: page.description ? String(page.description).slice(0, 240) : undefined,
      tagName,
      title: page.title ? String(page.title).slice(0, 120) : undefined,
      url: page.url,
    };
    return await submitLink(tab.id, action, payload, settings.sessionToken, false);
  } finally {
    inFlightActions.delete(tab.id);
  }
}

async function validateActionSettings(settings, tagName) {
  if (!tagName) {
    await showBadge("SET", "#175cd3");
    await chrome.runtime.openOptionsPage();
    throw new Error("Save a Dub tag in Poly Dub settings first.");
  }
  if (!settings.sessionToken || settings.sessionExpiresAt <= Date.now()) {
    await chrome.storage.local.remove(["sessionExpiresAt", "sessionToken"]);
    await showBadge("LOGIN", "#175cd3");
    await chrome.runtime.openOptionsPage();
    throw new Error("Sign in to Poly Dub again.");
  }
  if (!settings.dubTags.includes(tagName)) throw new Error("That tag is no longer saved. Reopen Poly Dub settings.");
}

async function assertCurrentAction(tabId, action) {
  const current = await chrome.tabs.get(tabId);
  if (!action.valid || current.url !== action.sourceUrl) {
    throw new Error("The page changed. Click Poly Dub again on the current market.");
  }
}

async function confirmDefiOnly(requestId, sender) {
  const tabId = sender.tab?.id;
  if (!tabId || sender.frameId !== 0 || sender.id !== chrome.runtime.id || !sender.url) {
    throw new Error("This confirmation is no longer valid. Click Poly Dub again.");
  }
  // Lock synchronously before storage awaits so duplicate messages cannot both
  // consume the same persisted nonce after the service worker wakes up.
  if (inFlightActions.has(tabId)) throw new Error("A link is already being created in this tab.");
  const action = { sourceUrl: sender.url, valid: true };
  inFlightActions.set(tabId, action);
  try {
    const key = pendingConfirmationKey(tabId);
    const pending = (await chrome.storage.session.get(key))[key];
    if (!pending || pending.requestId !== requestId || sender.url !== pending.payload.url ||
        sender.tab.url !== pending.payload.url) {
      throw new Error("This confirmation is no longer valid. Click Poly Dub again.");
    }
    // Remove before any network submission. Session storage survives worker
    // suspension, keeps separate tab records, and stays extension-only.
    await chrome.storage.session.remove(key);
    await assertCurrentAction(tabId, action);
    const settings = normalizeSettings(await chrome.storage.local.get(STORAGE_DEFAULTS));
    await validateActionSettings(settings, pending.payload.tagName);
    if (settings.sessionToken !== pending.sessionToken) {
      throw new Error("Your session changed. Click Poly Dub again before confirming.");
    }
    return await submitLink(tabId, action, pending.payload, settings.sessionToken, true);
  } finally {
    inFlightActions.delete(tabId);
  }
}

async function submitLink(tabId, action, payload, sessionToken, allowDefiOnly) {
  await assertCurrentAction(tabId, action);
  // Streamed headers avoid Chrome's fetch response-header timeout. API activity
  // keeps the MV3 worker alive until the complete JSON body has arrived.
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20_000);
  let response;
  let data;
  try {
    response = await fetch(POLY_DUB_API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...payload, streamResponse: true, ...(allowDefiOnly ? { allowDefiOnly: true } : {}) }),
    });
    data = await response.json().catch(() => ({}));
  } finally {
    clearInterval(keepAlive);
  }
  const status = Number.isInteger(data.status) && data.status >= 200 && data.status <= 599
    ? data.status : response.status;
  await assertCurrentAction(tabId, action);
  if (status < 200 || status >= 300) {
    if (status === 409 && data.requiresDefiConfirmation === true && !allowDefiOnly) {
      const requestId = crypto.randomUUID();
      const key = pendingConfirmationKey(tabId);
      try {
        await chrome.storage.session.set({ [key]: { requestId, payload, sessionToken } });
        await assertCurrentAction(tabId, action);
        const displayed = await chrome.tabs.sendMessage(tabId, {
          type: "POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED",
          requestId,
          sourceUrl: payload.url,
          tagName: payload.tagName,
          message: getApiErrorMessage(data),
        });
        if (!displayed?.ok) throw new Error(displayed?.error || "Could not show the DeFi-only confirmation.");
      } catch (error) {
        await chrome.storage.session.remove(key);
        throw error;
      }
      await showBadge("ASK", "#b54708");
      return { ok: true, pending: true };
    }
    if (status === 401) {
      await chrome.storage.local.remove(["sessionExpiresAt", "sessionToken"]);
      await chrome.runtime.openOptionsPage();
    }
    throw new Error(getApiErrorMessage(data) || `Poly Dub returned HTTP ${status}`);
  }
  if (!data.shortLink) throw new Error("Dub did not return a short link");
  const copied = await chrome.tabs.sendMessage(tabId, {
    ogWorkaround: Boolean(data.ogWorkaround),
    routingMode: data.routingMode,
    shortLink: data.shortLink,
    tagName: payload.tagName,
    type: "POLY_DUB_COPY_LINK",
  });
  if (!copied?.ok) throw new Error(copied?.error || "Could not copy the Dub link");
  await showBadge(data.ogWorkaround ? "OG" : "OK", "#039855");
  return { ok: true, routingMode: data.routingMode };
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
    sessionExpiresAt: Number(raw.sessionExpiresAt) || 0,
    sessionToken: String(raw.sessionToken || ""),
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
