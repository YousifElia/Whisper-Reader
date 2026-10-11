/**
 * The demo video: narration, timeline, frames, MP4 and README GIF.
 *
 * 1. Ask the real collector which sentences the article contains, so the
 *    narration speaks exactly the text the extension would.
 * 2. Narrate them with the Windows voices (narrate.ps1), recording where each
 *    word falls in the audio. Off Windows, the committed narration is reused.
 * 3. Lay the sentences out on a timeline with the controller's own pauses,
 *    and script the pointer around them.
 * 4. Render every frame by setting t and screenshotting, then let Chrome's
 *    MediaRecorder turn frames + audio into an MP4.
 * 5. Thin the frames into a GIF for the README (Python + Pillow).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { openBrowser } from './capture.mjs';
import { defragment } from './defrag.mjs';

const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;
const SCALE = 1.5; // rendered at 1920x1080

/** Calm preset pacing, and the controller's rule for scaling it by speed. */
const PAUSE = { sentence: 260, paragraph: 520, heading: 640 };
const pauseDivisor = (rate) => 1 + (rate - 1) * 0.55;

/** SAPI's integer rate for each speed used. -1 is Calm (0.79x), +1 is 1.3x. */
const SAPI_RATE = { 0.79: -1, 1.26: 1 };

const SCRIPT = [
  { find: 'The Case for Reading Slowly', voice: 'Zira', rate: 0.79 },
  { find: 'We skim more than ever', voice: 'Zira', rate: 0.79 },
  { find: 'Listening might be the way back', voice: 'Zira', rate: 0.79 },
  { find: 'Most of what we read today', voice: 'Zira', rate: 0.79 },
  { find: 'We glance at a headline', voice: 'Zira', rate: 1.26 },
  { find: 'The words pass in front of us', voice: 'Zira', rate: 1.26 },
  { find: 'Reading slowly is not about being slow', voice: 'David', rate: 1.26 },
  { find: 'It is about giving a sentence', voice: 'David', rate: 1.26 },
];

function readWav(path) {
  const buf = readFileSync(path);
  // Walk the chunks rather than assuming a 44-byte header.
  let offset = 12;
  let rate = 24000;
  while (offset < buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(offset + 12);
    if (id === 'data') {
      return { rate, pcm: buf.subarray(offset + 8, offset + 8 + size) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in ' + path);
}

function writeWav(path, pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

function narrate(lines, root, out) {
  const committed = join(root, 'scripts', 'media', 'narration');
  const spec = lines.map((l, i) => ({
    id: 's' + i,
    text: l.text,
    voice: l.voice,
    rate: SAPI_RATE[l.rate],
  }));
  const specPath = join(out, 'segments.json');
  writeFileSync(specPath, JSON.stringify(spec, null, 1));

  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'media', 'narrate.ps1'), specPath, committed],
      { stdio: 'inherit' },
    );
    writeFileSync(join(committed, 'segments.json'), JSON.stringify(spec, null, 1));
  } else if (!existsSync(join(committed, 'timings.json'))) {
    throw new Error('Narration needs Windows voices; no committed narration found.');
  }
  return JSON.parse(readFileSync(join(committed, 'timings.json'), 'utf8').replace(/^﻿/, ''));
}

