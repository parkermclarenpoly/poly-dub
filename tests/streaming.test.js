const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { createHandler } = require("../api/create-link.js");
const { createSessionToken } = require("../api/auth.js");

test("streaming sends headers before slow routing and preserves the final consent status in valid JSON", async () => {
  const settings = {
    DUB_API_KEY: "test-key",
    POLY_DUB_SESSION_SECRET: "test-session-secret-at-least-32-characters",
    MARKET_ROUTING_API_KEY: "test-routing-secret-at-least-32-characters",
    MARKET_ROUTING_RESOLVER_URL: "https://ledger.example/api/integrations/market-routing",
    MARKET_ROUTING_APP_HOSTS: "polymarket-app.onelink.me",
  };
  const before = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  let releaseLookup;
  const gate = new Promise(resolve => { releaseLookup = resolve; });
  const handler = createHandler({ fetchImpl: async url => {
    await gate;
    if (new URL(url).pathname.endsWith("market-search")) return { ok: true, json: async () => ({ events: [] }) };
    assert.ok(new URL(url).pathname.endsWith("market-routing"), "must not publish a link before consent");
    return { ok: true, json: async () => ({ routing: { status: "unmapped", url: "https://polymarket.com/event/example" } }) };
  } });
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    req.body = JSON.parse(raw);
    res.status = status => { res.statusCode = status; return res; };
    res.json = body => res.end(JSON.stringify(body));
    await handler(req, res);
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      method: "POST", signal: AbortSignal.timeout(1500),
      headers: { authorization: `Bearer ${createSessionToken(settings.POLY_DUB_SESSION_SECRET)}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://polymarket.com/event/example", tagName: "@Tag", streamResponse: true }),
    });
    assert.equal(response.status, 200, "transport must answer before the routing gate is released");
    releaseLookup();
    const data = await response.json();
    assert.equal(data.status, 409);
    assert.equal(data.requiresDefiConfirmation, true);
    assert.equal(data.shortLink, undefined);
  } finally {
    releaseLookup();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(settings)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});
