const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createHandler } = require("../api/create-link.js");
const { createHandler: createLoginHandler } = require("../api/login.js");
const {
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} = require("../api/auth.js");

function createBackgroundHarness(settingsOverrides = {}) {
  let actionHandler;
  let messageHandler;
  let requestBody;
  let requestAuthorization;
  let popupPath = null;
  const messages = [];
  const menuItems = [];
  const settings = {
    defaultTag: "@DefaultTag",
    dubTagName: "",
    dubTags: ["@DefaultTag", "@AlternateTag"],
    tagSelectionMode: "default",
    sessionExpiresAt: Date.now() + 60_000,
    sessionToken: "test-session-token",
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
      requestAuthorization = options.headers.authorization;
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
    getRequestAuthorization: () => requestAuthorization,
    syncUi: () => context.syncExtensionUi(),
  };
}

async function testDefaultTagFlow() {
  const harness = createBackgroundHarness();
  await harness.action({ id: 17, url: "https://polymarket.com/event/example" });
  assert.equal(harness.getRequestBody().tagName, "@DefaultTag");
  assert.equal(harness.getRequestAuthorization(), "Bearer test-session-token");
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
  assert.equal(harness.getRequestBody().tagName, "@AlternateTag");
}

function createResponseHarness() {
  const result = { body: null, headers: {}, status: 0 };
  return {
    response: {
      end() {},
      json(body) { result.body = body; return this; },
      setHeader(name, value) { result.headers[name] = value; },
      status(status) { result.status = status; return this; },
    },
    result,
  };
}

async function testProxyFlow() {
  const sessionSecret = "test-session-secret-that-is-long-enough";
  const accessToken = createSessionToken(sessionSecret);
  const originalSessionSecret = process.env.POLY_DUB_SESSION_SECRET;
  const originalDubApiKey = process.env.DUB_API_KEY;
  process.env.POLY_DUB_SESSION_SECRET = sessionSecret;
  process.env.DUB_API_KEY = "test-dub-key";

  try {
    let dubBody;
    const handler = createHandler({
      fetchImpl: async (_url, options) => {
        dubBody = JSON.parse(options.body);
        return { json: async () => ({ shortLink: "https://poly.market/test" }), ok: true };
      },
    });
    const { response, result } = createResponseHarness();
    await handler({
      body: {
        tagName: "@ExactTeamTag",
        title: "Example market",
        url: "https://polymarket.com/event/example?via=x-afr2&source=test",
      },
      headers: { authorization: `Bearer ${accessToken}` },
      method: "POST",
    }, response);

    assert.equal(result.status, 200);
    assert.equal(result.body.shortLink, "https://poly.market/test");
    assert.equal(dubBody.tagNames, "@ExactTeamTag");
    assert.equal(new URL(dubBody.url).searchParams.has("via"), false);
    assert.equal(new URL(dubBody.url).searchParams.get("source"), "test");
  } finally {
    restoreEnvironment("POLY_DUB_SESSION_SECRET", originalSessionSecret);
    restoreEnvironment("DUB_API_KEY", originalDubApiKey);
  }
}

async function testProxyRejectsUnauthorizedAndExternalUrls() {
  const sessionSecret = "test-session-secret-that-is-long-enough";
  const accessToken = createSessionToken(sessionSecret);
  const originalSessionSecret = process.env.POLY_DUB_SESSION_SECRET;
  process.env.POLY_DUB_SESSION_SECRET = sessionSecret;

  try {
    const handler = createHandler({ fetchImpl: async () => { throw new Error("Unexpected fetch"); } });
    const unauthorized = createResponseHarness();
    await handler({ body: {}, headers: { authorization: "Bearer wrong" }, method: "POST" }, unauthorized.response);
    assert.equal(unauthorized.result.status, 401);

    const external = createResponseHarness();
    await handler({
      body: { tagName: "@Tag", url: "https://example.com/not-allowed" },
      headers: { authorization: `Bearer ${accessToken}` },
      method: "POST",
    }, external.response);
    assert.equal(external.result.status, 400);
    assert.equal(external.result.body.error, "Only Polymarket links are allowed");
  } finally {
    restoreEnvironment("POLY_DUB_SESSION_SECRET", originalSessionSecret);
  }
}

async function testLoginFlow() {
  const password = "test-team-password";
  const sessionSecret = "test-session-secret-that-is-long-enough";
  const originalPasswordHash = process.env.POLY_DUB_PASSWORD_HASH;
  const originalSessionSecret = process.env.POLY_DUB_SESSION_SECRET;
  process.env.POLY_DUB_PASSWORD_HASH = hashPassword(password, Buffer.alloc(16, 7));
  process.env.POLY_DUB_SESSION_SECRET = sessionSecret;

  try {
    const handler = createLoginHandler();
    const valid = createResponseHarness();
    await handler({
      body: { password },
      headers: { "x-forwarded-for": "192.0.2.1" },
      method: "POST",
    }, valid.response);
    assert.equal(valid.result.status, 200);
    assert.equal(verifySessionToken(`Bearer ${valid.result.body.accessToken}`, sessionSecret), true);
    assert.equal(valid.result.body.expiresIn, 30 * 24 * 60 * 60);

    const invalid = createResponseHarness();
    await handler({
      body: { password: "wrong-password" },
      headers: { "x-forwarded-for": "192.0.2.2" },
      method: "POST",
    }, invalid.response);
    assert.equal(invalid.result.status, 401);
    assert.equal(invalid.result.body.error, "Incorrect team password");
  } finally {
    restoreEnvironment("POLY_DUB_PASSWORD_HASH", originalPasswordHash);
    restoreEnvironment("POLY_DUB_SESSION_SECRET", originalSessionSecret);
  }
}

function testSessionSecurity() {
  const passwordHash = hashPassword("test-team-password", Buffer.alloc(16, 3));
  assert.equal(verifyPassword("test-team-password", passwordHash), true);
  assert.equal(verifyPassword("wrong-password", passwordHash), false);

  const secret = "test-session-secret-that-is-long-enough";
  const now = Date.now();
  const token = createSessionToken(secret, now);
  assert.equal(verifySessionToken(`Bearer ${token}`, secret, now), true);
  assert.equal(verifySessionToken(`Bearer ${token}`, "different-session-secret", now), false);
  assert.equal(verifySessionToken(`Bearer ${token}`, secret, now + (31 * 24 * 60 * 60 * 1000)), false);
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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
  assert.deepEqual(manifest.host_permissions.sort(), [
    "https://*.polymarket.com/*",
    "https://poly-dub-api.vercel.app/*",
    "https://polymarket.com/*",
  ]);
}

function testCredentialSafety() {
  const optionsHtml = fs.readFileSync("options.html", "utf8");
  const background = fs.readFileSync("background.js", "utf8");
  const repositoryText = [
    "background.js",
    "options.html",
    "options.js",
    "README.md",
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(optionsHtml.includes("Dub API key"), false);
  assert.equal(optionsHtml.includes("Team password"), true);
  assert.equal(background.includes("__POLY_DUB_ACCESS_TOKEN__"), false);
  assert.equal(repositoryText.includes("POLY_DUB_PASSWORD_HASH="), false);
}

Promise.resolve()
  .then(testDefaultTagFlow)
  .then(testPickerMode)
  .then(testDefaultModeAlternateMenus)
  .then(testPickerTagOverride)
  .then(testProxyFlow)
  .then(testProxyRejectsUnauthorizedAndExternalUrls)
  .then(testLoginFlow)
  .then(testSessionSecurity)
  .then(testManifestScope)
  .then(testCredentialSafety)
  .then(() => console.log("Poly Dub tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
