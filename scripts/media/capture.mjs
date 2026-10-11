/**
 * Renders every store image and the demo video from the real extension UI.
 *
 *   npm run media            slides + video
 *   npm run media slides     store screenshots and promo tiles only
 *   npm run media video      demo video and README GIF only
 *
 * Needs Chrome installed (set CHROME_PATH if it is somewhere unusual). The
 * video's narration uses Windows' built-in voices through narrate.ps1; on
 * other systems the committed narration in scripts/media/narration/ is reused.
 * The GIF needs Python with Pillow.
 *
 * Outputs go to assets/store/ and assets/video/.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { helpers, launch } from './cdp.mjs';
import { serve } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const STORE = join(ROOT, 'assets', 'store');
const PORT = 5420;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * The voices Chrome lists on the Windows machine this media was made on: the
 * local Windows voices (measured in a normal Chrome window) followed by
 * Google's network voices (measured headless), in Chrome's own order.
 *
 * Presented whole and immediately, rather than merged into whatever headless
 * Chrome has enumerated so far. Enumeration there is asynchronous: in one run
 * the panel initialised before Google's voices arrived, ranked only the legacy
 * local voices, and showed the "better voices available" advice -- a
 * different screenshot from the same code. A fixed list makes every run the
 * same, and it is still a real machine's list.
 */
export const CHROME_WINDOWS_VOICES = [
  ['Microsoft David - English (United States)', 'en-US', true],
  ['Microsoft Mark - English (United States)', 'en-US', true],
  ['Microsoft Zira - English (United States)', 'en-US', true],
  ['Microsoft Linda - English (Canada)', 'en-CA', true],
  ['Microsoft Richard - English (Canada)', 'en-CA', true],
  ['Google Deutsch', 'de-DE', false],
  ['Google US English', 'en-US', false],
  ['Google UK English Female', 'en-GB', false],
  ['Google UK English Male', 'en-GB', false],
  ['Google español', 'es-ES', false],
  ['Google español de Estados Unidos', 'es-US', false],
  ['Google français', 'fr-FR', false],
  ['Google हिन्दी', 'hi-IN', false],
  ['Google Bahasa Indonesia', 'id-ID', false],
  ['Google italiano', 'it-IT', false],
  ['Google 日本語', 'ja-JP', false],
  ['Google 한국의', 'ko-KR', false],
  ['Google Nederlands', 'nl-NL', false],
  ['Google polski', 'pl-PL', false],
  ['Google português do Brasil', 'pt-BR', false],
  ['Google русский', 'ru-RU', false],
  ['Google 普通话（中国大陆）', 'zh-CN', false],
  ['Google 粤語（香港）', 'zh-HK', false],
  ['Google 國語（臺灣）', 'zh-TW', false],
];

const VOICE_EMULATION = `(() => {
  const synth = window.speechSynthesis;
  if (!synth) return;
  const voices = ${JSON.stringify(CHROME_WINDOWS_VOICES)}.map(([name, lang, local], i) => ({
    name, lang, voiceURI: name, localService: local, default: i === 0,
  }));
  synth.getVoices = () => voices.slice();
  // Stand-in voices cannot be handed to an utterance. Nothing in a capture
  // speaks, but the setup page's rate probe tries; ignore rather than throw.
  const d = Object.getOwnPropertyDescriptor(SpeechSynthesisUtterance.prototype, 'voice');
  Object.defineProperty(SpeechSynthesisUtterance.prototype, 'voice', {
    configurable: true,
    get: d.get,
    set(v) { if (v instanceof SpeechSynthesisVoice) d.set.call(this, v); },
  });
})();`;;

export const SLIDES = [
  ['hero', 'screenshot-1-highlight.png'],
  ['speed', 'screenshot-2-speed.png'],
  ['voices', 'screenshot-3-voices.png'],
  ['shortcuts', 'screenshot-4-shortcuts.png'],
  ['themes', 'screenshot-5-themes.png'],
  ['select', 'screenshot-6-select.png'],
  ['setup', 'screenshot-7-setup.png'],
  ['promo-small', 'promo-small-440x280.png'],
  ['promo-marquee', 'promo-marquee-1400x560.png'],
  ['social', 'github-social-preview-1280x640.png'],
];

const SIZES = {
  'promo-small': [440, 280],
  'promo-marquee': [1400, 560],
  social: [1280, 640],
};

function prebuild() {
  // The setup page comes from the built extension, the panel from stage.js.
  if (!existsSync(join(ROOT, '.output', 'chrome-mv3', 'welcome.html'))) {
    execFileSync('npx', ['wxt', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  }
  execFileSync('npx', ['vite', 'build', '-c', 'scripts/media/vite.config.ts', '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
}

export async function openBrowser(port = 9340) {
  const browser = await launch({ port });
  const page = helpers(browser.page);
  await browser.page.send('Page.addScriptToEvaluateOnNewDocument', { source: VOICE_EMULATION });
  // A headless page never has focus, so a text selection paints in the grey
  // "inactive" colour. Real users select in a focused window.
  await browser.page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.scheme('light');
  return { browser, page };
}

async function captureSlides(only) {
  mkdirSync(STORE, { recursive: true });
  const { browser, page } = await openBrowser();
  try {
    for (const [name, file] of SLIDES) {
      if (only && !only.includes(name)) continue;
      const [w, h] = SIZES[name] ?? [1280, 800];
      await page.viewport(w, h, 1);
      await page.goto(`${BASE}/scripts/media/compose.html?slide=${name}`);
      await page.eval('window.__ready');
      writeFileSync(join(STORE, file), await page.shot('png'));
      console.log(`  ${file}  ${w}x${h}`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const [mode = 'all', ...rest] = process.argv.slice(2);
  prebuild();
  const server = await serve(PORT);
  try {
    if (mode === 'slides' || mode === 'all') {
      console.log('Slides');
      await captureSlides(rest.length ? rest : null);
    }
    if (mode === 'video' || mode === 'all') {
      const { captureVideo } = await import('./video.mjs');
      await captureVideo({ base: BASE, root: ROOT });
    }
  } finally {
    server.close();
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
