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
          const routing = message.routingMode === "regional" ? (message.routingSource === "manual" ? " · manual US routing" : " · regional routing") :
            message.routingMode === "defi_only" ? " · DeFi-only" : "";
          showToast(`Link copied · ${message.accountLabel}${routing}`);
          sendResponse({ ok: true });
        })
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;
    }

    if (message?.type === "POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED" || message?.type === "POLY_DUB_MANUAL_US_REQUIRED") {
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
    const manualOnly = message.type === "POLY_DUB_MANUAL_US_REQUIRED";
    const explanation = document.createElement("div");
    explanation.textContent = `${message.message || "A verified US destination is not available."} Paste the US market URL to use it for this link. Visitors outside the US keep the current DeFi destination.`;
    const label = document.createElement("div");
    label.textContent = `Account: ${message.accountLabel}`;
    label.style.cssText = "margin:8px 0";
    const inputLabel = document.createElement("label");
    inputLabel.textContent = "US market URL";
    const input = document.createElement("input");
    input.type = "url";
    input.placeholder = "https://polymarket.us/event/market-name";
    input.autocomplete = "off";
    input.style.cssText = "display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:9px;border:1px solid #98a2b3;border-radius:4px;background:#fff;color:#101828;font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    inputLabel.append(input);
    const status = document.createElement("div");
    status.role = "status";
    status.ariaLive = "polite";
    status.style.cssText = "margin-top:8px;overflow-wrap:anywhere";
    const manualButton = document.createElement("button");
    manualButton.type = "button";
    manualButton.textContent = "Create with US link";
    manualButton.style.cssText = "margin-top:12px;padding:9px 12px;border:0;border-radius:5px;background:#fff;color:#0b1833;font:600 14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;cursor:pointer";
    const defiButton = document.createElement("button");
    defiButton.type = "button";
    defiButton.textContent = "Create DeFi-only link";
    defiButton.style.cssText = manualButton.style.cssText + ";margin-left:6px;background:#d0d5dd";
    let used = false;
    async function submit(event, manual) {
      if (!event.isTrusted || used) return;
      if (location.href !== message.sourceUrl) {
        clearConfirmation();
        showToast("The page changed. Click Poly Dub again on the current market.", true);
        return;
      }
      used = true;
      manualButton.disabled = defiButton.disabled = input.disabled = true;
      status.textContent = "Creating…";
      try {
        const result = await chrome.runtime.sendMessage({
          type: manual ? "POLY_DUB_CONFIRM_MANUAL_US" : "POLY_DUB_CONFIRM_DEFI_ONLY",
          requestId: message.requestId,
          ...(manual ? { usDestination: input.value } : {}),
        });
        if (!result?.ok) throw new Error(result?.error || "Could not create the link. Try again.");
        if (result.pending) {
          status.textContent = "A link is already being created. Try again to check its result.";
          used = false;
          manualButton.disabled = defiButton.disabled = input.disabled = false;
          return;
        }
        clearConfirmation();
      } catch (error) {
        // Keep the exact input and nonce so validation can be corrected and an
        // uncertain write can be retried with its durable request identity.
        status.textContent = getErrorMessage(error);
        used = false;
        manualButton.disabled = defiButton.disabled = input.disabled = false;
      }
    }
    manualButton.addEventListener("click", event => submit(event, true));
    defiButton.addEventListener("click", event => submit(event, false));
    panel.append(explanation, label, inputLabel, manualButton);
    if (!manualOnly) {
      const defiExplanation = document.createElement("div");
      defiExplanation.textContent = "Or create a DeFi-only link that sends everyone to the current DeFi page.";
      defiExplanation.style.cssText = "margin-top:12px";
      panel.append(defiExplanation, defiButton);
    }
    panel.append(status);
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
