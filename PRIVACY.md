# Privacy

Poly Dub does not collect analytics, browsing history, or personal information.

The extension stores the user's scoped Poly Dub access token and chosen tags in local Chrome extension storage. It does not contain or receive the Dub API key.

When the user clicks the extension on a Polymarket page, the current page URL, page title, chosen tag, and access token are sent over HTTPS to the Poly Dub proxy. The proxy verifies access, restricts destinations to Polymarket, and sends the URL, title, and tag to Dub to create the requested short link. The proxy records the token identifier, destination hostname, and tag for security auditing; it does not log access tokens or the full destination URL.
