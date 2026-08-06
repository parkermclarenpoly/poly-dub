const { verifySessionToken } = require("./auth.js");

const MAX_REQUESTS_PER_MINUTE = 60;
const POLYMARKET_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*polymarket\.com$/i;
const requestWindows = new Map();

function createHandler({ fetchImpl = globalThis.fetch } = {}) {
  return async function handler(request, response) {
    setResponseHeaders(response);

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (!verifySessionToken(request.headers.authorization, process.env.POLY_DUB_SESSION_SECRET)) {
      sendJson(response, 401, { error: "Team access expired. Open Poly Dub settings and sign in again." });
      return;
    }
    if (!consumeRateLimit("polymarket-team")) {
      sendJson(response, 429, { error: "Too many links created. Wait a minute and try again." });
      return;
    }

    const input = validateInput(request.body);
    if (!input.ok) {
      sendJson(response, 400, { error: input.error });
      return;
    }

    const dubApiKey = String(process.env.DUB_API_KEY || "").trim();
    if (!dubApiKey) {
      sendJson(response, 503, { error: "Poly Dub is not configured" });
      return;
    }

    try {
      const dubResponse = await fetchImpl("https://api.dub.co/links", {
        method: "POST",
        headers: {
          authorization: `Bearer ${dubApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tagNames: input.tagName,
          title: input.title || undefined,
          url: input.url,
        }),
      });
      const data = await dubResponse.json().catch(() => ({}));
      if (!dubResponse.ok) {
        const message = getDubErrorMessage(data);
        sendJson(response, 502, { error: message || "Dub could not create the link" });
        return;
      }
      if (!data.shortLink) {
        sendJson(response, 502, { error: "Dub did not return a short link" });
        return;
      }

      console.log(JSON.stringify({
        actor: "polymarket-team",
        event: "link.created",
        host: new URL(input.url).hostname,
        tag: input.tagName,
      }));
      sendJson(response, 200, { shortLink: data.shortLink });
    } catch (error) {
      console.error("Poly Dub upstream request failed", error instanceof Error ? error.message : error);
      sendJson(response, 502, { error: "Could not reach Dub" });
    }
  };
}

function validateInput(body) {
  const tagName = String(body?.tagName || "").trim();
  const title = String(body?.title || "").trim().slice(0, 190);
  if (!tagName || tagName.length > 100) return { ok: false, error: "Choose a valid Dub tag" };

  let url;
  try {
    url = new URL(String(body?.url || ""));
  } catch {
    return { ok: false, error: "Choose a valid Polymarket URL" };
  }
  if (url.protocol !== "https:" || !POLYMARKET_HOST_PATTERN.test(url.hostname)) {
    return { ok: false, error: "Only Polymarket links are allowed" };
  }
  url.username = "";
  url.password = "";
  url.searchParams.delete("via");

  return { ok: true, tagName, title, url: url.toString() };
}

function consumeRateLimit(actor) {
  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (requestWindows.get(actor) || []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= MAX_REQUESTS_PER_MINUTE) return false;
  recent.push(now);
  requestWindows.set(actor, recent);
  return true;
}

function getDubErrorMessage(data) {
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.error?.message === "string") return data.error.message;
  if (typeof data?.message === "string") return data.message;
  return "";
}

function setResponseHeaders(response) {
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
}

function sendJson(response, status, body) {
  response.status(status).json(body);
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
module.exports.config = { api: { bodyParser: { sizeLimit: "16kb" } } };
