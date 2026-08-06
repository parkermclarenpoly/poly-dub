const crypto = require("node:crypto");

const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

function createSessionToken(secret, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    exp: issuedAt + SESSION_LIFETIME_SECONDS,
    iat: issuedAt,
    sub: "polymarket-team",
  })).toString("base64url");
  return `pd_session.${payload}.${sign(payload, secret)}`;
}

function verifySessionToken(header, secret, now = Date.now()) {
  const token = String(header || "").replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (!secret || parts.length !== 3 || parts[0] !== "pd_session") return false;

  const expectedSignature = sign(parts[1], secret);
  if (!safeEqual(parts[2], expectedSignature)) return false;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const nowSeconds = Math.floor(now / 1000);
    return payload.sub === "polymarket-team"
      && Number.isInteger(payload.iat)
      && Number.isInteger(payload.exp)
      && payload.iat <= nowSeconds + 60
      && payload.exp > nowSeconds;
  } catch {
    return false;
  }
}

function verifyPassword(password, encodedHash) {
  const parts = String(encodedHash || "").split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expectedHash = Buffer.from(parts[2], "hex");
  if (salt.length !== 16 || expectedHash.length !== 32) return false;
  const presentedHash = crypto.scryptSync(String(password || ""), salt, 32);
  return crypto.timingSafeEqual(presentedHash, expectedHash);
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(value, expected) {
  const valueBuffer = Buffer.from(String(value));
  const expectedBuffer = Buffer.from(String(expected));
  return valueBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

module.exports = {
  SESSION_LIFETIME_SECONDS,
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
};
