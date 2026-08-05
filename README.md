# Poly Dub

Poly Dub is a single-purpose Chrome extension for creating and copying a tagged Dub short link from any Polymarket page.

## Install

1. Download the latest release ZIP and extract it.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted `poly-dub` folder.
5. Pin **Poly Dub** to the Chrome toolbar.

## Configure

The settings page opens after installation. Enter your Dub API key and the exact Dub tag to apply to links, then select **Save settings**.

The API key and tag are stored only in the user's local Chrome extension storage. They are not included in this repository.

To change settings later, right-click the extension icon and select **Options**.

## Use

Open any page on `polymarket.com` and click the Poly Dub toolbar icon. The extension creates the tagged Dub link, copies it to the clipboard, and displays a confirmation on the page.

## Permissions

- `activeTab` and `scripting`: read the current Polymarket page title and copy the resulting short link.
- `storage`: save the user's API key and tag locally.
- `api.dub.co`: create the Dub short link.
- `polymarket.com`: run only on Polymarket pages.
