# Poly Dub

<p align="center">
  <img src="icons/poly-dub-logo.png" alt="Poly Dub" width="180">
</p>

Poly Dub is a single-purpose Chrome extension for creating and copying a tagged Dub short link from any Polymarket page.

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

By default, clicking Poly Dub immediately creates a link with the default tag. Enable **Ask me which tag each time** to show the saved-tag picker on every click. In default mode, alternate saved tags remain available from the extension icon's right-click menu.

Tags and a temporary team session are stored only in the user's local Chrome extension storage. The Dub API key and team-password verifier remain on the Poly Dub server and are never included in the extension or this repository.

To change settings later, right-click the extension icon and select **Options**.

## Use

Open any page on `polymarket.com` and click the Poly Dub toolbar icon. The extension creates the tagged Dub link, copies it to the clipboard, and displays a confirmation on the page.

## Broken X previews on big markets (auto-fixed)

X's link crawler gives up on Polymarket event pages whose HTML is larger than roughly 3 MB, so the preview image never shows in the post. This hits the biggest markets (2028 presidential, 2028 GOP and Dem nominees, and about 45 others) because their Market Context news feed is rendered into the page.

Poly Dub checks the page size when it creates a link. If the page is over the line, the link is created with Dub's **Custom Link Previews** turned on and the preview image pointed at Polymarket's own OG image (`https://polymarket.com/api/og?eslug=<event-slug>`), so X gets the card without ever loading the heavy page. When this happens the toolbar badge shows **OG** instead of **OK** and the toast says "OG preview fix applied". Nothing to configure.

Manual equivalent for a link that already exists: open it in Dub, toggle **Custom Link Previews**, and set the image to the OG URL above with the event slug from the Polymarket URL.

## Permissions

- `activeTab` and `scripting`: read the current Polymarket page title and copy the resulting short link.
- `storage`: save the user's tags locally.
- `poly-dub-api.vercel.app`: securely request creation of the Dub short link.
- `polymarket.com`: run only on Polymarket pages.

## Server security

The release package contains no credentials. The server verifies the shared team password and returns a signed, expiring session used only with the Poly Dub proxy. Login attempts and link creation are rate-limited. The proxy restricts destinations to HTTPS pages on `polymarket.com` and strips the `via` parameter. The real `DUB_API_KEY`, password hash, and signing secret remain production environment variables and are never committed or bundled with the extension.
