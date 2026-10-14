// Keep market identity and match decisions in PolyLedger. This adapter only
// validates its response and enforces the publishing/consent boundary.
const DEFI_HOSTS = new Set(["polymarket.com", "www.polymarket.com"]);
const US_HOSTS = new Set(["polymarket.us", "www.polymarket.us"]);
const UNAVAILABLE = "US routing is unavailable. Try again before creating a link.";

class RoutingError extends Error {
  constructor(message = UNAVAILABLE, status = 503, requiresDefiConfirmation = false) {
    super(message);
    this.status = status;
    this.requiresDefiConfirmation = requiresDefiConfirmation;
  }
}

function safeHttpsUrl(raw) {
  if (typeof raw !== "string" || raw.length > 8192 || /[\s\x00-\x1f\x7f\\]/.test(raw)) throw new RoutingError();
  let url;
  try { url = new URL(raw); } catch { throw new RoutingError(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || /^https:\/\/[^/]*:\d+(?:\/|$)/i.test(raw)) throw new RoutingError();
  return url;
}

function sourceKind(raw) {
  const url = safeHttpsUrl(raw);
  if (DEFI_HOSTS.has(url.hostname)) return "defi";
  if (US_HOSTS.has(url.hostname)) return "us";
  throw new RoutingError();
}

function readConfig() {
  const key = String(process.env.MARKET_ROUTING_API_KEY || "").trim();
  const resolver = safeHttpsUrl(process.env.MARKET_ROUTING_RESOLVER_URL);
  const appHosts = String(process.env.MARKET_ROUTING_APP_HOSTS || "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
  if (key.length < 32 || resolver.pathname !== "/api/integrations/market-routing" || resolver.search
    || !appHosts.length || appHosts.some(host => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host))) throw new RoutingError();
  return { key, resolver, appHosts };
}

async function fetchJson(endpoint, source, config, fetchImpl, timeoutMs) {
  const url = new URL(endpoint);
  url.searchParams.set("url", source);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${config.key}`, accept: "application/json" },
      redirect: "error", // Never forward the integration credential to a redirect.
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new RoutingError();
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new RoutingError();
    return data;
  } catch {
    throw new RoutingError();
  } finally {
    clearTimeout(timer);
  }
}

function validateDecision(source, decision, config) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) throw new RoutingError();
  const kind = sourceKind(source);
  if (sourceKind(decision.url) !== "defi" || (kind === "defi" && decision.url !== source)) throw new RoutingError();
  if (decision.status === "matched") {
    if (!decision.geo || Object.keys(decision.geo).length !== 1 || typeof decision.geo.US !== "string") throw new RoutingError();
    const app = safeHttpsUrl(decision.geo.US);
    if (!config.appHosts.includes(app.hostname) || app.pathname === "/"
      || app.searchParams.getAll("af_web_dp").length !== 1 || sourceKind(app.searchParams.get("af_web_dp")) !== "us") throw new RoutingError();
    return "regional";
  }
  if (decision.geo !== undefined) throw new RoutingError();
  if (decision.status === "unmapped" && decision.mappingId === undefined) return "unmapped";
  if (["pending", "disabled"].includes(decision.status) && typeof decision.mappingId === "string" && decision.mappingId.trim()) return "manual_hold";
  throw new RoutingError();
}

async function resolveForMint(source, { allowDefiOnly = false, fetchImpl = globalThis.fetch } = {}) {
  const kind = sourceKind(source);
  const config = readConfig();
  const resolve = async () => (await fetchJson(config.resolver, source, config, fetchImpl, 8000)).routing;
  let decision = await resolve();
  let mode = validateDecision(source, decision, config);
  if (mode === "unmapped") {
    const reviewEndpoint = new URL(config.resolver);
    reviewEndpoint.pathname = "/api/integrations/market-search";
    const review = await fetchJson(reviewEndpoint, source, config, fetchImpl, 50000);
    if (!Array.isArray(review.events)) throw new RoutingError();
    decision = await resolve();
    mode = validateDecision(source, decision, config);
  }
  if (mode === "regional") return { url: decision.url, geo: { US: decision.geo.US }, routingMode: "regional" };
  if (kind === "us") throw new RoutingError("No verified DeFi + US route is available for this page. Open its DeFi counterpart or try again later.", 409);
  if (allowDefiOnly !== true) {
    throw new RoutingError("No verified US match is available. US visitors will also receive DeFi. Choose Create DeFi-only link to continue.", 409, true);
  }
  return { url: source, routingMode: "defi_only" };
}

module.exports = { resolveForMint, RoutingError, sourceKind };
