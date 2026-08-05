const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function createBackgroundHarness(settingsOverrides = {}) {
  let actionHandler;
  let messageHandler;
  let requestBody;
  let popupPath = null;
  const messages = [];
  const menuItems = [];
  const settings = {
    defaultTag: "@DefaultTag",
    dubApiKey: "test-key",
    dubTagName: "",
    dubTags: ["@DefaultTag", "@AlternateTag"],
    tagSelectionMode: "default",
    ...settingsOverrides,
  };
  const chrome = {
    action: {
      onClicked: { addListener(handler) { actionHandler = handler; } },
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setPopup: async ({ popup }) => { popupPath = popup; },
    },
    contextMenus: {
      create(item) { menuItems.push(item); },
      onClicked: { addListener() {} },
      removeAll: async () => { menuItems.length = 0; },
    },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(handler) { messageHandler = handler; } },
      onStartup: { addListener() {} },
      openOptionsPage: async () => {},
    },
    scripting: { executeScript: async () => {} },
    storage: {
      local: {
        get: async () => ({ ...settings }),
        remove: async () => {},
        set: async (value) => Object.assign(settings, value),
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      get: async (tabId) => ({ id: tabId, url: "https://polymarket.com/event/example" }),
      sendMessage: async (_tabId, message) => {
        messages.push(message);
        if (message.type === "POLY_DUB_GET_PAGE") {
          return { ok: true, title: "Example market", url: "https://polymarket.com/event/example" };
        }
        if (message.type === "POLY_DUB_COPY_LINK") return { ok: true };
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
  };
  const context = {
    chrome,
    console,
    decodeURIComponent,
    encodeURIComponent,
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { json: async () => ({ shortLink: "https://poly.market/example" }), ok: true };
    },
    setTimeout: () => 1,
  };
  vm.runInNewContext(fs.readFileSync("background.js", "utf8"), context);
  return {
    action: (tab) => actionHandler(tab),
    getMessageHandler: () => messageHandler,
    getMenuItems: () => menuItems,
    getMessages: () => messages,
    getPopupPath: () => popupPath,
    getRequestBody: () => requestBody,
    syncUi: () => context.syncExtensionUi(),
  };
}

async function testDefaultTagFlow() {
  const harness = createBackgroundHarness();
  await harness.action({ id: 17, url: "https://polymarket.com/event/example" });
  assert.equal(harness.getRequestBody().tagNames, "@DefaultTag");
  assert.equal(harness.getMessages().at(-1).shortLink, "https://poly.market/example");
}

async function testPickerMode() {
  const harness = createBackgroundHarness({ tagSelectionMode: "ask" });
  await harness.syncUi();
  assert.equal(harness.getPopupPath(), "popup.html");
  assert.equal(harness.getMenuItems().length, 0);
}

async function testDefaultModeAlternateMenus() {
  const harness = createBackgroundHarness();
  await harness.syncUi();
  assert.equal(harness.getPopupPath(), "");
  assert.equal(harness.getMenuItems().length, 1);
  assert.equal(harness.getMenuItems()[0].title, "Create link with @AlternateTag");
}

async function testPickerTagOverride() {
  const harness = createBackgroundHarness({ tagSelectionMode: "ask" });
  const response = await new Promise((resolve) => {
    harness.getMessageHandler()({
      tabId: 17,
      tagName: "@AlternateTag",
      type: "POLY_DUB_CREATE_WITH_TAG",
    }, {}, resolve);
  });
  assert.equal(response.ok, true);
  assert.equal(harness.getRequestBody().tagNames, "@AlternateTag");
}

function testManifestScope() {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), [
    "activeTab",
    "clipboardWrite",
    "contextMenus",
    "scripting",
    "storage",
  ]);
  assert.equal(manifest.host_permissions.length, 3);
  assert.ok(manifest.host_permissions.every((value) => (
    value.includes("dub.co") || value.includes("polymarket.com")
  )));
}

Promise.resolve()
  .then(testDefaultTagFlow)
  .then(testPickerMode)
  .then(testDefaultModeAlternateMenus)
  .then(testPickerTagOverride)
  .then(testManifestScope)
  .then(() => console.log("Poly Dub tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
