const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function testBackgroundFlow() {
  let actionHandler;
  let requestBody;
  const messages = [];
  const chrome = {
    action: {
      onClicked: { addListener(handler) { actionHandler = handler; } },
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
    },
    runtime: {
      onInstalled: { addListener() {} },
      openOptionsPage: async () => {},
    },
    scripting: { executeScript: async () => {} },
    storage: {
      local: {
        get: async () => ({
          dubApiKey: "test-key",
          dubTagName: "@ExactTeamTag",
        }),
      },
    },
    tabs: {
      sendMessage: async (_tabId, message) => {
        messages.push(message);
        if (message.type === "POLY_DUB_GET_PAGE") {
          return {
            ok: true,
            title: "Example market",
            url: "https://polymarket.com/event/example",
          };
        }
        if (message.type === "POLY_DUB_COPY_LINK") return { ok: true };
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
  };
  const context = {
    chrome,
    console,
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        json: async () => ({ shortLink: "https://poly.market/example" }),
        ok: true,
      };
    },
    setTimeout: () => 1,
  };
  vm.runInNewContext(fs.readFileSync("background.js", "utf8"), context);

  await actionHandler({ id: 17, url: "https://polymarket.com/event/example" });
  assert.equal(requestBody.tagNames, "@ExactTeamTag");
  assert.equal(requestBody.url, "https://polymarket.com/event/example");
  assert.equal(messages.at(-1).shortLink, "https://poly.market/example");
}

function testManifestScope() {
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "scripting", "storage"]);
  assert.equal(manifest.host_permissions.length, 3);
  assert.ok(manifest.host_permissions.every((value) => (
    value.includes("dub.co") || value.includes("polymarket.com")
  )));
}

Promise.resolve()
  .then(testBackgroundFlow)
  .then(testManifestScope)
  .then(() => console.log("Poly Dub tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
