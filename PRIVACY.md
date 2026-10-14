# Poly Dub privacy

Poly Dub acts only after a toolbar, account-menu or explicit confirmation action on a supported Polymarket page.

The extension stores a personal PolyLinks API key, authorized account labels, the default account and picker preference in local Chrome extension storage. This key grants the existing user's PolyLinks account access; it is not the Dub workspace key. It is sent only over HTTPS to the PolyLinks API for account discovery and link creation. No key is sent to page scripts, embedded in a URL, or included in the release package.

Link creation sends the current page URL, selected account ID, a unique request identity and any explicit DeFi-only consent to PolyLinks. PolyLinks applies its current authorization, quotas, account attribution and verified regional routing. Market matching can update the shared audited match cache. The extension does not send browsing history or unrelated tabs.

Request records are stored locally to recover from uncertain network outcomes without creating duplicate links. These include the submitted URL, account ID, request identity, a credential fingerprint (not the key), and known result or failure information. Consent is limited to the exact tab, page, account and credential and is invalidated by navigation or settings changes. Clearing extension storage or uninstalling removes local records; reconcile pending creations with a PolyLinks admin before doing so.

The extension copies the returned link to the clipboard and displays a result or consent message on the active page. Page scripts receive neither the API key nor server credentials. PolyLinks and Dub retain their normal server-side link, ownership, request and analytics records.

The extension does not collect or calculate creator payouts.
