# Poly Dub privacy

Poly Dub acts only after a toolbar, account-menu, manual US-link or explicit confirmation action on a supported Polymarket page.

The extension stores a personal PolyLinks API key, authorized account labels, the default account and picker preference in local Chrome extension storage. This key grants the existing user's PolyLinks account access; it is not the Dub workspace key. It is sent only over HTTPS to the PolyLinks API for account discovery and link creation. No key is sent to page scripts, embedded in a URL, or included in the release package.

Link creation sends the current page URL, selected account ID, a unique request identity, any manually entered US market URL and any explicit DeFi-only consent to PolyLinks. PolyLinks applies its current authorization, quotas, account attribution and verified regional routing. Automatic market matching can update the shared audited match cache. A manually selected US URL applies only to the new link and does not update that cache or the global match registry. The extension does not send browsing history or unrelated tabs.

Request records are stored locally to recover from uncertain network outcomes without creating duplicate links. These include the submitted DeFi URL, any submitted US destination, the complete request body, account ID, request identity, a credential fingerprint (not the key), and known result or failure information. Manual forms and consent are limited to the exact tab, page, account and credential and is invalidated by navigation or settings changes. Clearing extension storage or uninstalling removes local records; reconcile pending creations with a PolyLinks admin before doing so.

A rejected manual URL remains in the open form for correction. No API key is included in the form or in its messages.

The extension copies the returned link to the clipboard and displays a result or consent message on the active page. Page scripts receive neither the API key nor server credentials. PolyLinks and Dub retain their normal server-side link, ownership, request and analytics records.

The extension does not collect or calculate creator payouts.
