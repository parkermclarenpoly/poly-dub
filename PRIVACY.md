# Privacy

Poly Dub does not collect analytics, browsing history, or personal information.

The extension stores the user's chosen tags and a temporary signed team session in local Chrome extension storage. It does not store the team password and does not contain or receive the Dub API key.

The team password is sent over HTTPS only when unlocking the extension. The server checks a salted password hash and returns an expiring session; it does not store or log the submitted password.

When the user clicks the extension on a Polymarket DeFi or US page, the current page URL, page title, chosen tag, and temporary session are sent over HTTPS to the Poly Dub proxy. The session cannot access Dub directly. The proxy verifies access and sends the selected URL to PolyLedger's routing service. A selected-market review may store audited matching evidence in that service. The team session and saved tag are not sent to the routing service, and its credential is never sent to the extension.

After routing succeeds (or the user explicitly confirms an unmatched DeFi-only link), the proxy sends the verified destinations, title and tag to Dub. Dub conversion tracking remains enabled. The proxy records the source hostname, tag and routing mode for security auditing; it does not log the session or full source URL. Pending confirmation state is kept in Chrome's session storage so it survives an idle extension-worker restart, and is cleared by navigation, settings changes or a new action. It is not exposed to page scripts.
