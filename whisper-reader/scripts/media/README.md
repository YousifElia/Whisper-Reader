# Store media pipeline

`npm run media` renders every image in `assets/store/` and both files in
`assets/video/` from the real extension UI. Nothing is mocked up: the panel,
highlighter, collector and setup page are the shipping code, put into exact
states and photographed by headless Chrome over the DevTools protocol.

```bash
npm run media           # everything (about 5 minutes)
npm run media slides    # store screenshots, promo tiles, social preview
npm run media video     # narrated MP4 and README GIF
npm run media slides hero themes   # just the named slides
```

## Requirements

- **Chrome** (set `CHROME_PATH` if it is not in a standard location)
- **Python 3 with Pillow**, for the GIF only
- **Windows**, to re-record the narration. Elsewhere the committed narration in
  `narration/` is reused, so the video still renders.

No ffmpeg and no npm packages: the MP4 is encoded by Chrome's own
MediaRecorder (H.264 + AAC) and then remuxed by `defrag.mjs`.

## Files

| File | What it does |
|---|---|
| `capture.mjs` | Entry point. Builds what it needs, serves the repo, drives Chrome |
| `cdp.mjs` | Minimal DevTools-protocol client on Node's built-in WebSocket |
| `server.mjs` | Static server; extension pages are served from `.output/chrome-mv3` |
| `article.html` | The sample page. Publication, domain and essay are all invented |
| `stage.ts` | Exposes the real reader components so a script can pose them |
| `compose.html` | Store slide layouts, one per `?slide=` |
| `video.html` | The video scene: `render(t)` is a pure function of time |
| `video.mjs` | Narration, timeline, frame rendering, encoding, GIF |
| `narrate.ps1` | Windows voices via System.Speech, with each word's audio position |
| `encode.html` | Frames + audio to MP4 with MediaRecorder |
| `defrag.mjs` | Fragmented MP4 to ordinary MP4, so every player knows the length |
| `gif.py` | README GIF from the video frames |

## Honesty rules the pipeline follows

- **Real UI only.** If a screenshot needs a state, `stage.ts` puts the real
  component in it; nothing is drawn to look like the extension.
- **Real reading order.** The video narrates exactly the sentences the
  collector produces, in order. When the sample page had a line the extension
  would read but the script skipped, the line was removed from the page rather
  than misrepresenting what the extension does.
- **Real voices.** Headless Chrome enumerates voices late and partially, so
  captures present the complete list a normal Chrome window reports on the
  recording machine (`CHROME_WINDOWS_VOICES` in `capture.mjs`): real names,
  real languages, Chrome's own order. Fixed, so every run renders the same.
- **Real behaviour.** Moving the speed slider flips Pacing to Custom, the
  Appearance switch changes the player and not the page, and pauses between
  sentences follow the controller's pacing rules — because that is what the
  extension does.

The one cosmetic exception: headless Chrome never has window focus, so the
sample page sets the colour a text selection has in a focused window.
