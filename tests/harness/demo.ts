/**
 * The whole reader, minus the extension plumbing, in a paste-able bundle.
 *
 * Everything except `lib/settings` and `lib/messaging` is browser-API free, so
 * the real collector, controller, engine, highlighter and panel can be driven
 * inside an ordinary page. This is how the visual half of the product gets
 * verified: unit tests cannot tell you whether the highlight actually paints,
 * or whether the panel is legible on a real site's background.
 */

import { collectDocument, DEFAULT_COLLECT_OPTIONS } from '../../lib/extract/collector';
import { PlayerController } from '../../lib/player/controller';
import { webSpeechEngine } from '../../lib/engines/webspeech';
import { createHighlighter } from '../../lib/highlight/renderer';
import { AutoScroller } from '../../lib/highlight/autoscroll';
import { DEFAULT_THEME } from '../../lib/highlight/theme';
import { ReaderPanel } from '../../ui/panel/panel';
import type { Voice } from '../../lib/engines/types';
import { findPreset } from '../../lib/player/presets';
import { probeRateQuantization } from '../../lib/engines/rate-probe';

export interface Demo {
  player: PlayerController;
  panel: ReaderPanel;
  voices: Voice[];
  /** Highlight a sentence without speaking, so rendering can be checked
   *  on machines with no installed voices. */
  highlightSentence(index: number): string | null;
  startAtPoint(x: number, y: number): unknown;
  readSelection(): unknown;
  summary(): Record<string, unknown>;
  destroy(): void;
}

async function start(): Promise<Demo> {
  const highlighter = createHighlighter(document, DEFAULT_THEME);
  const scroller = new AutoScroller(window);

  const player = new PlayerController(webSpeechEngine, highlighter, {
    onState: (state) => panel.setState(state),
    onSentenceChange: (range) => scroller.follow(range),
  });

  const panel = new ReaderPanel(document, {
    onPlayPause: () => player.toggle(),
    onStop: () => player.stop(),
    onSkip: (direction, unit) => player.skip(direction, unit),
    onBoost: (on) => player.setBoost(on),
    onRate: (rate) => player.setRate(rate),
    onVoice: (id) => player.setVoice(voices.find((v) => v.id === id) ?? null),
    onWordHighlight: (on) => player.updateSettings({ wordHighlight: on }),
    onPreset: (id) => { const p = findPreset(id); if (p) player.updateSettings(p.settings); },
    onTheme: () => {},
    onGeometry: () => {},
    onClose: () => demo.destroy(),
  });

  player.load(collectDocument(document, DEFAULT_COLLECT_OPTIONS));

  const voices = await webSpeechEngine.listVoices();
  const chosen = voices[0] ?? null;
  player.setVoice(chosen);
  panel.setVoices(voices, chosen?.id ?? null);
  panel.setState(player.getState());

  // Mirrors the reader: measure how many speeds this engine really has and
  // hand the resulting ladder to the panel, so the speed slider here behaves
  // exactly as it does in the extension.
  void probeRateQuantization(
    null,
    () => player.getState().status === 'idle',
  ).then((probe) => {
    if (!probe) return;
    player.updateSettings({ rateQuantized: probe.quantized });
    panel.setRateLadder(probe.quantized, player.getState().rate);
    panel.setState(player.getState());
  });

  const demo: Demo = {
    player,
    panel,
    voices,

    readSelection() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { ok: false, why: 'no selection' };
      const range = sel.getRangeAt(0);
      if (range.toString().trim().length < 15) return { ok: false, why: 'too short' };
      const c = range.commonAncestorContainer;
      const root = c instanceof Element ? c : c.parentElement;
      if (!root) return { ok: false, why: 'no root' };
      player.load(collectDocument(document, { ...DEFAULT_COLLECT_OPTIONS, root, trustEverything: true }));
      const start = range.startContainer.nodeType === Node.TEXT_NODE
        ? player.locate(range.startContainer as Text, range.startOffset) : null;
      const model = player.document;
      sel.removeAllRanges();
      if (start) player.playFrom(start.sentenceIndex, start.wordIndex); else player.play(0);
      return { ok: true, blocks: model?.blocks.length ?? 0, sentences: model?.sentences.length ?? 0, start };
    },

    startAtPoint(x, y) {
      const doc = document as Document & {
        caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?(x: number, y: number): Range | null;
      };
      let node: Text | null = null;
      let offset = 0;
      const pos = doc.caretPositionFromPoint?.(x, y);
      if (pos && pos.offsetNode.nodeType === Node.TEXT_NODE) {
        node = pos.offsetNode as Text;
        offset = pos.offset;
      } else {
        const r = doc.caretRangeFromPoint?.(x, y);
        if (r && r.startContainer.nodeType === Node.TEXT_NODE) {
          node = r.startContainer as Text;
          offset = r.startOffset;
        }
      }
      if (!node) return { ok: false, why: 'no caret' };
      const found = player.locate(node, offset);
      if (!found) return { ok: false, why: 'not in a read block', clicked: node.data.slice(Math.max(0, offset - 8), offset + 8) };
      player.playFrom(found.sentenceIndex, found.wordIndex);
      return { ok: true, ...found };
    },

    highlightSentence(index) {
      const model = player.document;
      const ref = model?.sentences[index];
      if (!model || !ref) return null;
      const block = model.blocks[ref.blockId]!;
      const sentence = block.map.rangeFor(ref.span.start, ref.span.end);

      // Also light up one word inside it, to prove both layers paint.
      const text = block.text.slice(ref.span.start, ref.span.end);
      const offset = text.indexOf(' ') + 1;
      const wordEnd = text.indexOf(' ', offset);
      const word =
        offset > 0 && wordEnd > offset
          ? block.map.rangeFor(
              ref.span.start + offset,
              ref.span.start + wordEnd,
            )
          : null;

      highlighter.show(sentence, word);
      scroller.follow(sentence);
      return sentence ? sentence.toString() : null;
    },

    summary() {
      const model = player.document;
      return {
        highlighter: highlighter.constructor.name,
        customHighlightSupported:
          typeof CSS !== 'undefined' && 'highlights' in CSS,
        blocks: model?.blocks.length ?? 0,
        sentences: model?.sentences.length ?? 0,
        voiceCount: voices.length,
        topVoices: voices
          .slice(0, 6)
          .map((v) => `${v.name} [${v.lang}] score=${v.calmScore} words=${v.wordTimings}`),
        state: player.getState(),
        remainingMs: player.getState().remainingMs,
      };
    },

    destroy() {
      player.destroy();
      panel.destroy();
      highlighter.destroy();
      scroller.destroy();
      delete (globalThis as Record<string, unknown>).__calmDemo;
    },
  };

  (globalThis as unknown as { __calmDemo: Demo }).__calmDemo = demo;
  return demo;
}

(globalThis as unknown as { __calmStart: typeof start }).__calmStart = start;
