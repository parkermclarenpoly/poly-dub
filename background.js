const POLY_LINKS_API_URL = "https://dub-links-nine.vercel.app/api/v1/links";
const ACCOUNT_MENU_PREFIX = "poly-dub-account:";
const PENDING_CONFIRMATION_PREFIX = "poly-dub-pending:";
const REQUEST_PREFIX = "poly-dub-request:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTINGS_KEYS = ["polyLinksApiKey", "polyLinksAccounts", "defaultAccountId", "accountSelectionMode"];
const STORAGE_DEFAULTS = { polyLinksApiKey: "", polyLinksAccounts: [], defaultAccountId: "", accountSelectionMode: "default" };
const inFlightActions = new Map();
const activeRequests = new Set();
// storage.local otherwise permits content-script access. The personal key must
// remain within extension pages and the worker, including after browser restart.
const trustedStorageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(() => true, () => false);

chrome.runtime.onInstalled.addListener(({ reason }) => initializeExtension().then(async (settings) => {
  if (reason === "install" || !hasConfiguration(settings)) await chrome.runtime.openOptionsPage();
}).catch(() => console.error("Poly Dub setup could not finish.")));
chrome.runtime.onStartup.addListener(() => initializeExtension().catch(() => console.error("Poly Dub startup could not finish.")));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !SETTINGS_KEYS.some(key => key in changes)) return;
  for (const action of inFlightActions.values()) action.valid = false;
  // Pending provider writes are deliberately retained. A key or account change
  // cannot turn an unconfirmed creation into a fresh creation with another key.
  return clearPendingConfirmations().then(syncExtensionUi).catch(() => console.error("Poly Dub settings could not refresh."));
});
chrome.action.onClicked.addListener(async (tab) => runLinkAction(tab).catch(error => handleActionError(tab, error)));
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!String(info.menuItemId).startsWith(ACCOUNT_MENU_PREFIX)) return;
  const accountId = String(info.menuItemId).slice(ACCOUNT_MENU_PREFIX.length);
  await runLinkAction(tab, accountId).catch(error => handleActionError(tab, error));
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "loading") return invalidateTabConfirmation(tabId);
});
chrome.tabs.onRemoved.addListener(invalidateTabConfirmation);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let action, tabId;
  if (message?.type === "POLY_DUB_CREATE_WITH_ACCOUNT") {
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("popup.html")) return;
    tabId = message.tabId;
    action = chrome.tabs.get(tabId).then(tab => runLinkAction(tab, message.accountId));
  } else if (message?.type === "POLY_DUB_CONFIRM_DEFI_ONLY") {
    tabId = sender.tab?.id;
    action = confirmDefiOnly(message.requestId, sender);
  } else return;
  action.then(sendResponse).catch(async (error) => {
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    await handleActionError(tab, error);
    sendResponse({ ok: false, error: getErrorMessage(error) });
  });
  return true;
});

