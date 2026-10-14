const form = document.getElementById("settingsForm");
const apiKeyInput = document.getElementById("apiKey");
const loadAccountsButton = document.getElementById("loadAccounts");
const saveButton = document.getElementById("saveSettings");
const accountList = document.getElementById("accountList");
const accountSummary = document.getElementById("accountSummary");
const askEachTimeInput = document.getElementById("askEachTime");
const formStatus = document.getElementById("formStatus");
const connectionStatus = document.getElementById("connectionStatus");
const keyState = document.getElementById("keyState");
const ACCOUNTS_URL = "https://dub-links-nine.vercel.app/api/v1/accounts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_KEYS = ["sessionToken", "sessionExpiresAt", "accessToken", "dubApiKey", "dubTagName", "dubTags", "defaultTag", "tagSelectionMode"];

let savedApiKey = "";
let accounts = [];
let defaultAccountId = "";
let requestVersion = 0;
let activeRequest = null;
let busy = false;
let protectedStorage = false;
const settingsReady = loadSettings();

apiKeyInput.addEventListener("input", () => {
  requestVersion += 1;
  activeRequest?.abort();
  activeRequest = null;
  accounts = [];
  defaultAccountId = "";
  setBusy(false);
  renderAccounts();
  updateConnectionStatus(false);
  setStatus("Load accounts to verify your key and choose a default.");
});

loadAccountsButton.addEventListener("click", () => discoverAccounts(false));
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await discoverAccounts(true);
});

async function loadSettings() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    protectedStorage = true;
    const settings = await chrome.storage.local.get({
      polyLinksApiKey: "", polyLinksAccounts: [], defaultAccountId: "", accountSelectionMode: "default",
    });
    savedApiKey = typeof settings.polyLinksApiKey === "string" ? settings.polyLinksApiKey.trim() : "";
    if (requestVersion !== 0) return;
    try { accounts = parseAccounts(settings.polyLinksAccounts); } catch { accounts = []; }
    defaultAccountId = accounts.some((account) => account.id === settings.defaultAccountId) ? settings.defaultAccountId : "";
    askEachTimeInput.checked = settings.accountSelectionMode === "ask";
    keyState.textContent = savedApiKey ? "A personal key is saved on this browser. Leave this field blank to keep it." : "Your personal key stays in this extension on this browser.";
    apiKeyInput.placeholder = savedApiKey ? "Paste a replacement key, or leave blank" : "Paste your personal API key";
    renderAccounts();
    updateConnectionStatus(Boolean(savedApiKey && defaultAccountId));
    if (savedApiKey) accountSummary.textContent = "Saved accounts are shown below. Saving checks your current access again.";
  } catch {
    setStatus(protectedStorage ? "Could not load your saved settings. Reopen Settings and try again." : "Could not protect your key in extension storage. Update Chrome and reopen Settings.");
  }
}

