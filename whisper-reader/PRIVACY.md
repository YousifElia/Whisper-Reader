# Privacy Policy — Whisper Reader

**Last updated: 8 October 2026**

## The short version

Whisper Reader does not collect, transmit, sell or share any data. It makes no
network requests of any kind. Everything it does happens on your own device.

## What the extension accesses

When you activate Whisper Reader on a page — by clicking its toolbar icon,
pressing its keyboard shortcut, or using its right-click menu — it reads the
visible text of that page so it can speak it aloud and highlight along.

That text is used only to produce speech, in the moment, in your browser. It is
never sent anywhere. Speech is produced by your browser's own built-in
`speechSynthesis` feature using the voices already installed on your computer.

Whisper Reader has no access to any page until you activate it there. It requests
no permanent access to any website.

## What is stored, and where

All storage is local to your browser. None of it is transmitted to the
developer or to anyone else, because the extension has no server and makes no
requests.

**Your preferences** — reading speed, pitch, volume, chosen voice, pacing
preset, light/dark choice, whether to highlight each word, and the player's
size and position.

These use your browser's built-in extension sync, so they follow your own
browser profile across your own devices, in the same way your bookmarks do.
They contain no page addresses and no page text. The developer cannot see them.

**Your place in a page** — so that returning to a long article puts you back
where you stopped. For each page you have read, this stores the page address
(without query strings or fragments), the sentence you had reached, and when it
was saved. It is capped at the 150 most recent pages, oldest dropped first.

This never leaves your device. Pressing Stop deletes the entry for that page.
Removing the extension deletes all of it.

**Voice capabilities** — which of your installed voices report word positions,
so the extension can tell you honestly which ones support word-by-word
highlighting. This is a list of voice names only, stored on the device.

**How your browser handles speed** — a single true/false answer recorded the
first time the extension runs, noting whether this browser's speech engine
offers a continuous reading speed or a fixed set of steps. It is measured by
timing two silent test phrases, and it is used to decide which speeds the
slider should offer. No page is involved and nothing is sent anywhere.

**Whether setup has been completed** — a single flag, so the welcome page does
not open again every time.

## What the extension does not do

- No analytics, telemetry, crash reporting or usage statistics
- No accounts, sign-in or identifiers of any kind
- No advertising, and no data sold or shared with anyone
- No remote code: all code is contained in the published package
- No network connections whatsoever

## Permissions

- **activeTab** and **scripting** — to read and speak the page you activate it
  on. Access is granted only for that tab, only when you act, and is not
  retained.
- **storage** — for the preferences and reading positions described above.
- **contextMenus** — for the "Read this page" and "Read selection" right-click
  entries.

The extension requests no host permissions, so it has no standing access to any
website.

## Changes

If this policy ever changes, the updated version will be published here and the
date above will change.

## Contact

Questions about this policy can be sent to the address on the extension's
Chrome Web Store listing.
