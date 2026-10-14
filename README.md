# Poly Dub

<p align="center">
  <img src="icons/poly-dub-logo.png" alt="Poly Dub" width="180">
</p>

Poly Dub creates and copies a tagged Dub link from a Polymarket DeFi or US page. Verified market pairs automatically route US visitors to the US app/web destination and other visitors to DeFi.

## Demo

https://github.com/user-attachments/assets/38a341bf-2963-4b27-a5fe-ed024de68544

## Install

1. [**Download the latest release ZIP**](https://github.com/parkermclarenpoly/poly-dub/releases/latest/download/poly-dub.zip) and extract it.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted `poly-dub` folder.
5. When settings opens, enter the shared Polymarket team password, add your Dub tag, and select **Save and continue**.
6. Pin **Poly Dub** to the Chrome toolbar.

## Configure

The settings page opens after installation. Enter the shared Polymarket team password, add one or more exact Dub tags, choose the default tag, and select **Save and continue**. No API key is required. The password is entered only once per browser and is never stored by the extension.

By default, clicking Poly Dub checks regional routing and creates a link with the default tag. Enable **Ask me which tag each time** to show the saved-tag picker on every click. In default mode, alternate saved tags remain available from the extension icon's right-click menu.

Tags and a temporary team session are stored only in the user's local Chrome extension storage. The Dub API key and team-password verifier remain on the Poly Dub server and are never included in the extension or this repository.

To change settings later, right-click the extension icon and select **Options**.

## Use

Open a page on `polymarket.com` or `polymarket.us` (including `www`) and click the Poly Dub toolbar icon. On a verified match, the extension creates one tagged Dub link with a DeFi default and a US override, copies it, and displays a confirmation. Saved tags, conversion tracking and the preview fix continue to apply. Chrome 110 or newer is required.

PolyLedger supplies the same verified market routing used by the Links tool. A missing cached match can trigger a selected-market review, so the first request may take longer. Market/outcome selectors remain part of the URL; the extension never guesses a counterpart from a similar title or slug.

If no US match is verified for a DeFi page, the page shows **Create DeFi-only link**. Clicking it creates a link that sends everyone to DeFi. Nothing is copied before that choice. Changing pages, changing settings or starting another link clears the choice. US pages require a verified route; unavailable or ambiguous routing stops creation and shows an error.

The extension does not automatically retry a failed creation request. If a connection fails after Dub accepted a request, check Dub before creating another link. Repeated toolbar clicks while the current request is running are ignored.

## Broken X previews on big markets (auto-fixed)

X's link crawler gives up on Polymarket event pages whose HTML is larger than roughly 3 MB, so the preview image never shows in the post. This hits the biggest markets (2028 presidential, 2028 GOP and Dem nominees, and about 45 others) because their Market Context news feed is rendered into the page.

Poly Dub checks the page size when it creates a link. If the page is over the line, the link is created with Dub's **Custom Link Previews** turned on and the preview image pointed at Polymarket's own OG image (`https://polymarket.com/api/og?eslug=<event-slug>`), so X gets the card without ever loading the heavy page. When this happens the toolbar badge shows **OG** instead of **OK** and the toast says "OG preview fix applied". Nothing to configure.

Manual equivalent for a link that already exists: open it in Dub, toggle **Custom Link Previews**, and set the image to the OG URL above with the event slug from the Polymarket URL.

## Permissions

- `activeTab` and `scripting`: read the current Polymarket page title and copy the resulting short link.
- `storage`: save the user's tags locally.
- `poly-dub-api.vercel.app`: securely request creation of the Dub short link.
- `polymarket.com` and `polymarket.us`, including `www`: read only supported Polymarket pages after an extension action.

## Server security

The release package contains no credentials. The server verifies the shared team password and returns a signed, expiring session used only with the Poly Dub proxy. Login attempts and link creation are rate-limited. The proxy accepts exact HTTPS Polymarket DeFi/US hosts and strips the `via` parameter. The real Dub key, routing key, password hash and signing secret remain server environment variables and are never bundled with the extension.

## Server setup and rollout

Set these variables on the existing **poly-dub-api** Vercel project before deploying this version. Use preview-scoped values when testing a preview deployment. The three existing login/Dub variables remain required.

| Variable | Value or purpose |
| --- | --- |
| `DUB_API_KEY` | Existing Dub workspace credential |
| `POLY_DUB_PASSWORD_HASH` | Existing team password verifier |
| `POLY_DUB_SESSION_SECRET` | Existing signed-session secret |
| `MARKET_ROUTING_RESOLVER_URL` | `https://polyledger.polynet.app/api/integrations/market-routing` |
| `MARKET_ROUTING_API_KEY` | Dedicated resolver credential, at least 32 characters, matching PolyLedger; obtain through the existing secure credential channel |
| `MARKET_ROUTING_APP_HOSTS` | `polymarket-app.onelink.me` (exact hostname allowlist) |

Regional routing is mandatory for team-session requests in this version. Missing configuration, a globally disabled resolver or an outage blocks publication; none silently turns into a DeFi-only link. The resolver must already have routing enabled. Existing worker-secret requests keep their direct-link creation behavior.

The proxy resolves the source, calls the sibling `market-search?url=…` endpoint only for an unmapped result, then resolves again. That selected-URL preflight can update the shared audited match cache. Manual holds remain authoritative. No integration secret reaches the browser. This reuses market routing while keeping Poly Dub's existing tag model; it does not create creator-owned records in PolyLedger.

The create function allows 90 seconds, including two bounded resolver reads, a selected-market preflight, the preview check and the Dub request. Verify the target Vercel project's runtime/plan supports that duration. New extension requests opt into a streamed JSON response: headers and whitespace arrive immediately, and the final object includes a logical `status` such as `200` or `409`. This avoids Chrome's 30-second fetch-header limit; the worker also calls a Chrome API every 20 seconds only while waiting. Older non-streaming clients retain normal HTTP status codes. See [Chrome worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) and [Vercel streaming](https://vercel.com/docs/functions/streaming-functions).

Deploy the configured server first, then distribute the new extension ZIP. Existing installations must reload/update the extension to receive the new US permissions and confirmation flow. Do not distribute the extension against an older server and assume US routing is enabled.

Before releasing, verify a known matched DeFi page and its US counterpart, an unmatched DeFi page with both confirmation and cancellation, a lookup failure, and a cold/slow lookup in Chrome. Inspect the created Dub record for the DeFi destination, exact US override, saved tag and `trackConversion: true`. Test US/non-US desktop and supported mobile app behavior separately; a successful API response does not establish installed-app or conversion attribution behavior.

## Development

With Node.js 20 or newer:

```sh
npm test
npm run package:extension -- release/poly-dub.zip
```

The tests use local fixtures and a temporary loopback HTTP server, with no production writes. The release ZIP contains extension files and docs only; server code, tests and environment files are excluded.
