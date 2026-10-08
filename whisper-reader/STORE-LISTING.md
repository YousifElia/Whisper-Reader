# Chrome Web Store submission answers

Copy-paste ready. Every claim here was verified against the built package, not
from memory — see the notes at the end.

---

## Single purpose

> Whisper Reader reads the text of the web page you are on aloud, highlighting
> each sentence and word as it is spoken so you can follow along. That is its
> only function. It adds an on-page player with play, pause, skip and speed
> controls, and speaks using the voices already installed on your computer.
> It does not modify pages, block content, or do anything unrelated to
> reading the current page aloud.

---

## Permission justifications

### `activeTab`

> Whisper Reader needs to read the text of the page the user is currently on in
> order to speak it aloud and highlight it. activeTab grants that access only
> for the tab the user is on, and only at the moment they act — clicking the
> toolbar icon, pressing the keyboard shortcut, or using the right-click menu.
> The extension deliberately requests no host permissions, so it has no
> standing access to any site and cannot read any page the user has not
> explicitly asked it to read.

### `scripting`

> The reader is injected into the page on demand with
> `chrome.scripting.executeScript`, using a script file contained in the
> extension package. This is what places the on-page player and lets the
> extension read the page's text and highlight it while speaking.
>
> Injecting on demand, rather than declaring a content script, is what allows
> the extension to work with activeTab alone: a declared content script would
> require host permissions for every site at install time. No remote code is
> ever injected — only `/reader.js` from the package.

### `storage`

> Stores the user's own settings so they persist between sessions: reading
> speed, pitch, volume, chosen voice, pacing preset, light/dark preference,
> whether to highlight individual words, and the size and position of the
> player.
>
> It also stores three small device-local facts that make the extension behave
> correctly on this particular machine: which installed voices report word
> positions, whether this browser's speech engine has a continuous reading
> speed or a stepped one, and whether the first-run setup has been completed.
>
> It also stores, locally on the device, the user's place in pages they have
> read, so that returning to a long article resumes where they stopped. This is
> capped at the 150 most recent pages and is deleted for a page when the user
> presses Stop.
>
> Nothing in storage is transmitted anywhere. The extension has no server and
> makes no network requests.

### `contextMenus`

> Adds two right-click entries: "Read this page aloud" and "Read selection
> aloud". These are the primary way users start reading a specific passage
> without opening the toolbar popup, and the selection entry is the reliable
> fallback on pages where automatic article detection does not find the text.

---

## Are you using remote code?

**No — "No, I am not using remote code."**

> All logic is contained in the published package. The extension loads no
> external scripts, uses no `eval` or `new Function`, and has a content
> security policy of `script-src 'self'; object-src 'self'`. Verified: the
> built package contains no `fetch`, `XMLHttpRequest`, `WebSocket`,
> `EventSource` or `sendBeacon` calls at all.

---

## Data usage

### Data types to check

**None.** Leave every checkbox unticked.

Chrome defines collection as obtaining data and **transmitting it off the
user's device**. Whisper Reader transmits nothing — it has no server, no
analytics, and makes no network requests of any kind. Page text is read into
memory to produce speech and is discarded.

See "The one judgement call" below before you submit.

### The three certifications

Tick all three. All are true:

- **I do not sell or transfer user data to third parties** — there is no
  third party; no data leaves the device.
- **I do not use or transfer user data for purposes unrelated to the single
  purpose** — page text is used only to speak it aloud.
- **I do not use or transfer user data to determine creditworthiness or for
  lending purposes** — plainly not applicable.

### Privacy policy URL

Required. Host `PRIVACY.md` somewhere public and paste the URL. Free options:

- A public GitHub repository, then use the raw or GitHub Pages URL
- A GitHub Gist
- Any static host

---

## The one judgement call

The resume-position feature stores, **on the device only**, the addresses of
pages you have read plus one sentence from each. Nothing is transmitted, so
under Chrome's transmission-based definition this is not "collection" and the
recommendation above is to declare nothing.

A stricter reading is possible: someone could argue that persisting page
addresses touches **Web history** and that persisting a sentence touches
**Website content**, even though both stay local.

If you would rather be maximally conservative, tick those two. It costs
nothing — the privacy policy already describes both accurately, and neither
implies any transmission or sharing. Declaring nothing is defensible and is
what the definition supports; declaring those two is safer against a reviewer
who reads it broadly. Your call.

---

## Verified before writing this

- Shipped manifest permissions: `storage`, `activeTab`, `scripting`,
  `contextMenus`. No `host_permissions`.
- No network primitives in either the Chrome or Firefox build.
- No `eval`, `new Function`, or dynamic script injection.
- Storage writes: `settings` (sync), `voiceCapabilities` (local),
  `resumePositions` (local), `rateQuantization` (local), `onboarding` (local).
  Nothing else.
- `optional_host_permissions: ["<all_urls>"]` was **removed** — it was declared
  for a feature that was never built and nothing requested it. The review
  guidance explicitly says to remove unused permissions.
- Vite's module-preload polyfill was **disabled**, because it put a `fetch(`
  call into the popup bundle. It only fetched the extension's own files, but it
  is the sort of thing a reviewer greps for. There is now no `fetch` anywhere.

---

## Store media

All rendered from the real extension UI by `npm run media`; see
`scripts/media/README.md`. Every image is exact-size, 24-bit RGB with no alpha
channel, as the Chrome Web Store requires.

### Chrome Web Store → Store listing → Graphic assets

| Field | File |
|---|---|
| Store icon (128×128) | `public/icon/128.png` |
| Screenshots (up to 5, 1280×800) | `assets/store/screenshot-1-highlight.png` |
| | `assets/store/screenshot-2-speed.png` |
| | `assets/store/screenshot-3-voices.png` |
| | `assets/store/screenshot-4-shortcuts.png` |
| | `assets/store/screenshot-5-themes.png` |
| Small promo tile (440×280) | `assets/store/promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `assets/store/promo-marquee-1400x560.png` |
| Global promo video | Upload `assets/video/whisper-reader-demo.mp4` to YouTube (unlisted is fine) and paste its link |

The store only takes a YouTube link for video, not a file.

### Firefox Add-ons → Edit product page → Images

Firefox shows screenshots at 1280×800 too, and takes more of them. Upload
screenshots 1–7 in order; 6 (select a passage) and 7 (speed setup) are extras.
The icon comes from the package. Add-ons has no promo tile or video field.

### GitHub

`assets/store/github-social-preview-1280x640.png` goes in the repository's
**Settings → General → Social preview**, which is the card shown when the repo
link is shared.
