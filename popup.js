const accountButtons = document.getElementById("accountButtons");
const status = document.getElementById("status");
const usDestination = document.getElementById("usDestination");
const openSettingsButton = document.getElementById("openSettings");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let creating = false;
let draftTab;

loadAccounts();
openSettingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

async function loadAccounts() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    draftTab = activeTab ? { id: activeTab.id, url: activeTab.url } : undefined;
    const settings = await chrome.storage.local.get({ defaultAccountId: "", polyLinksAccounts: [] });
    const accounts = Array.isArray(settings.polyLinksAccounts) ? settings.polyLinksAccounts.filter((account) => account && UUID.test(account.id) && typeof account.username === "string" && account.username.trim() && typeof account.platform === "string" && account.platform.trim()) : [];
    if (accounts.length === 0) {
      status.textContent = "Connect your PolyLinks account in Settings.";
      return;
    }
    for (const account of accounts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `account-button${account.id === settings.defaultAccountId ? " default" : ""}`;
      const name = document.createElement("strong");
      name.textContent = account.username;
      const detail = document.createElement("span");
      detail.className = "account-platform";
      detail.textContent = account.category?.name ? `${account.platform} · ${account.category.name}` : account.platform;
      button.append(name, detail);
      button.addEventListener("click", () => createLink(account, button));
      accountButtons.append(button);
    }
  } catch {
    status.textContent = "Could not load accounts. Reopen Settings and try again.";
  }
}

async function createLink(account, selectedButton) {
  if (creating) return;
  creating = true;
  setButtonsDisabled(true);
  selectedButton.classList.toggle("creating", true);
  status.textContent = `Creating for ${account.username} (${account.platform})…`;
  let succeeded = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) {
      status.textContent = "No active tab. Open a Polymarket page and try again.";
      return;
    }
    const target = usDestination.value.trim();
    if (target && (tab.id !== draftTab?.id || tab.url !== draftTab?.url)) {
      status.textContent = "The page changed. Reopen Poly Dub on the current market.";
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: "POLY_DUB_CREATE_WITH_ACCOUNT", accountId: account.id, tabId: tab.id, ...(target ? { usDestination: target, sourceUrl: draftTab.url } : {}) });
    if (!response?.ok) {
      status.textContent = typeof response?.error === "string" ? response.error : "Could not create the link. Try again.";
      return;
    }
    if (response.pending) {
      status.textContent = response.inProgress ? "A link is already being created…" : "Add a US URL or confirm the DeFi-only link on the page.";
      return;
    }
    succeeded = true;
    status.textContent = "Copied";
    setTimeout(() => window.close(), 250);
  } catch {
    status.textContent = "Could not connect to Poly Dub. Reopen the extension and try again.";
  } finally {
    creating = succeeded;
    selectedButton.classList.toggle("creating", false);
    if (!succeeded) setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  usDestination.disabled = disabled;
  for (const button of accountButtons.querySelectorAll("button")) button.disabled = disabled;
}
