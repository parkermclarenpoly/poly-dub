// X's link crawler gives up on Polymarket event pages whose HTML is too large,
// so the OG image never renders in the post. Burner-tested cutoff (Aug 2026):
// 3.094 MB works, 3.175 MB fails. Pages at or above this line get a Dub
// Custom Link Preview that points straight at Polymarket's own OG image.
const OG_HTML_LIMIT_BYTES = 3_150_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MEASURE_TIMEOUT_MS = 4000;
const MEASURE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const htmlSizeCache = new Map();

function getEventSlug(url) {
  try {
    const match = new URL(url).pathname.match(/\/event\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function buildOgImageUrl(eventSlug, now = Date.now()) {
  return `https://polymarket.com/api/og?eslug=${encodeURIComponent(eventSlug)}&tid=${now}`;
}

// Polymarket does not send Content-Length and ignores Range requests, so the
// only reliable measurement is to stream the body and count. We stop reading
// as soon as the limit is crossed, so the worst case is ~3 MB per uncached slug.
async function measureHtmlBytes(url, { fetchImpl = globalThis.fetch, limit = OG_HTML_LIMIT_BYTES, timeoutMs = MEASURE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: { "user-agent": MEASURE_USER_AGENT, accept: "text/html" },
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response?.ok) return null;

    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(declared) && declared > 0) {
      await response.body?.cancel?.().catch(() => {});
      return declared;
    }
    if (!response.body?.getReader) return null;

    const reader = response.body.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength || value?.length || 0;
      if (bytes >= limit) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return bytes;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getCachedHtmlBytes(eventSlug, url, options = {}) {
  const now = options.now || Date.now();
  const cache = options.cache || htmlSizeCache;
  const cached = cache.get(eventSlug);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.bytes;

  const bytes = await measureHtmlBytes(url, options);
  if (bytes != null) cache.set(eventSlug, { at: now, bytes });
  return bytes;
}

// Returns null when the link does not need the fix, otherwise the preview
// fields to merge into the Dub request.
async function buildOgPreview(url, options = {}) {
  const eventSlug = getEventSlug(url);
  if (!eventSlug) return null;

  const htmlBytes = await getCachedHtmlBytes(eventSlug, url, options);
  const limit = options.limit || OG_HTML_LIMIT_BYTES;
  if (htmlBytes == null || htmlBytes < limit) return null;

  return {
    eventSlug,
    htmlBytes,
    image: buildOgImageUrl(eventSlug, options.now),
  };
}

module.exports = {
  OG_HTML_LIMIT_BYTES,
  buildOgImageUrl,
  buildOgPreview,
  getEventSlug,
  measureHtmlBytes,
};
