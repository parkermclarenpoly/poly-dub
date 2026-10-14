(() => {
  if (window.__polyDubInstalled) return;
  window.__polyDubInstalled = true;
  let confirmationPanel;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "POLY_DUB_GET_PAGE") {
      try {
        sendResponse({
          description: getPolymarketDescription(),
          ok: true,
          title: getPolymarketTitle(),
          url: location.href,
        });
      } catch (error) {
        sendResponse({ ok: false, error: getErrorMessage(error) });
      }
      return;
    }

    if (message?.type === "POLY_DUB_COPY_LINK") {
      if (location.href !== message.sourceUrl) {
        sendResponse({ ok: false, error: "The page changed. Click Poly Dub again to copy the saved link." });
        return;
      }
      copyToClipboard(message.shortLink)
        .then(() => {
          clearConfirmation();
          const routing = message.routingMode === "regional" ? " · regional routing" :
            message.routingMode === "defi_only" ? " · DeFi-only" : "";
          showToast(`Link copied · ${message.accountLabel}${routing}`);
          sendResponse({ ok: true });
        })
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;
    }

    if (message?.type === "POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED") {
      if (location.href !== message.sourceUrl) {
        sendResponse({ ok: false, error: "The page changed. Click Poly Dub again." });
        return;
      }
      showConfirmation(message);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "POLY_DUB_CLEAR_CONFIRMATION") {
      clearConfirmation();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "POLY_DUB_SHOW_ERROR") {
      clearConfirmation();
      showToast(message.message || "Could not create PolyLinks link", true);
      sendResponse({ ok: true });
    }
  });

  function clearConfirmation() {
    confirmationPanel?.remove();
    confirmationPanel = undefined;
  }

  function showConfirmation(message) {
    clearConfirmation();
    const host = document.createElement("div");
    confirmationPanel = host;
    host.style.cssText = "position:fixed;top:20px;right:20px;z-index:2147483647;max-width:340px";
    // A closed shadow root keeps page scripts from relabeling the consent button.
    const root = host.attachShadow({ mode: "closed" });
    const panel = document.createElement("div");
    panel.style.cssText = "padding:16px;background:#0b1833;color:#fff;border:1px solid #667085;border-radius:8px;box-shadow:0 8px 28px #10182844;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    const explanation = document.createElement("div");
    explanation.textContent = `${message.message || "A verified US destination is not available."} A DeFi-only link sends everyone to Polymarket DeFi and has no US routing.`;
    const label = document.createElement("div");
    label.textContent = `Account: ${message.accountLabel}`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Create DeFi-only link";
    button.style.cssText = "margin-top:12px;padding:9px 12px;border:0;border-radius:5px;background:#fff;color:#0b1833;font:600 14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;cursor:pointer";
    let used = false;
    button.addEventListener("click", async (event) => {
      if (!event.isTrusted || used) return;
      if (location.href !== message.sourceUrl) {
        clearConfirmation();
        showToast("The page changed. Click Poly Dub again on the current market.", true);
        return;
      }
      used = true;
      button.disabled = true;
      button.textContent = "Creating...";
      try {
        const result = await chrome.runtime.sendMessage({ type: "POLY_DUB_CONFIRM_DEFI_ONLY", requestId: message.requestId });
        if (!result?.ok) throw new Error(result?.error || "Could not create the DeFi-only link. Click Poly Dub again.");
        clearConfirmation();
      } catch (error) {
        clearConfirmation();
        showToast(getErrorMessage(error), true);
      }
    });
    panel.append(explanation, label, button);
    root.append(panel);
    document.documentElement.append(host);
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

  function getPolymarketDescription() {
    const raw = getMetaContent("property", "og:description") || getMetaContent("name", "description");
    return normalizeText(raw).slice(0, 240);
  }

  function getMetaContent(attribute, value) {
    return document.querySelector(`meta[${attribute}='${value}']`)?.content?.trim() || "";
  }

  async function copyToClipboard(text) {
    if (!text) throw new Error("PolyLinks returned an empty link");
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
      "max-width:380px",
      "overflow-wrap:anywhere",
      "border:1px solid rgba(255,255,255,.22)",
      "border-radius:7px",
      `background:${isError ? "#b42318" : "#0b1833"}`,
      "box-shadow:0 8px 28px rgba(16,24,40,.22)",
      "color:#fff",
      "font:600 13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "letter-spacing:0",
    ].join(";");
    document.documentElement.append(toast);
    setTimeout(() => toast.remove(), isError ? 12000 : 2200);
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || "Unknown error");
  }
})();