async function requireTrustedStorage() {
  if (!await trustedStorageReady) throw new Error("Chrome could not protect your API key. Restart the extension before continuing.");
}
async function initializeExtension() {
  await requireTrustedStorage();
  await syncExtensionUi();
  return getSettings();
}
async function getSettings() {
  await requireTrustedStorage();
  return normalizeSettings(await chrome.storage.local.get(STORAGE_DEFAULTS));
}
function hasConfiguration(settings) { return Boolean(settings.polyLinksApiKey && settings.polyLinksAccounts.some(account => account.id === settings.defaultAccountId)); }
async function syncExtensionUi() {
  const settings = await getSettings();
  const shouldAsk = settings.accountSelectionMode === "ask" && settings.polyLinksAccounts.length > 1;
  await chrome.action.setPopup({ popup: shouldAsk ? "popup.html" : "" });
  await chrome.contextMenus.removeAll();
  if (shouldAsk) return;
  for (const account of settings.polyLinksAccounts) {
    if (account.id !== settings.defaultAccountId) chrome.contextMenus.create({ contexts: ["action"], id: `${ACCOUNT_MENU_PREFIX}${account.id}`, title: `Create link with ${accountLabel(account)}` });
  }
}
function normalizeSettings(raw) {
  const seen = new Set();
  const accounts = Array.isArray(raw.polyLinksAccounts) ? raw.polyLinksAccounts.filter(account => {
    if (!account || typeof account.id !== "string" || !UUID.test(account.id) || typeof account.username !== "string" || typeof account.platform !== "string" || seen.has(account.id)) return false;
    seen.add(account.id); return true;
  }).map(account => ({ id: account.id, username: account.username, platform: account.platform })) : [];
  return { polyLinksApiKey: typeof raw.polyLinksApiKey === "string" ? raw.polyLinksApiKey.trim() : "", polyLinksAccounts: accounts, defaultAccountId: typeof raw.defaultAccountId === "string" ? raw.defaultAccountId : "", accountSelectionMode: raw.accountSelectionMode === "ask" ? "ask" : "default" };
}
function accountLabel(account) { return `${account.username} (${account.platform})`; }
function supportedUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && ["polymarket.com", "www.polymarket.com", "polymarket.us", "www.polymarket.us"].includes(url.hostname); }
  catch { return false; }
}
function isDefiUrl(value) { return ["polymarket.com", "www.polymarket.com"].includes(new URL(value).hostname); }
async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function validateActionSettings(settings, requestedId) {
  if (!settings.polyLinksApiKey || !requestedId) {
    await showBadge("SET", "#175cd3"); await chrome.runtime.openOptionsPage();
    throw new Error("Connect your personal PolyLinks API key and select an account in settings first.");
  }
  const account = settings.polyLinksAccounts.find(item => item.id === requestedId);
  if (!account) { await chrome.runtime.openOptionsPage(); throw new Error("That account is no longer saved. Refresh accounts in Poly Dub settings."); }
  return account;
}
async function assertCurrentAction(tabId, action) {
  const tab = await chrome.tabs.get(tabId);
  if (!action.valid || tab.url !== action.sourceUrl) throw new Error("The page or settings changed. Click Poly Dub again on the current market.");
  const settings = await getSettings();
  if (!settings.polyLinksAccounts.some(account => account.id === action.accountId) || await digest(settings.polyLinksApiKey) !== action.credentialDigest) {
    action.valid = false;
    throw new Error("Your account or API key changed. Click Poly Dub again before continuing.");
  }
}
async function runLinkAction(tab, requestedAccountId) {
  if (!tab?.id || !supportedUrl(tab.url)) { await showBadge("POLY", "#667085"); return { ok: false, error: "Open a Polymarket DeFi or US page first." }; }
  if (inFlightActions.has(tab.id)) return { ok: true, pending: true, inProgress: true };
  const action = { sourceUrl: tab.url, valid: true };
  inFlightActions.set(tab.id, action);
  try {
    await requireTrustedStorage();
    await chrome.storage.session.remove(pendingConfirmationKey(tab.id));
    const settings = await getSettings();
    const account = await validateActionSettings(settings, requestedAccountId || settings.defaultAccountId);
    action.accountId = account.id;
    action.credentialDigest = await digest(settings.polyLinksApiKey);
    await chrome.scripting.executeScript({ files: ["content-script.js"], target: { tabId: tab.id } });
    await chrome.tabs.sendMessage(tab.id, { type: "POLY_DUB_CLEAR_CONFIRMATION" });
    const page = await chrome.tabs.sendMessage(tab.id, { type: "POLY_DUB_GET_PAGE" });
    if (!page?.ok || page.url !== action.sourceUrl) throw new Error("The page changed. Click Poly Dub again on the current market.");
    const body = { account_id: account.id, destination: action.sourceUrl, require_routing: true };
    return await createOrResumeRequest(tab.id, action, body, settings.polyLinksApiKey, accountLabel(account));
  } finally { inFlightActions.delete(tab.id); }
}
function pendingConfirmationKey(tabId) { return `${PENDING_CONFIRMATION_PREFIX}${tabId}`; }
async function clearPendingConfirmations() {
  const stored = await chrome.storage.session.get(null);
  const keys = Object.keys(stored).filter(key => key.startsWith(PENDING_CONFIRMATION_PREFIX));
  if (keys.length) await chrome.storage.session.remove(keys);
}
async function invalidateTabConfirmation(tabId) {
  const action = inFlightActions.get(tabId);
  if (action) action.valid = false;
  await chrome.storage.session.remove(pendingConfirmationKey(tabId));
}
async function confirmDefiOnly(requestId, sender) {
  const tabId = sender.tab?.id;
  if (!tabId || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.url) throw new Error("This confirmation is no longer valid. Click Poly Dub again.");
  if (inFlightActions.has(tabId)) throw new Error("A link is already being created in this tab.");
  const action = { sourceUrl: sender.url, valid: true };
  inFlightActions.set(tabId, action);
  try {
    await requireTrustedStorage();
    const key = pendingConfirmationKey(tabId);
    const pending = (await chrome.storage.session.get(key))[key];
    if (!pending || pending.requestId !== requestId || pending.body.destination !== sender.url || sender.tab.url !== sender.url || !supportedUrl(sender.url) || !isDefiUrl(sender.url)) throw new Error("This confirmation is no longer valid. Click Poly Dub again.");
    await chrome.storage.session.remove(key);
    const settings = await getSettings();
    const account = await validateActionSettings(settings, pending.body.account_id);
    action.accountId = account.id;
    action.credentialDigest = await digest(settings.polyLinksApiKey);
    if (action.credentialDigest !== pending.credentialDigest) throw new Error("Your API key changed. Click Poly Dub again before confirming.");
    await assertCurrentAction(tabId, action);
    return await createOrResumeRequest(tabId, action, { ...pending.body, allow_defi_only: true }, settings.polyLinksApiKey, accountLabel(account));
  } finally { inFlightActions.delete(tabId); }
}

