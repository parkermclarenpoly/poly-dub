const { createSessionToken, verifyPassword } = require("./auth.js");

const MAX_ATTEMPTS_PER_WINDOW = 10;
const WINDOW_MS = 15 * 60 * 1000;
const attemptsByAddress = new Map();

function createHandler() {
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

    const address = getClientAddress(request);
    if (!canAttempt(address)) {
      sendJson(response, 429, { error: "Too many attempts. Wait 15 minutes and try again." });
      return;
    }

    const password = String(request.body?.password || "");
    if (password.length < 8 || password.length > 128
      || !verifyPassword(password, process.env.POLY_DUB_PASSWORD_HASH)) {
      recordFailure(address);
      sendJson(response, 401, { error: "Incorrect team password" });
      return;
    }

    const secret = String(process.env.POLY_DUB_SESSION_SECRET || "");
    if (secret.length < 32) {
      sendJson(response, 503, { error: "Poly Dub login is not configured" });
      return;
    }

    attemptsByAddress.delete(address);
    const accessToken = createSessionToken(secret);
    sendJson(response, 200, {
      accessToken,
      expiresIn: 30 * 24 * 60 * 60,
    });
  };
}

function canAttempt(address) {
  const now = Date.now();
  const recent = (attemptsByAddress.get(address) || []).filter((time) => time > now - WINDOW_MS);
  attemptsByAddress.set(address, recent);
  return recent.length < MAX_ATTEMPTS_PER_WINDOW;
}

function recordFailure(address) {
  const recent = attemptsByAddress.get(address) || [];
  recent.push(Date.now());
  attemptsByAddress.set(address, recent);
}

function getClientAddress(request) {
  return String(request.headers?.["x-forwarded-for"] || request.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim()
    .slice(0, 100);
}

function setResponseHeaders(response) {
  response.setHeader("access-control-allow-headers", "content-type");
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
module.exports.config = { api: { bodyParser: { sizeLimit: "4kb" } } };
