/**
 * Just enough of the Chrome DevTools Protocol to take exact screenshots.
 *
 * No Puppeteer, no Playwright: Node 22 ships fetch and WebSocket, and the
 * protocol is a handful of JSON messages. Launches the system Chrome headless
 * with its own throwaway profile and muted audio, so nothing it does touches
 * the user's browser or speakers.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome() {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH.');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, headless = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'calm-media-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  const proc = spawn(findChrome(), args, { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 100 && !targets; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      targets = list.filter((t) => t.type === 'page');
      if (targets.length === 0) targets = null;
    } catch {
      await sleep(150);
    }
  }
  if (!targets) throw new Error('Chrome did not open a debugging port.');

  const page = await connect(targets[0].webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  return {
    page,
    async close() {
      page.close();
      proc.kill();
      await sleep(400);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // Chrome may still hold a lock for a moment; it is a temp dir.
      }
    },
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 0;
    const pending = new Map();
    const listeners = new Map();

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(`${msg.error.message} (${msg.error.code})`));
        else ok(msg.result);
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
      }
    };
    ws.onerror = () => reject(new Error('CDP socket error'));
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = ++next;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((ok, fail) => pending.set(id, { ok, fail }));
        },
        once(method) {
          return new Promise((ok) => {
            const fn = (params) => {
              listeners.set(method, (listeners.get(method) ?? []).filter((f) => f !== fn));
              ok(params);
            };
            listeners.set(method, [...(listeners.get(method) ?? []), fn]);
          });
        },
        close() {
          ws.close();
        },
      });
  });
}

/** Page helpers built on the raw client. */
export function helpers(page) {
  const self = {
    async viewport(width, height, scale = 1) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile: false,
      });
    },
    async scheme(value) {
      await page.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value }],
      });
    },
    async goto(url) {
      const loaded = page.once('Page.loadEventFired');
      await page.send('Page.navigate', { url });
      await loaded;
      await self.eval('document.fonts.ready.then(() => true)');
    },
    async eval(expression) {
      const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(
          exceptionDetails.exception?.description ?? exceptionDetails.text,
        );
      }
      return result.value;
    },
    /** Two animation frames, so style and highlight changes have painted. */
    async settle() {
      await self.eval(
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      );
    },
    async shot(format = 'png', quality = 92) {
      await self.settle();
      const { data } = await page.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality } : {}),
      });
      return Buffer.from(data, 'base64');
    },
  };
  return self;
}
