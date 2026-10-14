const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHandler } = require("../api/create-link.js");
const { createHandler: createLoginHandler } = require("../api/login.js");
const { OG_HTML_LIMIT_BYTES, buildOgPreview, getEventSlug, measureHtmlBytes } = require("../api/og-preview.js");
const {
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} = require("../api/auth.js");

// Extension account, consent, and replay behavior is exercised in extension-routing.test.js.

function createStreamedPage(totalBytes, { chunkSize = 256 * 1024, contentLength = null } = {}) {
  let sent = 0;
  let cancelled = false;
  const body = {
    cancel: async () => { cancelled = true; },
    getReader: () => ({
      cancel: async () => { cancelled = true; },
      read: async () => {
        if (cancelled || sent >= totalBytes) return { done: true, value: undefined };
        const size = Math.min(chunkSize, totalBytes - sent);
        sent += size;
        return { done: false, value: new Uint8Array(size) };
      },
    }),
  };
  return {
    body,
    headers: { get: (name) => (name === "content-length" && contentLength != null ? String(contentLength) : null) },
    ok: true,
    wasCancelled: () => cancelled,
    bytesSent: () => sent,
  };
}

// Routes the handler's two upstream calls: the Polymarket page measurement and the Dub API.
function createRoutedFetch({ pageBytes, onDubBody }) {
  return async (url, options) => {
    if (String(url).startsWith("https://api.dub.co/")) {
      onDubBody(JSON.parse(options.body));
      return { json: async () => ({ shortLink: "https://poly.market/test" }), ok: true };
    }
    return createStreamedPage(pageBytes);
  };
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
      fetchImpl: createRoutedFetch({ pageBytes: 900_000, onDubBody: (body) => { dubBody = body; } }),
      ogPreviewOptions: { cache: new Map() },
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
    assert.equal(dubBody.proxy, undefined);
    assert.equal(dubBody.image, undefined);
    assert.equal(result.body.ogWorkaround, false);
  } finally {
    restoreEnvironment("POLY_DUB_SESSION_SECRET", originalSessionSecret);
    restoreEnvironment("DUB_API_KEY", originalDubApiKey);
  }
}

