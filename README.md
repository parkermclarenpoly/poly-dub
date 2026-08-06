# Poly Dub

<p align="center">
  <img src="icons/poly-dub-logo.png" alt="Poly Dub" width="180">
</p>

Poly Dub is a single-purpose Chrome extension for creating and copying a tagged Dub short link from any Polymarket page.

## Install

1. [**Download the latest release ZIP**](https://github.com/parkermclarenpoly/poly-dub/releases/latest/download/poly-dub.zip) and extract it.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted `poly-dub` folder.
5. Pin **Poly Dub** to the Chrome toolbar.

## Configure

The settings page opens after installation. Enter the Poly Dub access token supplied by the team administrator, add one or more exact Dub tags, choose the default tag, and select **Save settings**.

By default, clicking Poly Dub immediately creates a link with the default tag. Enable **Ask me which tag each time** to show the saved-tag picker on every click. In default mode, alternate saved tags remain available from the extension icon's right-click menu.

The scoped access token and tags are stored only in the user's local Chrome extension storage. The Dub API key remains on the Poly Dub server and is never included in the extension or this repository.

To change settings later, right-click the extension icon and select **Options**.

Access tokens should be distributed only through an approved team password manager or another private channel. Each token can be revoked without rotating or revealing the Dub API key.

## Use

Open any page on `polymarket.com` and click the Poly Dub toolbar icon. The extension creates the tagged Dub link, copies it to the clipboard, and displays a confirmation on the page.

## Permissions

- `activeTab` and `scripting`: read the current Polymarket page title and copy the resulting short link.
- `storage`: save the user's scoped access token and tags locally.
- `poly-dub-api.vercel.app`: securely request creation of the Dub short link.
- `polymarket.com`: run only on Polymarket pages.

## Server security

The proxy accepts authenticated `POST` requests only, restricts destination URLs to HTTPS pages on `polymarket.com`, strips the `via` parameter, rate-limits each access-token identity, and stores only SHA-256 access-token hashes. `DUB_API_KEY` and `POLY_DUB_ACCESS_TOKENS` are sensitive production environment variables and must never be committed to the repository.
