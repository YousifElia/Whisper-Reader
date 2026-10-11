/**
 * The real reader UI, held still for a camera.
 *
 * The store screenshots and the demo video are rendered from the actual panel,
 * highlighter, collector and offset map -- not from mockups -- so what they
 * show is what installs. What this file adds is control: instead of the
 * player advancing on speech events, the capture script says "sentence 3,
 * word 5, speaking at 1.6x" and this puts the real components in exactly that
 * state, so every frame is reproducible.
 *
 * Built by scripts/media/vite.config.ts into an IIFE and loaded by
 * scripts/media/article.html when it is opened with ?stage.
 */

import {
  collectDocument,
  DEFAULT_COLLECT_OPTIONS,
  type ReaderDocument,
} from '../../lib/extract/collector';
import { segmentWords } from '../../lib/extract/segment';
import { createHighlighter } from '../../lib/highlight/renderer';
import { DEFAULT_THEME } from '../../lib/highlight/theme';
import { webSpeechEngine } from '../../lib/engines/webspeech';
import type { Voice } from '../../lib/engines/types';
import type { PlayerState } from '../../lib/player/controller';
import { findPreset, type PresetId } from '../../lib/player/presets';
import { QUANTIZED_LADDER } from '../../lib/player/rate';
import {
  ReaderPanel,
  type PanelGeometry,
  type ThemeChoice,
} from '../../ui/panel/panel';

export interface StageSentence {
  index: number;
  blockId: number;
  /** 'heading' gets the longer pause before it, as in the controller. */
  kind: string;
  text: string;
  words: { start: number; end: number }[];
}

export interface StageOptions {
  geometry?: PanelGeometry;
  theme?: ThemeChoice;
  quantized?: boolean;
  rate?: number;
  preset?: PresetId;
  voiceId?: string;
}


let model: ReaderDocument | null = null;
let panel: ReaderPanel | null = null;
let voices: Voice[] = [];
const highlighter = createHighlighter(document, DEFAULT_THEME);

let state: PlayerState = {
  status: 'idle',
  sentenceIndex: 0,
  totalSentences: 0,
  blockId: 0,
  progress: 0,
  rate: 0.79,
  effectiveRate: 0.79,
  boosted: false,
  voiceId: null,
  voiceName: null,
  wordTimings: 'native',
  error: null,
  remainingMs: null,
};

const noop = () => {};

async function init(options: StageOptions = {}): Promise<number> {
  model = collectDocument(document, DEFAULT_COLLECT_OPTIONS);

  // capture.mjs makes the browser report the same voices a normal Chrome
  // window on Windows does; see CHROME_WINDOWS_VOICES there.
  voices = await webSpeechEngine.listVoices().catch(() => []);
  const voice =
    voices.find((v) => v.id === options.voiceId) ??
    voices.find((v) => v.name.includes('Zira')) ??
    voices[0] ??
    null;

  panel = new ReaderPanel(
    document,
    {
      onPlayPause: noop,
      onStop: noop,
      onSkip: noop,
      onBoost: noop,
      onRate: noop,
      onVoice: noop,
      onWordHighlight: noop,
      onPreset: noop,
      onTheme: noop,
      onGeometry: noop,
      onClose: noop,
    },
    options.geometry,
  );

  const rate = options.rate ?? 0.79;
  panel.setVoices(voices, voice?.id ?? null);
  panel.setPreset(options.preset ?? 'calm');
  panel.setTheme(options.theme ?? 'system');
  panel.setRateLadder(options.quantized ?? true, rate);

  state = {
    ...state,
    totalSentences: model.sentences.length,
    rate,
    effectiveRate: rate,
    voiceId: voice?.id ?? null,
    voiceName: voice?.name ?? null,
    remainingMs: 6 * 60_000,
  };
  panel.setState(state);
  return model.sentences.length;
}

function sentences(): StageSentence[] {
  if (!model) return [];
  return model.sentences.map((ref, index) => {
    const block = model!.blocks[ref.blockId]!;
    const text = block.text.slice(ref.span.start, ref.span.end);
    return {
      index,
      blockId: ref.blockId,
      kind: block.kind,
      text,
      words: segmentWords(text, block.lang).map((w) => ({
        start: w.start,
        end: w.end,
      })),
    };
  });
}

/** Paint sentence `index`, and optionally its word `word`, exactly as the
 *  controller would: through the block's offset map, onto live DOM ranges. */