function buildTimeline(sentences, lines, timings, root, ladder) {
  const committed = join(root, 'scripts', 'media', 'narration');
  const titleEnd = 2.6;
  const segments = [];
  let t = 4.05;
  let previous = null;

  lines.forEach((line, i) => {
    const { pcm, rate } = readWav(join(committed, `s${i}.wav`));
    const dur = pcm.length / 2 / rate;
    if (previous) {
      const before = sentences[previous.sentence];
      const next = sentences[line.sentence];
      let ms = PAUSE.sentence;
      if (before.blockId !== next.blockId) ms = next.kind === 'heading' ? PAUSE.heading : PAUSE.paragraph;
      t = previous.start + previous.dur + ms / pauseDivisor(line.rate) / 1000;
    }
    const words = timings['s' + i];
    // A word stamped after the audio has ended means the timings and the WAV
    // disagree about the sample rate (see narrate.ps1). Highlighting built on
    // them drifts behind the voice, so refuse rather than render it.
    const last = words[words.length - 1]?.ms ?? 0;
    if (last > dur * 1000) {
      throw new Error(`s${i}: word at ${last} ms but audio is ${Math.round(dur * 1000)} ms long`);
    }
    const seg = { sentence: line.sentence, start: round(t), dur: round(dur), words, wav: `s${i}.wav`, rate: line.rate };
    segments.push(seg);
    previous = seg;
  });

  const [A, , C, D, , F, G, H] = segments;
  const end = (s) => s.start + s.dur;
  const dragStart = D.start + 1.25;
  const dragEnd = end(D) + 0.12;
  // Late enough that the pointer visibly rests on the voice menu first.
  const themeClick = G.start + 1.35;
  const keysStart = end(H) + 0.7;
  const keysEnd = keysStart + 3.8;
  const endStart = keysEnd - 0.25;

  return {
    fps: FPS,
    duration: round(endStart + 3.4),
    ladder,
    segments,
    events: {
      titleEnd,
      expand: D.start + 0.3,
      dragStart,
      dragEnd,
      rateFrom: 0.79,
      rateTo: 1.26,
      voice: end(F) + 0.08,
      theme: themeClick,
      // Not Infinity: JSON turns that into null, and `t < null` is false, which
      // showed the play button as stopped for the whole video.
      stopReading: 1e6,
      keysStart,
      keysEnd,
      endStart,
    },
    captions: [
      { text: 'Double-click any word to start reading there', from: 3.0, to: A.start + 1.7 },
      { text: 'Every word lights up as it is read', from: A.start + 2.0, to: D.start + 0.15 },
      { text: 'Seven real speeds, and every notch is one you can hear', from: D.start + 0.45, to: F.start + 0.9 },
      { text: 'Pick a voice you like', from: F.start + 1.1, to: themeClick - 0.75 },
      { text: 'Light, dark, or follow your system', from: themeClick - 0.45, to: end(H) + 0.3 },
    ],
    cursor: [
      { t: titleEnd, target: [1320, 740] },
      { t: 3.55, target: `word:${A.sentence}:0`, travel: 0.9 },
      { t: C.start + 0.2, target: `word:${A.sentence}:0`, travel: 0 },
      { t: D.start + 0.25, target: 'button:Expand|Compact', travel: 1.0 },
      { t: D.start + 1.1, target: 'slider:2', travel: 0.7 },
      { t: dragStart, target: 'slider:2', travel: 0 },
      { t: dragEnd, target: 'slider:4', travel: dragEnd - dragStart },
      { t: end(F) - 0.32, target: 'select', travel: 0.9 },
      { t: themeClick, target: 'button:Dark', travel: 0.9 },
      { t: end(H) + 0.4, target: 'button:Dark', travel: 0 },
    ],
    clicks: [
      { t: 3.66 }, { t: 3.84 },
      { t: D.start + 0.3 },
      { t: dragStart },
      { t: end(F) - 0.28 },
      { t: themeClick },
    ],
    titleEnd,
    _committed: committed,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

function mixAudio(timeline, out) {
  const rate = readWav(join(timeline._committed, timeline.segments[0].wav)).rate;
  const total = Buffer.alloc(Math.ceil(timeline.duration * rate) * 2);
  for (const seg of timeline.segments) {
    const { pcm, rate: segRate } = readWav(join(timeline._committed, seg.wav));
    if (segRate !== rate) throw new Error('narration segments differ in sample rate');
    pcm.copy(total, Math.round(seg.start * rate) * 2);
  }
  const path = join(out, 'narration.wav');
  writeWav(path, total, rate);
  return path;
}

export async function captureVideo({ base, root }) {
  const out = join(root, 'scripts', 'media', 'out');
  const frames = join(out, 'frames');
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const videoDir = join(root, 'assets', 'video');
  mkdirSync(videoDir, { recursive: true });

  const { browser, page } = await openBrowser(9341);
  try {
    await page.viewport(WIDTH, HEIGHT, SCALE);
    await page.goto(`${base}/scripts/media/video.html`);
    // The real collector's sentences and the real speed ladder, so the
    // narration and the slider both match the extension exactly.
    const { sentences, ladder } = await page.eval('scene.load()');

    const lines = SCRIPT.map((line) => {
      const sentence = sentences.findIndex((s) => s.text.startsWith(line.find));
      if (sentence < 0) throw new Error('sentence not found: ' + line.find);
      return { ...line, sentence, text: sentences[sentence].text };
    });

    console.log('Narration');
    const timings = narrate(lines, root, out);
    const timeline = buildTimeline(sentences, lines, timings, root, ladder);
    writeFileSync(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
    const audioPath = mixAudio(timeline, out);
    await page.eval(`scene.setTimeline(${JSON.stringify(timeline)})`);

    const count = Math.ceil(timeline.duration * FPS);
    console.log(`Frames: ${count} at ${WIDTH * SCALE}x${HEIGHT * SCALE}`);
    for (let f = 0; f < count; f++) {
      await page.eval(`scene.render(${f / FPS})`);
      const jpeg = await page.shot('jpeg', 90);
      writeFileSync(join(frames, `${String(f).padStart(5, '0')}.jpg`), jpeg);
      if (f % 150 === 0) console.log(`  ${f}/${count}`);
    }

    console.log('Encoding MP4 (real time)');
    await page.viewport(WIDTH * SCALE, HEIGHT * SCALE, 1);
    await page.goto(`${base}/scripts/media/encode.html`);
    // Real time plus generous slack; past that, something is stuck and a clear
    // failure beats a capture that never returns.
    const limit = (timeline.duration * 3 + 60) * 1000;
    const watchdog = new Promise((_, fail) =>
      setTimeout(() => fail(new Error(`encoding did not finish within ${limit / 1000} s`)), limit).unref(),
    );
    const result = await Promise.race([watchdog, page.eval(`encode(${JSON.stringify({
      frameUrl: '/scripts/media/out/frames/%d.jpg',
      frames: count,
      fps: FPS,
      width: WIDTH * SCALE,
      height: HEIGHT * SCALE,
      audioUrl: '/scripts/media/out/narration.wav',
      mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2',
      bitrate: 8_000_000,
    })})`)]);
    const size = 4 * 1024 * 1024;
    const parts = [];
    for (let i = 0; i * size < result.bytes; i++) {
      parts.push(Buffer.from(await page.eval(`videoChunk(${i}, ${size})`), 'base64'));
    }
    const mp4 = join(videoDir, 'whisper-reader-demo.mp4');
    writeFileSync(mp4, Buffer.concat(parts));
    // MediaRecorder writes fragmented MP4 with no total duration; streamed, it
    // reported 3.6 s for this 44 s video. Rebuild it with one index up front.
    const remux = defragment(mp4, mp4);
    console.log('  remuxed: ' + remux.seconds.toFixed(1) + ' s, ' + remux.tracks.map((t) => t.kind + ' ' + t.samples).join(', '));
    console.log(`  ${mp4}  ${(result.bytes / 1e6).toFixed(1)} MB, ${result.skippedFrames} late frames`);
  } finally {
    await browser.close();
  }

  console.log('GIF');
  execFileSync('python', [join(root, 'scripts', 'media', 'gif.py'), frames, join(out, 'timeline.json'), join(videoDir, 'whisper-reader-demo.gif')], {
    stdio: 'inherit',
  });
  console.log(`  ${readdirSync(videoDir).join(', ')}`);
}
