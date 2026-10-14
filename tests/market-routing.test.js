const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHandler } = require("../api/create-link.js");
const { createSessionToken } = require("../api/auth.js");

const source = "https://polymarket.com/event/example?outcomeId=YES&utm_source=twitter";
const usSource = "https://polymarket.us/event/us-example?outcomeId=YES&r=us-creator";
const app = "https://polymarket-app.onelink.me/S8ac/template?deep_link_value=event%2Fus-example%3FoutcomeId%3DYES&af_web_dp=https%3A%2F%2Fpolymarket.us%2Fevent%2Fus-example%3FoutcomeId%3DYES";
const env = {
  DUB_API_KEY: "test-dub-key",
  POLY_DUB_SESSION_SECRET: "test-session-secret-at-least-32-characters",
  MARKET_ROUTING_API_KEY: "test-routing-key-at-least-32-characters",
  MARKET_ROUTING_RESOLVER_URL: "https://ledger.example/api/integrations/market-routing",
  MARKET_ROUTING_APP_HOSTS: "polymarket-app.onelink.me",
};

function responseHarness() {
  const result = { status: 0, body: null };
  return { result, response: {
    setHeader() {}, end() {},
    status(status) { result.status = status; return this; },
    json(body) { result.body = body; return this; },
  } };
}

