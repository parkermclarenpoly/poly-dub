(() => {
  if (window.__polyDubInstalled) return;
  window.__polyDubInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "POLY_DUB_GET_PAGE") {
      try {
        sendResponse({
          ok: true,
          title: getPolymarketTitle(),
          url: getCleanPolymarketUrl(),
        });
      } catch (error) {
        sendResponse({ ok: false, error: getErrorMessage(error) });
      }
      return;
    }

    if (message?.type === "POLY_DUB_COPY_LINK") {
      copyToClipboard(message.shortLink)
        .then(() => {
          showToast(`Dub link copied · ${message.tagName}`);
          sendResponse({ ok: true });
        })
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;
    }

    if (message?.type === "POLY_DUB_SHOW_ERROR") {
      showToast(message.message || "Could not create Dub link", true);
      sendResponse({ ok: true });
    }
  });

  function getCleanPolymarketUrl() {
    const url = new URL(location.href);
    url.searchParams.delete("via");
    return url.toString();
  }

  function getPolymarketTitle() {
    const rawTitle = [
      document.querySelector("h1")?.innerText,
      getMetaContent("property", "og:title"),
      getMetaContent("name", "twitter:title"),
      document.title,
    ].find((value) => normalizeText(value));

    return normalizeText(rawTitle || "Polymarket")
      .replace(/\s*[-|]?\s*Trading Odds\s*&\s*Predictions(?:\s+\d{4})?.*$/i, "")
      .replace(/\s*[-|]?\s*Odds\s*&\s*Predictions(?:\s+\d{4})?.*$/i, "")
      .replace(/\s*[-|]\s*Polymarket\s*$/i, "")
      .replace(/\s*[|-]\s*Prediction Market\s*$/i, "")
      .trim();
  }

  function getMetaContent(attribute, value) {
    return document.querySelector(`meta[${attribute}='${value}']`)?.content?.trim() || "";
  }

  async function copyToClipboard(text) {
    if (!text) throw new Error("Dub returned an empty link");
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.append(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("Chrome refused clipboard access");
    }
  }

  function showToast(message, isError = false) {
    document.getElementById("poly-dub-toast")?.remove();
    const toast = document.createElement("div");
    toast.id = "poly-dub-toast";
    toast.textContent = message;
    toast.style.cssText = [
      "position:fixed",
      "top:20px",
      "right:20px",
      "z-index:2147483647",
      "padding:11px 14px",
      "border:1px solid rgba(255,255,255,.22)",
      "border-radius:7px",
      `background:${isError ? "#b42318" : "#0b1833"}`,
      "box-shadow:0 8px 28px rgba(16,24,40,.22)",
      "color:#fff",
      "font:600 13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "letter-spacing:0",
    ].join(";");
    document.documentElement.append(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || "Unknown error");
  }
})();
