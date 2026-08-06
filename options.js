const form = document.getElementById("settingsForm");
const accessTokenInput = document.getElementById("accessToken");
const newTagInput = document.getElementById("newTag");
const addTagButton = document.getElementById("addTag");
const tagList = document.getElementById("tagList");
const askEachTimeInput = document.getElementById("askEachTime");
const toggleKeyButton = document.getElementById("toggleKey");
const clearKeyButton = document.getElementById("clearKey");
const formStatus = document.getElementById("formStatus");
const connectionStatus = document.getElementById("connectionStatus");

let tags = [];
let defaultTag = "";

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const accessToken = accessTokenInput.value.trim();
  if (!accessToken || tags.length === 0 || !defaultTag) {
    setStatus("Enter an access token and save at least one tag.");
    return;
  }

  await chrome.storage.local.set({
    accessToken,
    defaultTag,
    dubTags: tags,
    tagSelectionMode: askEachTimeInput.checked && tags.length > 1 ? "ask" : "default",
  });
  await chrome.storage.local.remove(["dubApiKey", "dubTagName"]);
  setStatus("Settings saved locally.", true);
  updateConnectionStatus(true);
});

addTagButton.addEventListener("click", addTag);
newTagInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addTag();
});

toggleKeyButton.addEventListener("click", () => {
  const revealing = accessTokenInput.type === "password";
  accessTokenInput.type = revealing ? "text" : "password";
  toggleKeyButton.textContent = revealing ? "Hide" : "Show";
  toggleKeyButton.setAttribute("aria-label", revealing ? "Hide access token" : "Show access token");
  toggleKeyButton.title = revealing ? "Hide access token" : "Show access token";
});

clearKeyButton.addEventListener("click", async () => {
  await chrome.storage.local.remove("accessToken");
  accessTokenInput.value = "";
  accessTokenInput.focus();
  setStatus("Access token cleared.");
  updateConnectionStatus(false);
});

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    accessToken: "",
    defaultTag: "",
    dubTagName: "",
    dubTags: [],
    tagSelectionMode: "default",
  });
  const legacyTag = String(settings.dubTagName || "").trim();
  tags = Array.isArray(settings.dubTags)
    ? [...new Set(settings.dubTags.map((tag) => String(tag || "").trim()).filter(Boolean))]
    : [];
  if (legacyTag && !tags.includes(legacyTag)) tags.push(legacyTag);
  defaultTag = tags.includes(settings.defaultTag) ? settings.defaultTag : (legacyTag || tags[0] || "");

  accessTokenInput.value = settings.accessToken || "";
  askEachTimeInput.checked = settings.tagSelectionMode === "ask" && tags.length > 1;
  renderTags();
  updateConnectionStatus(Boolean(settings.accessToken && defaultTag));
}

function addTag() {
  const value = newTagInput.value.trim();
  if (!value) {
    setStatus("Type a tag first.");
    return;
  }
  if (tags.includes(value)) {
    setStatus("That exact tag is already saved.");
    return;
  }

  tags.push(value);
  if (!defaultTag) defaultTag = value;
  newTagInput.value = "";
  renderTags();
  newTagInput.focus();
  setStatus("");
}

function removeTag(tagName) {
  tags = tags.filter((tag) => tag !== tagName);
  if (defaultTag === tagName) defaultTag = tags[0] || "";
  if (tags.length < 2) askEachTimeInput.checked = false;
  renderTags();
}

function renderTags() {
  tagList.replaceChildren();
  for (const tagName of tags) {
    const row = document.createElement("div");
    row.className = "tag-row";

    const choice = document.createElement("label");
    choice.className = "tag-choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "defaultTag";
    radio.checked = tagName === defaultTag;
    radio.addEventListener("change", () => { defaultTag = tagName; });
    const name = document.createElement("span");
    name.textContent = tagName;
    choice.append(radio, name);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-tag";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeTag(tagName));
    row.append(choice, remove);
    tagList.append(row);
  }

  if (tags.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-tags";
    empty.textContent = "No saved tags";
    tagList.append(empty);
  }
  askEachTimeInput.disabled = tags.length < 2;
}

function setStatus(message, success = false) {
  formStatus.textContent = message;
  formStatus.classList.toggle("success", success);
}

function updateConnectionStatus(configured) {
  connectionStatus.textContent = configured ? "Ready" : "Not configured";
}