async function createOrResumeRequest(tabId, action, body, apiKey, label) {
  const key = `${REQUEST_PREFIX}${await digest(`${body.account_id}\n${new URL(body.destination).href}`)}`;
  if (activeRequests.has(key)) return { ok: true, pending: true, inProgress: true };
  activeRequests.add(key);
  try {
    await assertCurrentAction(tabId, action);
    let record = (await chrome.storage.local.get(key))[key];
    const resumed = Boolean(record);
    if (record) {
      validateSavedRequest(record, body);
      if (record.credentialDigest !== action.credentialDigest) throw new Error(`A previous request for this account and market is tied to another API key. Restore the original key or ask an admin to reconcile it before creating again.${requestReference(record)}`);
      if (record.state === "completed") return await copyCompletedRequest(tabId, action, key, record, label);
      // A manual retry always replays the saved body, including already accepted
      // DeFi-only consent, rather than silently creating another identity.
    } else {
      record = { idempotencyKey: crypto.randomUUID(), body, credentialDigest: action.credentialDigest, state: "pending", createdAt: Date.now() };
      await chrome.storage.local.set({ [key]: record });
    }
    return await submitRequest(tabId, action, key, record, apiKey, label, resumed);
  } finally { activeRequests.delete(key); }
}
function validateSavedRequest(record, expected) {
  if (!record || !UUID.test(record.idempotencyKey) || !/^[0-9a-f]{64}$/.test(record.credentialDigest) || !["pending", "completed"].includes(record.state) || record.body?.account_id !== expected.account_id || typeof record.body?.destination !== "string" || new URL(record.body.destination).href !== new URL(expected.destination).href || record.body.require_routing !== true || (record.body.allow_defi_only !== undefined && record.body.allow_defi_only !== true)) {
    throw new Error("A saved request for this account and market needs review. Do not clear extension storage or create another link; ask an admin to reconcile it.");
  }
}
function requestReference(record) { return ` Request: ${record.requestId || record.idempotencyKey}.`; }
function unknownOutcomeMessage(record) { return `Link creation is not yet confirmed. Click Poly Dub again on this account and market to check the same request. If it remains pending, ask an admin to reconcile it; do not clear extension storage.${requestReference(record)}`; }
function extractRequestId(data) {
  const value = data?.request_id || data?.error?.request_id;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
function validSuccess(data, record) {
  if (!extractRequestId(data) || data?.data?.account_id !== record.body.account_id || typeof data.data.destination !== "string") return false;
  try {
    if (new URL(data.data.destination).href !== new URL(record.body.destination).href) return false;
    if (data.data.routing_mode !== "regional" && !(data.data.routing_mode === "defi_only" && record.body.allow_defi_only === true && isDefiUrl(record.body.destination))) return false;
    const link = new URL(data.data.short_link);
    return link.href === data.data.short_link && link.protocol === "https:" && link.hostname === "polymarket.com" && !link.username && !link.password && !link.port && !link.search && !link.hash && /^\/r\/[A-Za-z0-9_-]{1,128}$/.test(link.pathname);
  } catch { return false; }
}
function definitiveFailure(status, data, resumed) {
  const code = data?.error?.code;
  if (["request_pending", "idempotency_conflict"].includes(code)) return false;
  // Authentication/account admission runs before replay lookup. A new 401/403
  // cannot establish what happened to an earlier, unconfirmed write.
  if (extractRequestId(data) && ["defi_confirmation_required", "routing_unavailable", "invalid_slug", "slug_conflict", "provider_unavailable"].includes(code)) return true;
  return !resumed && status >= 400 && status < 500 && typeof code === "string";
}
async function submitRequest(tabId, action, key, record, apiKey, label, resumed) {
  await assertCurrentAction(tabId, action);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  let response, data;
  try {
    response = await fetch(POLY_LINKS_API_URL, { method: "POST", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "Idempotency-Key": record.idempotencyKey, "X-PolyLinks-Stream": "1" }, body: JSON.stringify(record.body) });
    data = await response.json();
  } catch { throw new Error(unknownOutcomeMessage(record)); }
  finally { clearInterval(keepAlive); }
  const status = response.status === 200 && Number.isInteger(data?.status) && data.status >= 200 && data.status <= 599 ? data.status : response.status;
  const receivedId = extractRequestId(data);
  if (record.requestId && receivedId && receivedId !== record.requestId) throw new Error(unknownOutcomeMessage(record));
  if (receivedId) { record.requestId = receivedId; await chrome.storage.local.set({ [key]: record }); }
  if (status === 201 && validSuccess(data, record)) {
    record.state = "completed";
    record.result = { request_id: data.request_id, data: { account_id: data.data.account_id, destination: data.data.destination, short_link: data.data.short_link, routing_mode: data.data.routing_mode } };
    await chrome.storage.local.set({ [key]: record });
    return await copyCompletedRequest(tabId, action, key, record, label);
  }
  if (status < 400 || !definitiveFailure(status, data, resumed)) {
    if (status === 401 || status === 403) await chrome.runtime.openOptionsPage();
    throw new Error(unknownOutcomeMessage(record));
  }
  await chrome.storage.local.remove(key);
  if (status === 422 && data?.error?.code === "defi_confirmation_required" && !record.body.allow_defi_only && isDefiUrl(record.body.destination)) {
    await assertCurrentAction(tabId, action);
    const confirmationKey = pendingConfirmationKey(tabId), nonce = crypto.randomUUID();
    try {
      await chrome.storage.session.set({ [confirmationKey]: { requestId: nonce, body: record.body, credentialDigest: record.credentialDigest } });
      await assertCurrentAction(tabId, action);
      const displayed = await chrome.tabs.sendMessage(tabId, { type: "POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED", requestId: nonce, sourceUrl: action.sourceUrl, accountLabel: label, message: "No verified US destination is available for this market." });
      if (!displayed?.ok) throw new Error("Could not show the DeFi-only confirmation. Click Poly Dub again.");
    } catch (error) { await chrome.storage.session.remove(confirmationKey); throw error; }
    await showBadge("ASK", "#b54708");
    return { ok: true, pending: true };
  }
  if (status === 401) { await chrome.runtime.openOptionsPage(); throw new Error("Your PolyLinks API key is invalid or revoked. Connect an active personal API key in settings."); }
  if (status === 403) { await chrome.runtime.openOptionsPage(); throw new Error("This account is no longer available to your API key. Refresh accounts in Poly Dub settings."); }
  if (status === 429) throw new Error("Your PolyLinks API link limit has been reached. Check your daily or monthly quota in PolyLinks before trying again.");
  const message = typeof data?.error?.message === "string" ? data.error.message.split(apiKey).join("[redacted]").slice(0, 600) : "PolyLinks could not create this link.";
  throw new Error(message);
}
async function copyCompletedRequest(tabId, action, key, record, label) {
  if (!validSuccess(record.result, record)) throw new Error(unknownOutcomeMessage(record));
  await assertCurrentAction(tabId, action);
  const copied = await chrome.tabs.sendMessage(tabId, { type: "POLY_DUB_COPY_LINK", sourceUrl: action.sourceUrl, accountLabel: label, shortLink: record.result.data.short_link, routingMode: record.result.data.routing_mode });
  if (!copied?.ok) throw new Error(copied?.error || "The link was created but could not be copied. Click Poly Dub again to copy the same link.");
  await chrome.storage.local.remove(key);
  await showBadge("OK", "#039855");
  return { ok: true, routingMode: record.result.data.routing_mode };
}
async function handleActionError(tab, error) {
  await showBadge("ERR", "#d92d20");
  if (!tab?.id || !supportedUrl(tab.url)) return;
  try {
    await chrome.scripting.executeScript({ files: ["content-script.js"], target: { tabId: tab.id } });
    await chrome.tabs.sendMessage(tab.id, { type: "POLY_DUB_SHOW_ERROR", message: getErrorMessage(error) });
  } catch { /* A closed or navigated tab cannot display the error. */ }
}
async function showBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1800);
}
function getErrorMessage(error) { return error?.message || String(error || "Could not create the PolyLinks link."); }
