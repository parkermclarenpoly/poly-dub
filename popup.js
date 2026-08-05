const tagButtons = document.getElementById("tagButtons");
const status = document.getElementById("status");
const openSettingsButton = document.getElementById("openSettings");

loadTags();

openSettingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

async function loadTags() {
  const settings = await chrome.storage.local.get({ defaultTag: "", dubTags: [] });
  const tags = Array.isArray(settings.dubTags) ? settings.dubTags.filter(Boolean) : [];
  if (tags.length === 0) {
    status.textContent = "No saved tags";
    return;
  }

  for (const tagName of tags) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tag-button${tagName === settings.defaultTag ? " default" : ""}`;
    button.textContent = tagName;
    button.addEventListener("click", () => createLink(tagName, button));
    tagButtons.append(button);
  }
}

async function createLink(tagName, selectedButton) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    status.textContent = "No active tab";
    return;
  }

  for (const button of tagButtons.querySelectorAll("button")) button.disabled = true;
  selectedButton.textContent = "Creating...";
  status.textContent = tagName;
  const response = await chrome.runtime.sendMessage({
    tabId: tab.id,
    tagName,
    type: "POLY_DUB_CREATE_WITH_TAG",
  });
  if (!response?.ok) {
    selectedButton.textContent = tagName;
    status.textContent = response?.error || "Could not create link";
    for (const button of tagButtons.querySelectorAll("button")) button.disabled = false;
    return;
  }

  status.textContent = "Copied";
  setTimeout(() => window.close(), 250);
}