async function testOgPreviewMeasurement() {
  assert.equal(getEventSlug("https://polymarket.com/event/presidential-election-winner-2028?tid=1"), "presidential-election-winner-2028");
  assert.equal(getEventSlug("https://polymarket.com/event/some%20slug/market-x"), "some slug");
  assert.equal(getEventSlug("https://polymarket.com/markets/politics"), null);
  assert.equal(getEventSlug("not a url"), null);

  const bigPage = createStreamedPage(8_400_000);
  const measured = await measureHtmlBytes("https://polymarket.com/event/big", { fetchImpl: async () => bigPage });
  assert.ok(measured >= OG_HTML_LIMIT_BYTES, "should report at least the limit for oversized pages");
  assert.ok(bigPage.bytesSent() < 8_400_000, "should stop streaming once the limit is crossed");
  assert.equal(bigPage.wasCancelled(), true);

  const smallPage = createStreamedPage(1_000_000);
  assert.equal(await measureHtmlBytes("https://polymarket.com/event/small", { fetchImpl: async () => smallPage }), 1_000_000);

  const declared = createStreamedPage(10, { contentLength: 5_000_000 });
  assert.equal(await measureHtmlBytes("https://polymarket.com/event/declared", { fetchImpl: async () => declared }), 5_000_000);

  assert.equal(await measureHtmlBytes("https://polymarket.com/event/down", { fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await measureHtmlBytes("https://polymarket.com/event/404", { fetchImpl: async () => ({ ok: false }) }), null);
}

async function testOgPreviewDecision() {
  const cache = new Map();
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return createStreamedPage(4_000_000); };

  const preview = await buildOgPreview("https://polymarket.com/event/presidential-election-winner-2028", { cache, fetchImpl, now: 123 });
  assert.equal(preview.eventSlug, "presidential-election-winner-2028");
  assert.equal(preview.image, "https://polymarket.com/api/og?eslug=presidential-election-winner-2028&tid=123");

  await buildOgPreview("https://polymarket.com/event/presidential-election-winner-2028", { cache, fetchImpl, now: 124 });
  assert.equal(fetches, 1, "second lookup for the same slug should hit the cache");

  assert.equal(await buildOgPreview("https://polymarket.com/event/tiny", { cache: new Map(), fetchImpl: async () => createStreamedPage(50_000) }), null);
  assert.equal(await buildOgPreview("https://polymarket.com/markets", { cache: new Map(), fetchImpl }), null);
  assert.equal(await buildOgPreview("https://polymarket.com/event/unreachable", { cache: new Map(), fetchImpl: async () => { throw new Error("offline"); } }), null);
}

async function testProxyAppliesOgWorkaroundForBigPages() {
  const sessionSecret = "test-session-secret-that-is-long-enough";
  const accessToken = createSessionToken(sessionSecret);
  const originalSessionSecret = process.env.POLY_DUB_SESSION_SECRET;
  const originalDubApiKey = process.env.DUB_API_KEY;
  process.env.POLY_DUB_SESSION_SECRET = sessionSecret;
  process.env.DUB_API_KEY = "test-dub-key";

  try {
    let dubBody;
    const handler = createHandler({
      fetchImpl: createRoutedFetch({ pageBytes: 8_400_000, onDubBody: (body) => { dubBody = body; } }),
      ogPreviewOptions: { cache: new Map(), now: 555 },
    });
    const { response, result } = createResponseHarness();
    await handler({
      body: {
        description: "Who will win the 2028 US presidential election?",
        tagName: "@polymarket",
        title: "Presidential Election Winner 2028",
        url: "https://polymarket.com/event/presidential-election-winner-2028?tid=99",
      },
      headers: { authorization: `Bearer ${accessToken}` },
      method: "POST",
    }, response);

    assert.equal(result.status, 200);
    assert.equal(result.body.ogWorkaround, true);
    assert.equal(dubBody.proxy, true);
    assert.equal(dubBody.image, "https://polymarket.com/api/og?eslug=presidential-election-winner-2028&tid=555");
    assert.equal(dubBody.title, "Presidential Election Winner 2028");
    assert.equal(dubBody.description, "Who will win the 2028 US presidential election?");
    assert.equal(dubBody.url, "https://polymarket.com/event/presidential-election-winner-2028?tid=99");
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

async function testWorkerProxyFlow() {
  const workerSecret = "test-worker-secret-that-is-at-least-32-characters";
  const originalWorkerSecret = process.env.POLY_DUB_WORKER_SECRET;
  const originalDubApiKey = process.env.DUB_API_KEY;
  process.env.POLY_DUB_WORKER_SECRET = workerSecret;
  process.env.DUB_API_KEY = "test-dub-key";

  try {
    let dubBody;
    const handler = createHandler({
      fetchImpl: async (_url, options) => {
        dubBody = JSON.parse(options.body);
        return { json: async () => ({ shortLink: "https://poly.market/worker" }), ok: true };
      },
    });
    const { response, result } = createResponseHarness();
    await handler({
      body: {
        tagName: "@polymarket",
        title: "Worker market",
        url: "https://polymarket.com/event/worker?via=x-afr2",
      },
      headers: { "x-poly-dub-worker-secret": workerSecret },
      method: "POST",
    }, response);

    assert.equal(result.status, 200);
    assert.equal(result.body.shortLink, "https://poly.market/worker");
    assert.equal(dubBody.tagNames, "@polymarket");
    assert.equal(dubBody.trackConversion, true);
    assert.equal(new URL(dubBody.url).searchParams.has("via"), false);
  } finally {
    restoreEnvironment("POLY_DUB_WORKER_SECRET", originalWorkerSecret);
    restoreEnvironment("DUB_API_KEY", originalDubApiKey);
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
    "https://dub-links-nine.vercel.app/*",
    "https://polymarket.com/*",
    "https://polymarket.us/*",
    "https://www.polymarket.com/*",
    "https://www.polymarket.us/*",
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
  assert.equal(optionsHtml.includes("Team password"), false);
  assert.equal(optionsHtml.includes("Personal API key"), true);
  assert.equal(background.includes("__POLY_DUB_ACCESS_TOKEN__"), false);
  assert.equal(repositoryText.includes("POLY_DUB_PASSWORD_HASH="), false);
}

Promise.resolve()
  .then(testProxyFlow)
  .then(testOgPreviewMeasurement)
  .then(testOgPreviewDecision)
  .then(testProxyAppliesOgWorkaroundForBigPages)
  .then(testProxyRejectsUnauthorizedAndExternalUrls)
  .then(testWorkerProxyFlow)
  .then(testLoginFlow)
  .then(testSessionSecurity)
  .then(testManifestScope)
  .then(testCredentialSafety)
  .then(() => console.log("Poly Dub tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
