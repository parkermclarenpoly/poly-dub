const crypto = require("node:crypto");
const { verifySessionToken } = require("./auth.js");
const { buildOgPreview } = require("./og-preview.js");
const { resolveForMint, RoutingError, sourceKind } = require("./market-routing.js");

const MAX_REQUESTS_PER_MINUTE = 60;
const requestWindows = new Map();

function createHandler({ fetchImpl = globalThis.fetch, ogPreviewOptions = {} } = {}) {
  return async function handler(request, response) {
    setResponseHeaders(response);
    let streaming = false;
    const reply = (status, body) => {
      if (streaming) response.end(JSON.stringify({ ...body, status }));
      else sendJson(response, status, body);
    };

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    if (request.method !== "POST") {
      reply(405, { error: "Method not allowed" });
      return;
    }

    const workerAuthorized = verifyWorkerSecret(
      request.headers?.["x-poly-dub-worker-secret"],
      process.env.POLY_DUB_WORKER_SECRET,
    );
    const sessionAuthorized = verifySessionToken(
      request.headers?.authorization,
      process.env.POLY_DUB_SESSION_SECRET,
    );
    if (!workerAuthorized && !sessionAuthorized) {
      reply(401, { error: "Team access expired. Open Poly Dub settings and sign in again." });
      return;
    }
    const actor = workerAuthorized ? "news-alert-worker" : "polymarket-team";
    if (!consumeRateLimit(actor)) {
      reply(429, { error: "Too many links created. Wait a minute and try again." });
      return;
    }

    const input = validateInput(request.body);
    if (!input.ok) {
      reply(400, { error: input.error });
      return;
    }

    const dubApiKey = String(process.env.DUB_API_KEY || "").trim();
    if (!dubApiKey) {
      reply(503, { error: "Poly Dub is not configured" });
      return;
    }

    let heartbeat;
    try {
      if (request.body?.streamResponse === true && !workerAuthorized) {
        // Chrome MV3 requires fetch response headers within 30 seconds. Flush
        // immediately; JSON whitespace keeps a valid single JSON response while
        // the selected-market review finishes. Final JSON carries logical status.
        streaming = true;
        response.status(200);
        response.write(" ");
        heartbeat = setInterval(() => response.write(" "), 15000);
      }
      // The worker is an independent integration. Browser sessions always use
      // verified regional routing, including a fresh lookup after consent.
      const routing = workerAuthorized
        ? { url: input.url }
        : await resolveForMint(input.url, { allowDefiOnly: request.body?.allowDefiOnly === true, fetchImpl });
      // Big event pages break X's crawler; see api/og-preview.js.
      const ogPreview = await buildOgPreview(routing.url, { fetchImpl, ...ogPreviewOptions });
      const dubBody = {
        tagNames: input.tagName,
        title: input.title || undefined,
        // Dub Conversion Tracking (sign-ups, deposits); the API defaults it off.
        trackConversion: true,
        url: routing.url,
        ...(routing.geo ? { geo: routing.geo } : {}),
      };
      if (ogPreview) {
        dubBody.proxy = true;
        dubBody.image = ogPreview.image;
        dubBody.title = input.title || "Polymarket";
        dubBody.description = input.description || "Live odds on Polymarket, the world's largest prediction market.";
      }

      const dubResponse = await fetchImpl("https://api.dub.co/links", {
        method: "POST",
        headers: {
          authorization: `Bearer ${dubApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(dubBody),
        signal: AbortSignal.timeout(12000),
        redirect: "error",
      });
      const data = await dubResponse.json().catch(() => ({}));
      if (!dubResponse.ok) {
        const message = getDubErrorMessage(data);
        reply(502, { error: message || "Dub could not create the link" });
        return;
      }
      if (!data.shortLink) {
        reply(502, { error: "Dub did not return a short link" });
        return;
      }

      console.log(JSON.stringify({
        actor,
        event: "link.created",
        host: new URL(input.url).hostname,
        ogWorkaround: Boolean(ogPreview),
        htmlBytes: ogPreview?.htmlBytes,
        tag: input.tagName,
        routingMode: routing.routingMode,
      }));
      reply(200, { ogWorkaround: Boolean(ogPreview), shortLink: data.shortLink, ...(routing.routingMode ? { routingMode: routing.routingMode } : {}) });
    } catch (error) {
      if (error instanceof RoutingError) {
        reply(error.status, { error: error.message, ...(error.requiresDefiConfirmation ? { requiresDefiConfirmation: true } : {}) });
        return;
      }
      console.error("Poly Dub upstream request failed", error instanceof Error ? error.message : error);
      reply(502, { error: "Could not reach Dub" });
    } finally {
      clearInterval(heartbeat);
    }
  };
}

function verifyWorkerSecret(candidate, configuredSecret) {
  const supplied = String(candidate || "");
  const expected = String(configuredSecret || "");
  if (supplied.length < 32 || expected.length < 32) return false;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function validateInput(body) {
  const tagName = String(body?.tagName || "").trim();
  const title = String(body?.title || "").trim().slice(0, 120);
  const description = String(body?.description || "").trim().slice(0, 240);
  if (!tagName || tagName.length > 100) return { ok: false, error: "Choose a valid Dub tag" };

  let url;
  try {
    const raw = String(body?.url || "");
    sourceKind(raw);
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Only Polymarket links are allowed" };
  }
  url.searchParams.delete("via");

  return { ok: true, description, tagName, title, url: url.toString() };
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
  response.setHeader("access-control-allow-headers", "authorization, content-type, x-poly-dub-worker-secret");
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
