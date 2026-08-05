const form = document.getElementById("settingsForm");
const apiKeyInput = document.getElementById("dubApiKey");
const tagInput = document.getElementById("dubTagName");
const toggleKeyButton = document.getElementById("toggleKey");
const clearKeyButton = document.getElementById("clearKey");
const formStatus = document.getElementById("formStatus");
const connectionStatus = document.getElementById("connectionStatus");

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const dubApiKey = apiKeyInput.value.trim();
  const dubTagName = tagInput.value.trim();

  if (!dubApiKey || !dubTagName) {
    setStatus("Enter both an API key and tag.");
    return;
  }

  await chrome.storage.local.set({ dubApiKey, dubTagName });
  setStatus("Settings saved locally.", true);
  updateConnectionStatus(true);
});

toggleKeyButton.addEventListener("click", () => {
  const revealing = apiKeyInput.type === "password";
  apiKeyInput.type = revealing ? "text" : "password";
  toggleKeyButton.textContent = revealing ? "Hide" : "Show";
  toggleKeyButton.setAttribute("aria-label", revealing ? "Hide API key" : "Show API key");
  toggleKeyButton.title = revealing ? "Hide API key" : "Show API key";
});

clearKeyButton.addEventListener("click", async () => {
  await chrome.storage.local.remove("dubApiKey");
  apiKeyInput.value = "";
  apiKeyInput.focus();
  setStatus("API key cleared.");
  updateConnectionStatus(false);
});

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    dubApiKey: "",
    dubTagName: "",
  });
  apiKeyInput.value = settings.dubApiKey || "";
  tagInput.value = settings.dubTagName || "";
  updateConnectionStatus(Boolean(settings.dubApiKey && settings.dubTagName));
}

function setStatus(message, success = false) {
  formStatus.textContent = message;
  formStatus.classList.toggle("success", success);
}

function updateConnectionStatus(configured) {
  connectionStatus.textContent = configured ? "Ready" : "Not configured";
}
