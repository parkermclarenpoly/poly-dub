const form = document.getElementById("settingsForm");
const newTagInput = document.getElementById("newTag");
const addTagButton = document.getElementById("addTag");
const tagList = document.getElementById("tagList");
const askEachTimeInput = document.getElementById("askEachTime");
const formStatus = document.getElementById("formStatus");
const connectionStatus = document.getElementById("connectionStatus");
const teamPasswordInput = document.getElementById("teamPassword");
const accessState = document.getElementById("accessState");
const LOGIN_URL = "https://poly-dub-api.vercel.app/api/login";

let tags = [];
let defaultTag = "";

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (tags.length === 0 || !defaultTag) {
    setStatus("Save at least one tag.");
    return;
  }

  setFormBusy(true);
  try {
    let { sessionExpiresAt = 0, sessionToken = "" } = await chrome.storage.local.get({
      sessionExpiresAt: 0,
      sessionToken: "",
    });
    if (!sessionToken || Number(sessionExpiresAt) <= Date.now()) {
      const password = teamPasswordInput.value;
      if (!password) throw new Error("Enter the team password.");
      const response = await fetch(LOGIN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.accessToken) {
        throw new Error(data.error || "Could not unlock Poly Dub");
      }
      sessionToken = data.accessToken;
      sessionExpiresAt = Date.now() + (Number(data.expiresIn) || 0) * 1000;
    }

    await chrome.storage.local.set({
      defaultTag,
      dubTags: tags,
      sessionExpiresAt,
      sessionToken,
      tagSelectionMode: askEachTimeInput.checked && tags.length > 1 ? "ask" : "default",
    });
    await chrome.storage.local.remove(["accessToken", "dubApiKey", "dubTagName"]);
    teamPasswordInput.value = "";
    setStatus("Poly Dub is ready.", true);
    updateConnectionStatus(true);
    updateAccessState(true);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not save settings");
    updateConnectionStatus(false);
  } finally {
    setFormBusy(false);
  }
});

addTagButton.addEventListener("click", addTag);
newTagInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addTag();
});

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    defaultTag: "",
    dubTagName: "",
    dubTags: [],
    tagSelectionMode: "default",
    sessionExpiresAt: 0,
    sessionToken: "",
  });
  const legacyTag = String(settings.dubTagName || "").trim();
  tags = Array.isArray(settings.dubTags)
    ? [...new Set(settings.dubTags.map((tag) => String(tag || "").trim()).filter(Boolean))]
    : [];
  if (legacyTag && !tags.includes(legacyTag)) tags.push(legacyTag);
  defaultTag = tags.includes(settings.defaultTag) ? settings.defaultTag : (legacyTag || tags[0] || "");

  askEachTimeInput.checked = settings.tagSelectionMode === "ask" && tags.length > 1;
  renderTags();
  const unlocked = Boolean(settings.sessionToken) && Number(settings.sessionExpiresAt) > Date.now();
  updateConnectionStatus(unlocked && Boolean(defaultTag));
  updateAccessState(unlocked);
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

function updateAccessState(unlocked) {
  accessState.textContent = unlocked ? "Unlocked" : "Locked";
  accessState.classList.toggle("unlocked", unlocked);
  teamPasswordInput.hidden = unlocked;
  const label = document.querySelector('label[for="teamPassword"]');
  label.hidden = unlocked;
}

function setFormBusy(busy) {
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = busy;
  submitButton.textContent = busy ? "Saving..." : "Save and continue";
}
