# Privacy

Poly Dub does not collect analytics, browsing history, or personal information.

The extension stores the user's chosen tags and a temporary signed team session in local Chrome extension storage. It does not store the team password and does not contain or receive the Dub API key.

The team password is sent over HTTPS only when unlocking the extension. The server checks a salted password hash and returns an expiring session; it does not store or log the submitted password.

When the user clicks the extension on a Polymarket page, the current page URL, page title, chosen tag, and temporary session are sent over HTTPS to the Poly Dub proxy. The session cannot access Dub directly. The proxy verifies access, restricts destinations to Polymarket, and sends the URL, title, and tag to Dub to create the requested short link. The proxy records the destination hostname and tag for security auditing; it does not log the session or the full destination URL.