async function run({ url = source, decisions = [{ status: "matched", url: source, geo: { US: app }, mappingId: "pair-1" }], allowDefiOnly, config = {}, upstream } = {}) {
  const keys = Object.keys(env);
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, env, config);
  const calls = [];
  let dubBody;
  let resolveCount = 0;
  const fetchImpl = async (input, options = {}) => {
    const target = new URL(input);
    calls.push({ target, options });
    if (upstream) {
      const override = await upstream(target, options);
      if (override) return override;
    }
    if (target.pathname === "/api/integrations/market-routing") {
      const routing = decisions[Math.min(resolveCount++, decisions.length - 1)];
      return { ok: true, json: async () => ({ routing }) };
    }
    if (target.pathname === "/api/integrations/market-search") return { ok: true, json: async () => ({ events: [] }) };
    if (target.hostname === "api.dub.co") {
      dubBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ shortLink: "https://poly.market/test", id: "dub-test" }) };
    }
    return { ok: false }; // No OG fix for these small test pages.
  };
  const harness = responseHarness();
  try {
    await createHandler({ fetchImpl, ogPreviewOptions: { cache: new Map() } })({
      method: "POST",
      headers: { authorization: `Bearer ${createSessionToken(env.POLY_DUB_SESSION_SECRET)}` },
      body: { url, tagName: "@SavedTag", title: "Example", allowDefiOnly },
    }, harness.response);
    return { ...harness.result, calls, dubBody };
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

test("team links send verified US override to Dub while preserving exact tags, conversion tracking and source selectors", async () => {
  const result = await run();
  assert.equal(result.status, 200);
  assert.equal(result.body.routingMode, "regional");
  assert.equal(result.dubBody.url, source);
  assert.deepEqual(result.dubBody.geo, { US: app });
  assert.equal(result.dubBody.tagNames, "@SavedTag");
  assert.equal(result.dubBody.trackConversion, true);
  const lookup = result.calls.find(call => call.target.pathname.endsWith("market-routing"));
  assert.equal(lookup.target.searchParams.get("url"), source);
  assert.equal(lookup.options.headers.authorization, `Bearer ${env.MARKET_ROUTING_API_KEY}`);
  assert.equal(lookup.options.redirect, "error");
});

test("US sources use the resolver's verified DeFi destination and US referral-bearing app URL", async () => {
  const usApp = app + "&deep_link_sub1=us-creator";
  const result = await run({ url: usSource, decisions: [{ status: "matched", url: source, geo: { US: usApp }, mappingId: "pair-1" }] });
  assert.equal(result.status, 200);
  assert.equal(result.dubBody.url, source);
  assert.equal(result.dubBody.geo.US, usApp);
});

test("approved short OneLinks may configure mobile behavior on the server without a deep_link_value query", async () => {
  const shortApp = "https://polymarket-app.onelink.me/S8ac/approved-short-link?af_web_dp=https%3A%2F%2Fpolymarket.us%2Fevent%2Fus-example";
  const result = await run({ decisions: [{ status: "matched", url: source, geo: { US: shortApp }, mappingId: "approved-manual" }] });
  assert.equal(result.status, 200);
  assert.equal(result.dubBody.geo.US, shortApp);
});

test("an unmapped source gets selected-URL review and a fresh resolution before any Dub write", async () => {
  const result = await run({ decisions: [{ status: "unmapped", url: source }, { status: "matched", url: source, geo: { US: app } }] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.calls.filter(call => call.target.hostname === "ledger.example").map(call => call.target.pathname), [
    "/api/integrations/market-routing", "/api/integrations/market-search", "/api/integrations/market-routing",
  ]);
  assert.ok(result.calls.filter(call => call.target.hostname === "ledger.example").every(call => call.target.searchParams.get("url") === source));
});

test("unmatched DeFi returns consent without publishing, and an explicit retry rechecks before minting DeFi only", async () => {
  const decisions = [{ status: "unmapped", url: source }];
  const held = await run({ decisions });
  assert.equal(held.status, 409);
  assert.equal(held.body.requiresDefiConfirmation, true);
  assert.equal(held.dubBody, undefined);
  const confirmed = await run({ decisions, allowDefiOnly: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.routingMode, "defi_only");
  assert.equal(confirmed.dubBody.url, source);
  assert.equal(confirmed.dubBody.geo, undefined);
  assert.equal(confirmed.calls.filter(call => call.target.pathname.endsWith("market-routing")).length, 2);
});

test("consent is strictly boolean and does not override a newly verified match", async () => {
  const held = await run({ decisions: [{ status: "unmapped", url: source }], allowDefiOnly: "true" });
  assert.equal(held.status, 409);
  assert.equal(held.dubBody, undefined);
  const matched = await run({ allowDefiOnly: true });
  assert.equal(matched.body.routingMode, "regional");
  assert.equal(matched.dubBody.geo.US, app);
});

test("manual holds require explicit DeFi consent and never trigger automatic matching", async () => {
  for (const status of ["pending", "disabled"]) {
    const result = await run({ decisions: [{ status, url: source, mappingId: "manual-hold" }] });
    assert.equal(result.status, 409);
    assert.equal(result.body.requiresDefiConfirmation, true);
    assert.equal(result.dubBody, undefined);
    assert.equal(result.calls.length, 1);
  }
});

test("failed or malformed routing never publishes even with DeFi consent", async () => {
  for (const routing of [
    { status: "unavailable", url: source }, { status: "ambiguous", url: source },
    { status: "invalid", url: source }, { status: "unconfigured", url: source },
    { status: "disabled", url: source }, { status: "pending", url: source },
    { status: "unmapped", url: "https://polymarket.com/event/different" },
    { status: "unmapped", url: source, geo: { US: app } },
    { status: "matched", url: source },
    { status: "matched", url: "https://example.com/", geo: { US: app } },
    { status: "matched", url: "https://polymarket.com/event/different", geo: { US: app } },
    { status: "matched", url: source, geo: { US: "https://attacker.example/redirect" } },
    { status: "matched", url: source, geo: { US: app.replace("polymarket.us", "attacker.test") } },
    { status: "matched", url: source, geo: { US: "https://polymarket-app.onelink.me/" } },
    null,
  ]) {
    const result = await run({ decisions: [routing], allowDefiOnly: true });
    assert.equal(result.dubBody, undefined, JSON.stringify(routing));
    assert.ok(result.status >= 400, JSON.stringify(routing));
    assert.notEqual(result.body.requiresDefiConfirmation, true);
  }
});

test("unmatched US cannot mint the diagnostic homepage with either consent value", async () => {
  for (const allowDefiOnly of [false, true]) {
    const result = await run({ url: usSource, decisions: [{ status: "unmapped", url: "https://polymarket.com/" }], allowDefiOnly });
    assert.ok(result.status >= 400);
    assert.equal(result.dubBody, undefined);
    assert.notEqual(result.body.requiresDefiConfirmation, true);
  }
});

test("missing credentials and unsafe resolver configuration stop before upstream requests", async () => {
  for (const config of [
    { MARKET_ROUTING_API_KEY: "" }, { MARKET_ROUTING_API_KEY: "short" },
    { MARKET_ROUTING_RESOLVER_URL: "" }, { MARKET_ROUTING_RESOLVER_URL: "http://ledger.example/api/integrations/market-routing" },
    { MARKET_ROUTING_RESOLVER_URL: "https://secret@ledger.example/api/integrations/market-routing" },
    { MARKET_ROUTING_APP_HOSTS: "" },
  ]) {
    const result = await run({ config });
    assert.equal(result.status, 503);
    assert.equal(result.calls.length, 0);
  }
});

test("resolver and review HTTP errors, malformed JSON and network failures stop before Dub", async () => {
  for (const phase of ["market-routing", "market-search"]) {
    for (const failure of ["http", "json", "network"]) {
      const result = await run({ decisions: [{ status: "unmapped", url: source }], upstream: async target => {
        if (!target.pathname.endsWith(phase)) return null;
        if (failure === "network") throw Error("upstream secret details");
        if (failure === "json") return { ok: true, json: async () => { throw Error("bad JSON"); } };
        return { ok: false, json: async () => ({ error: "upstream secret details" }) };
      } });
      assert.ok(result.status >= 400);
      assert.equal(result.dubBody, undefined);
      assert.ok(!JSON.stringify(result.body).includes("secret details"));
      assert.notEqual(result.body.requiresDefiConfirmation, true);
    }
  }
});