async function discoverAccounts(save) {
  await settingsReady;
  if (!protectedStorage) {
    setStatus("Could not protect your key in extension storage. Update Chrome and reopen Settings.");
    return;
  }
  if (busy) return;
  const apiKey = apiKeyInput.value.trim() || savedApiKey;
  if (!apiKey) {
    setStatus("Enter a personal PolyLinks API key to load your accounts.");
    apiKeyInput.focus();
    return;
  }

  const version = ++requestVersion;
  const selectedId = defaultAccountId;
  const askEachTime = askEachTimeInput.checked;
  const controller = new AbortController();
  activeRequest = controller;
  setBusy(true, save);
  setStatus(save ? "Checking your account access…" : "Loading your PolyLinks accounts…");
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(ACCOUNTS_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(accountAccessError(response.status));
    const data = await response.json().catch(() => { throw new Error("PolyLinks returned an invalid account response. Try again."); });
    const available = parseAccounts(data?.data);
    if (version !== requestVersion) return;
    accounts = available;
    if (accounts.length === 0) {
      defaultAccountId = "";
      renderAccounts();
      throw new Error("No accounts are assigned to this key. Ask your PolyLinks admin to grant account access.");
    }
    const selectedStillExists = accounts.some((account) => account.id === selectedId);
    defaultAccountId = selectedStillExists ? selectedId : (!selectedId && accounts.length === 1 ? accounts[0].id : "");
    renderAccounts();
    accountSummary.textContent = `${accounts.length} ${accounts.length === 1 ? "account available" : "accounts available"}. Choose the account to use for one-click links.`;
    if (selectedId && !selectedStillExists) throw new Error("Your selected account is no longer available. Choose an account and save again.");
    if (!save) {
      setStatus("Accounts loaded. Choose your default, then save.", true);
      return;
    }
    if (!defaultAccountId) throw new Error("Choose a default account, then save your settings.");
    await chrome.storage.local.set({
      polyLinksApiKey: apiKey,
      polyLinksAccounts: accounts,
      defaultAccountId,
      accountSelectionMode: askEachTime && accounts.length > 1 ? "ask" : "default",
    });
    savedApiKey = apiKey;
    await chrome.storage.local.remove(LEGACY_KEYS);
    if (version !== requestVersion) return;
    apiKeyInput.value = "";
    apiKeyInput.placeholder = "Paste a replacement key, or leave blank";
    keyState.textContent = "A personal key is saved on this browser. Leave this field blank to keep it.";
    updateConnectionStatus(true);
    setStatus("Poly Dub is ready. Open a Polymarket page and click the extension to create your link.", true);
  } catch (error) {
    if (version !== requestVersion) return;
    updateConnectionStatus(false);
    setStatus(controller.signal.aborted ? "The account request timed out. Try again." : error instanceof Error ? safeError(error.message, apiKey) : "Could not load accounts. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
    if (version === requestVersion) {
      activeRequest = null;
      setBusy(false);
    }
  }
}

function parseAccounts(value) {
  if (!Array.isArray(value)) throw new Error("PolyLinks returned an invalid account response. Try again.");
  const ids = new Set();
  return value.map((account) => {
    if (!account || !UUID.test(account.id) || typeof account.username !== "string" || !account.username.trim() || typeof account.platform !== "string" || !account.platform.trim() || ids.has(account.id.toLowerCase())) {
      throw new Error("PolyLinks returned an invalid account response. Try again.");
    }
    ids.add(account.id.toLowerCase());
    const normalized = { id: account.id, username: account.username.trim(), platform: account.platform.trim() };
    if (account.category && typeof account.category.name === "string" && account.category.name.trim()) {
      normalized.category = { name: account.category.name.trim() };
      if (typeof account.category.id === "string") normalized.category.id = account.category.id;
    }
    return normalized;
  });
}

function accountAccessError(status) {
  if (status === 401) return "This API key is invalid, expired, or revoked. Ask your PolyLinks admin for a new personal key.";
  if (status === 403) return "This key does not have account access. Ask your PolyLinks admin to check your permissions.";
  if (status === 429) return "PolyLinks is receiving too many requests. Wait a moment and try again.";
  return "Could not load accounts from PolyLinks. Try again shortly.";
}

function safeError(message, apiKey) {
  // Never display transport errors or browser exception details that might echo credentials.
  if (message.includes(apiKey) || !/^(PolyLinks returned|This API key|This key|No accounts|Your selected account|Choose a default account|Could not load accounts from|PolyLinks is receiving)/.test(message)) {
    return "Could not load accounts. Check your connection and try again.";
  }
  return message;
}

function renderAccounts() {
  accountList.replaceChildren();
  for (const account of accounts) {
    const choice = document.createElement("label");
    choice.className = "account-choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "defaultAccountId";
    radio.value = account.id;
    radio.checked = account.id === defaultAccountId;
    radio.disabled = busy;
    radio.addEventListener("change", () => { defaultAccountId = account.id; });
    const label = document.createElement("span");
    label.className = "account-label";
    const name = document.createElement("strong");
    name.textContent = account.username;
    const detail = document.createElement("small");
    detail.textContent = account.category?.name ? `${account.platform} · ${account.category.name}` : account.platform;
    label.append(name, detail);
    choice.append(radio, label);
    accountList.append(choice);
  }
  if (!accounts.length) {
    const empty = document.createElement("p");
    empty.className = "empty-accounts";
    empty.textContent = "Load your accounts to choose a default.";
    accountList.append(empty);
    accountSummary.textContent = "Only accounts assigned to your personal key will appear here.";
  }
  if (accounts.length < 2) askEachTimeInput.checked = false;
  askEachTimeInput.disabled = busy || accounts.length < 2;
}

function setStatus(message, success = false) {
  formStatus.textContent = message;
  formStatus.classList.toggle("success", success);
}

function updateConnectionStatus(configured) {
  connectionStatus.textContent = configured ? "Ready" : "Setup required";
}

function setBusy(value, saving = false) {
  busy = value;
  saveButton.disabled = value;
  loadAccountsButton.disabled = value;
  saveButton.textContent = value && saving ? "Checking and saving…" : "Save and continue";
  loadAccountsButton.textContent = value && !saving ? "Loading…" : "Load accounts";
  for (const radio of accountList.querySelectorAll("input")) radio.disabled = value;
  askEachTimeInput.disabled = value || accounts.length < 2;
  form.setAttribute("aria-busy", String(value));
}