function show(index: number, word: number | null = null): void {
  if (!model) return;
  const ref = model.sentences[index];
  if (!ref) {
    highlighter.clear();
    return;
  }
  const block = model.blocks[ref.blockId]!;
  const sentence = block.map.rangeFor(ref.span.start, ref.span.end);
  let wordRange: Range | null = null;
  if (word !== null) {
    const text = block.text.slice(ref.span.start, ref.span.end);
    const span = segmentWords(text, block.lang)[word];
    if (span) {
      wordRange = block.map.rangeFor(
        ref.span.start + span.start,
        ref.span.start + span.end,
      );
    }
  }
  highlighter.show(sentence, wordRange);
}

function clear(): void {
  highlighter.clear();
}

/** Where sentence `index` sits on the page, for the camera to follow. */
function sentenceTop(index: number): number {
  if (!model) return 0;
  const ref = model.sentences[index];
  if (!ref) return 0;
  const block = model.blocks[ref.blockId]!;
  const range = block.map.rangeFor(ref.span.start, ref.span.end);
  const rect = range?.getBoundingClientRect();
  return rect ? rect.top + window.scrollY : 0;
}

function setState(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch };
  if (model && patch.sentenceIndex !== undefined) {
    state = {
      ...state,
      blockId: model.sentences[patch.sentenceIndex]?.blockId ?? 0,
      progress: (patch.sentenceIndex + 1) / model.sentences.length,
    };
  }
  panel?.setState(state);
}

function setVoice(id: string): void {
  const voice = voices.find((v) => v.id === id || v.name.includes(id));
  if (!voice || !panel) return;
  panel.setVoices(voices, voice.id);
  // Carry the voice's real word-timing support, so a network voice shows the
  // same "estimated" note it would in the extension.
  setState({
    voiceId: voice.id,
    voiceName: voice.name,
    wordTimings: voice.wordTimings,
  });
}

function setRate(rate: number, quantized = true): void {
  panel?.setRateLadder(quantized, rate);
  setState({ rate, effectiveRate: rate });
}

function setTheme(choice: ThemeChoice): void {
  panel?.setTheme(choice);
}

function setPageDark(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  // The highlighter picks its wash from the paint underneath when it starts,
  // as the real reader does on a page that is already dark. Re-read it.
  highlighter.setTheme(DEFAULT_THEME);
}

function setPreset(id: PresetId): void {
  panel?.setPreset(id);
  const preset = findPreset(id);
  if (preset) setRate(preset.settings.rate);
}

function toggleMode(): void {
  (panel as unknown as { toggleMode(): void } | null)?.toggleMode();
}

/** Select a passage the way a user would drag across it. */
function selectSentences(from: number, to: number): void {
  if (!model) return;
  const first = model.sentences[from];
  const last = model.sentences[to];
  if (!first || !last) return;
  const a = model.blocks[first.blockId]!.map.rangeFor(first.span.start, first.span.end);
  const b = model.blocks[last.blockId]!.map.rangeFor(last.span.start, last.span.end);
  if (!a || !b) return;
  const range = document.createRange();
  range.setStart(a.startContainer, a.startOffset);
  range.setEnd(b.endContainer, b.endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Bounding box of a word, for drawing a pointer onto it in a composite. */
function wordRect(index: number, word: number): DOMRect | null {
  if (!model) return null;
  const ref = model.sentences[index];
  if (!ref) return null;
  const block = model.blocks[ref.blockId]!;
  const text = block.text.slice(ref.span.start, ref.span.end);
  const span = segmentWords(text, block.lang)[word];
  if (!span) return null;
  return (
    block.map
      .rangeFor(ref.span.start + span.start, ref.span.start + span.end)
      ?.getBoundingClientRect() ?? null
  );
}

const stage = {
  init,
  sentences,
  show,
  clear,
  sentenceTop,
  setState,
  setVoice,
  setRate,
  setTheme,
  setPageDark,
  setPreset,
  toggleMode,
  selectSentences,
  wordRect,
  voices: () => voices.map((v) => ({ id: v.id, name: v.name, lang: v.lang })),
  /** The speeds a quantizing engine offers, for the video's slider drag. */
  ladder: () => [...QUANTIZED_LADDER],
  /** The panel's closed shadow root, for layout measurements. */
  panelRoot: () => (panel as unknown as { root: ShadowRoot } | null)?.root ?? null,
};

(window as unknown as { __stage: typeof stage }).__stage = stage;
