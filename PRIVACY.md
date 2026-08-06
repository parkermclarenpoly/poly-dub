# Privacy

Poly Dub does not collect analytics, browsing history, or personal information.

The extension stores the user's chosen tags in local Chrome extension storage. It does not contain or receive the Dub API key.

When the user clicks the extension on a Polymarket page, the current page URL, page title, chosen tag, and bundled scoped proxy credential are sent over HTTPS to the Poly Dub proxy. The credential cannot access Dub directly. The proxy verifies access, restricts destinations to Polymarket, and sends the URL, title, and tag to Dub to create the requested short link. The proxy records the credential identifier, destination hostname, and tag for security auditing; it does not log the credential or the full destination URL.
