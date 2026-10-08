/**
 * The reader is an UNLISTED script, not a declared content script.
 *
 * Declaring a content script -- even a runtime-registered one -- makes WXT add
 * host_permissions for its match patterns, which is what produces Chrome's
 * "read and change all your data on all websites" prompt at install. Injecting
 * on demand instead means activeTab is genuinely sufficient: the grant arrives
 * when the user clicks the toolbar icon or presses the hotkey, and a default
 * install asks for nothing.
 */

import { browser } from 'wxt/browser';
import { collectDocument, UI_MARKER } from '../lib/extract/collector';
import { PlayerController } from '../lib/player/controller';
import { webSpeechEngine } from '../lib/engines/webspeech';
import { createHighlighter } from '../lib/highlight/renderer';
import { AutoScroller } from '../lib/highlight/autoscroll';
import { DEFAULT_THEME, HIGH_CONTRAST_THEME } from '../lib/highlight/theme';
import { ReaderPanel, type PanelGeometry } from '../ui/panel/panel';
import {
  DEFAULT_SETTINGS,
  loadRateQuantization,
  loadSettings,
  loadVoiceCapabilities,
  recordVoiceCapability,
  saveRateQuantization,
  saveSettings,
  type Settings,
} from '../lib/settings';
import { probeRateQuantization } from '../lib/engines/rate-probe';
import { ladderFor, stepLadder } from '../lib/player/rate';
import type { CollectOptions } from '../lib/extract/collector';
import {
  unwrap,
  wrap,
  type ReaderCommand,
  type ReaderResponse,
} from '../lib/messaging';
import type { Voice } from '../lib/engines/types';
import { findPreset, matchPreset } from '../lib/player/presets';
import {
  clearResumePoint,
  findResumeIndex,
  loadResumePoint,
  saveResumePoint,
} from '../lib/resume';

/** Below this a "selection" is almost always a stray drag, not an intent to
 *  read. Long enough to exclude accidents, short enough for one sentence. */
const MIN_SELECTION_CHARS = 15;

const INSTANCE_KEY = '__whisperReaderInstance';

interface ReaderInstance {
  command(command: ReaderCommand): ReaderResponse | undefined;
  destroy(): void;
}

/** Pick the calmest voice that speaks the page's language. listVoices already
 *  sorts by our curated ranking, so the first match is the best one. */
function pickVoice(
  voices: readonly Voice[],
  preferredId: string | null,
  lang: string,
): Voice | null {
  if (preferredId) {
    const saved = voices.find((v) => v.id === preferredId);
    if (saved) return saved;
  }
  const base = (lang.split('-')[0] ?? 'en').toLowerCase();
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  return (matching[0] ?? voices[0]) ?? null;
}

/** Never hijack a key the user is typing into -- the page's search box, a
 *  comment field, or our own panel controls. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  if (el.hasAttribute?.(UI_MARKER)) return true;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  );
}

interface CaretHit {
  node: Text;
  offset: number;
}

/**
 * The text position under a viewport point.
 *
 * Two APIs do this and neither is universal: caretPositionFromPoint is the
 * standard and shipped in Firefox first, caretRangeFromPoint is the older
 * WebKit/Blink spelling. Chrome only gained the standard one recently, so both
 * are still needed.
 */
function caretPositionFrom(x: number, y: number): CaretHit | null {
  const doc = document as Document & {
    caretPositionFromPoint?(
      x: number,
      y: number,
    ): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };

  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    if (position?.offsetNode.nodeType === Node.TEXT_NODE) {
      return { node: position.offsetNode as Text, offset: position.offset };
    }
  }

  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range?.startContainer.nodeType === Node.TEXT_NODE) {
      return { node: range.startContainer as Text, offset: range.startOffset };
    }
  }

  return null;
}

const COLLECT: CollectOptions = {
  expandAbbreviations: true,
  stripFootnoteMarkers: true,
  urls: 'link',
  code: 'skip',
};

function createReader(): ReaderInstance {
  // Start on defaults so the panel is usable the instant it appears; stored
  // preferences overwrite this a tick later.
  let settings: Settings = { ...DEFAULT_SETTINGS };
  /** Set once the rate probe has answered; picks the ladder + and - walk. */
  let rateQuantized = false;

  const highlighter = createHighlighter(document, DEFAULT_THEME);
  const scroller = new AutoScroller(window);
  let voices: readonly Voice[] = [];
  let destroyed = false;

  const player = new PlayerController(
    webSpeechEngine,
    highlighter,
    {
      onState: (state) => panel.setState(state),
      onSentenceChange: (range) => {
        scroller.follow(range);
        rememberPosition();
      },
      onVoiceCapability: (voiceId, support) => {
        void recordVoiceCapability(voiceId, support);
        // Re-label the voice in the picker so the user learns what they got.
        voices = voices.map((v) =>
          v.id === voiceId ? { ...v, wordTimings: support } : v,
        );
        panel.setVoices([...voices], player.getState().voiceId);
        panel.setState(player.getState());
      },
    },
  );

  const persistGeometry = (geometry: PanelGeometry) => {
    settings = { ...settings, panel: geometry };
    void saveSettings({ panel: geometry });
  };

  const panel = new ReaderPanel(document, {
    onPlayPause: () => {
      if (player.getState().status !== 'speaking') rescanIfStale();
      player.toggle();
    },
    onStop: () => {
      void clearResumePoint(location.href);
      lastRemembered = -1;
      player.stop();
    },
    onSkip: (direction, unit) => player.skip(direction, unit),
    onBoost: (on) => player.setBoost(on),
    onRate: (rate) => {
      player.setRate(rate);
      settings = { ...settings, rate, preset: 'custom' };
      panel.setPreset('custom');
      void saveSettings({ rate, preset: 'custom' });
    },
    onVoice: (voiceId) => {
      const voice = voices.find((v) => v.id === voiceId) ?? null;
      player.setVoice(voice);
      settings = { ...settings, voiceId };
      void saveSettings({ voiceId });
    },
    onWordHighlight: (on) => {
      player.updateSettings({ wordHighlight: on });
      settings = { ...settings, wordHighlight: on };
      void saveSettings({ wordHighlight: on });
    },
    onPreset: (id) => {
      const preset = findPreset(id);
      // 'custom' has no settings of its own; it just records that the user has
      // taken manual control, so the speed slider stops being overwritten.
      if (!preset) {
        settings = { ...settings, preset: id };
        void saveSettings({ preset: id });
        return;
      }
      settings = { ...settings, ...preset.settings, preset: id };
      player.updateSettings(preset.settings);
      void saveSettings({ ...preset.settings, preset: id });
    },
    onTheme: (choice) => {
      settings = { ...settings, theme: choice };
      void saveSettings({ theme: choice });
    },
    onGeometry: persistGeometry,
    onClose: () => instance.destroy(),
  });

  // --------------------------------------------------------------- keyboard

  /** One rung of the speed ladder per press, so every press is a speed you
   *  can actually hear -- never 0.1 into the same engine step. */
  const nudgeRate = (direction: 1 | -1): void => {
    player.setRate(
      stepLadder(player.getState().rate, ladderFor(rateQuantized), direction),
    );
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey) return;
    const paragraph = event.shiftKey ? 'paragraph' : 'sentence';

    switch (event.key) {
      case ' ':
      case 'k':
        if (player.getState().status !== 'speaking') rescanIfStale();
        player.toggle();
        break;
      case 'j':
      case 'ArrowLeft':
        player.skip(-1, paragraph);
        break;
      case 'l':
      case 'ArrowRight':
        player.skip(1, paragraph);
        break;
      case 'f':
        // keydown repeats while held; only the first should start the boost.
        if (!event.repeat) player.setBoost(true);
        break;
      case '+':
      case '=':
        nudgeRate(1);
        break;
      case '-':
        nudgeRate(-1);
        break;
      case 'Escape':
        instance.destroy();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'f') player.setBoost(false);
  };

  // Releasing the key outside the page never fires keyup, which would leave
  // the voice stuck at 2x. Drop the boost whenever focus leaves.
  const onBlur = (): void => player.setBoost(false);

  /** Alt+click a paragraph to start reading from there. Alt, not a bare
   *  click, so we never swallow a link the user meant to follow. */
  const onClick = (event: MouseEvent): void => {
    if (!event.altKey) return;
    const model = player.document;
    if (!model) return;

    const target = event.target as Element | null;
    if (!target || target.hasAttribute?.(UI_MARKER)) return;

    const block = model.blocks.find((b) => b.element.contains(target));
    if (!block) return;
    const index = model.sentences.findIndex((s) => s.blockId === block.id);
    if (index < 0) return;

    event.preventDefault();
    player.play(index);
  };

  /**
   * Read whatever the user has selected, starting at the selection.
   *
   * This is the escape hatch. Page-wide collection is a pile of heuristics and
   * some site will always defeat them; a selection is the user telling us
   * exactly what they want read, so it is collected with `trustEverything` and
   * bypasses every visibility and furniture rule. If reading a page ever fails,
   * selecting the text still works.
   */
  const readSelection = (): boolean => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    if (range.toString().trim().length < MIN_SELECTION_CHARS) return false;

    const container = range.commonAncestorContainer;
    const root =
      container instanceof Element ? container : container.parentElement;
    if (!root || root.hasAttribute?.(UI_MARKER)) return false;

    player.load(
      collectDocument(document, { ...COLLECT, root, trustEverything: true }),
    );
    scannedTextLength = document.body?.textContent?.length ?? 0;

    // Begin at the word the selection starts on rather than at the top of the
    // enclosing element, so reading starts where the user actually pointed.
    const start =
      range.startContainer.nodeType === Node.TEXT_NODE
        ? player.locate(range.startContainer as Text, range.startOffset)
        : null;

    selection.removeAllRanges();
    if (start) player.playFrom(start.sentenceIndex, start.wordIndex);
    else player.play(0);
    return true;
  };

  /**
   * Double-click a word to start reading from exactly that word.
   *
   * The browser's own double-click already selects the word under the cursor,
   * which gives us the caret position for free and means the gesture is
   * pointing at something the user can see. We clear that selection afterwards
   * so it does not sit on top of our own highlight.
   */
  const onDoubleClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (target?.hasAttribute?.(UI_MARKER)) return;

    const caret = caretPositionFrom(event.clientX, event.clientY);
    if (!caret) return;

    const found = player.locate(caret.node, caret.offset);
    if (!found) return;

    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    player.playFrom(found.sentenceIndex, found.wordIndex);
  };

  /** Finishing a drag over text reads it, mirroring double-click-to-start. */
  const onMouseUp = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (target?.hasAttribute?.(UI_MARKER)) return;
    // Let the selection settle before reading it; on mouseup the browser has
    // not always finished extending it to the final word.
    setTimeout(() => {
      if (!destroyed) readSelection();
    }, 0);
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('click', onClick, true);
  document.addEventListener('dblclick', onDoubleClick, true);
  document.addEventListener('mouseup', onMouseUp, true);

  // -------------------------------------------------------------- lifecycle

  /** Size of the document the last scan was built from, so we can tell
   *  whether re-scanning would actually find anything new. */
  let scannedTextLength = 0;

  let lastRemembered = -1;

  /**
   * Save the reading position so returning to this page picks up where it
   * stopped. Writes only when the sentence actually changes -- this fires on
   * every sentence, and storage writes are not free.
   */
  const rememberPosition = (): void => {
    const model = player.document;
    const index = player.sentenceIndex;
    if (!model || index === lastRemembered) return;

    const ref = model.sentences[index];
    const block = ref ? model.blocks[ref.blockId] : undefined;
    if (!ref || !block) return;

    lastRemembered = index;
    void saveResumePoint(location.href, {
      index,
      text: block.text.slice(ref.span.start, ref.span.end),
      savedAt: Date.now(),
    });
  };

  /** Move the cursor to where this page was last left off, if it is still
   *  findable. Never starts playback on its own -- silently talking on page
   *  load would be alarming. */
  const restorePosition = async (): Promise<void> => {
    const point = await loadResumePoint(location.href);
    const model = player.document;
    if (!point || !model || destroyed) return;

    const texts = model.sentences.map((ref) => {
      const block = model.blocks[ref.blockId];
      return { text: block ? block.text.slice(ref.span.start, ref.span.end) : '' };
    });

    const index = findResumeIndex(texts, point);
    if (index === null) return;

    lastRemembered = index;
    player.jumpTo(index);
    panel.announce('Resuming where you left off');
  };

  const rescan = (root?: Element): void => {
    player.load(collectDocument(document, root ? { ...COLLECT, root } : COLLECT));
    scannedTextLength = document.body?.textContent?.length ?? 0;
  };

  /**
   * Re-scan before starting if the page has grown since we looked.
   *
   * We collect once, at injection. Client-rendered sites frequently finish
   * hydrating, lazy-load sections, or expand "read more" after that moment,
   * and everything arriving late was simply invisible to the reader. Checking
   * a single length before playback is far cheaper than a MutationObserver
   * running for the whole session, and it catches the case that matters:
   * the user pressing play once the page has settled.
   */
  const rescanIfStale = (): void => {
    const now = document.body?.textContent?.length ?? 0;
    if (scannedTextLength === 0) return;

    // 5% is comfortably above the noise of a clock ticking or a counter
    // updating, and well below a section of prose appearing.
    const grew = now > scannedTextLength * 1.05;
    const shrank = now < scannedTextLength * 0.8;
    if (!grew && !shrank) return;

    const previous = player.document?.sentences[player.sentenceIndex];
    const anchor = previous
      ? player.document?.blocks[previous.blockId]?.text.slice(
          previous.span.start,
          previous.span.end,
        )
      : undefined;

    rescan();

    // Put the cursor back on the sentence we were reading, if it survived.
    if (anchor) {
      const model = player.document;
      const index = model?.sentences.findIndex((ref) => {
        const block = model.blocks[ref.blockId];
        return block?.text.slice(ref.span.start, ref.span.end) === anchor;
      });
      if (index !== undefined && index >= 0) player.jumpTo(index);
    }
  };

  const instance: ReaderInstance = {
    command(command) {
      switch (command.type) {
        case 'ping':
          break;
        case 'start': {
          if (command.from === 'selection') {
            if (readSelection()) break;
          }
          rescanIfStale();
          player.play();
          break;
        }
        case 'toggle':
          if (player.getState().status !== 'speaking') rescanIfStale();
          player.toggle();
          break;
        case 'stop':
          // Stopping is an explicit "I am done here", so drop the bookmark.
          void clearResumePoint(location.href);
          lastRemembered = -1;
          player.stop();
          break;
        case 'skip':
          player.skip(command.direction, command.unit);
          break;
        case 'boost':
          player.setBoost(command.on);
          break;
        case 'setRate':
          player.setRate(command.rate);
          // Any explicit speed is a custom setting; leaving the preset named
          // would have it re-applied over this on the next load.
          settings = { ...settings, rate: command.rate, preset: 'custom' };
          void saveSettings({ rate: command.rate, preset: 'custom' });
          break;
        case 'setVoice': {
          const voice = voices.find((v) => v.id === command.voiceId) ?? null;
          player.setVoice(voice);
          void saveSettings({ voiceId: command.voiceId });
          break;
        }
        case 'setWordHighlight':
          player.updateSettings({ wordHighlight: command.on });
          void saveSettings({ wordHighlight: command.on });
          break;
        case 'close':
          instance.destroy();
          return undefined;
        case 'getStatus':
          break;
      }
      return { present: true, state: player.getState(), voices: [...voices] };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('dblclick', onDoubleClick, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      player.destroy();
      panel.destroy();
      highlighter.destroy();
      scroller.destroy();
      delete (window as unknown as Record<string, unknown>)[INSTANCE_KEY];
    },
  };

  // Collect BEFORE any await.
  //
  // This used to live inside the async initialiser, after `await
  // loadSettings()`. That made the document's availability depend on a storage
  // round trip completing: any hang or rejection there left the panel visible
  // but the document empty, and every play command silently did nothing --
  // exactly the "it just doesn't work on this site" symptom, with no error to
  // show for it. Nothing about scanning the page needs stored preferences.
  rescan();

  // Everything above is synchronous so the panel appears immediately; the
  // asynchronous parts (stored preferences, the voice list) fill in behind it.
  void (async () => {
    settings = await loadSettings();
    if (destroyed) return;

    player.updateSettings({
      rate: settings.rate,
      pitch: settings.pitch,
      volume: settings.volume,
      wordHighlight: settings.wordHighlight,
      sentencePauseMs: settings.sentencePauseMs,
      paragraphPauseMs: settings.paragraphPauseMs,
      headingPauseMs: settings.headingPauseMs,
    });
    void applyRateQuantization();
    panel.setPreset(settings.preset ?? matchPreset(settings));
    panel.setTheme(settings.theme ?? 'system');
    scroller.setEnabled(settings.autoScroll);
    highlighter.setTheme(
      settings.highContrast
        ? { ...HIGH_CONTRAST_THEME, underlineOnly: settings.underlineOnly }
        : { ...DEFAULT_THEME, underlineOnly: settings.underlineOnly },
    );

    const [available, cached] = await Promise.all([
      webSpeechEngine.listVoices(),
      loadVoiceCapabilities(),
    ]);
    if (destroyed) return;

    // Apply what we already learned about each voice, so a returning user is
    // told up front which voices cannot do word highlighting.
    voices = available.map((v) => {
      const known = cached[v.id];
      return known ? { ...v, wordTimings: known } : v;
    });

    await restorePosition();
    if (destroyed) return;

    const chosen = pickVoice(voices, settings.voiceId, player.document?.lang ?? 'en');
    player.setVoice(chosen);
    panel.setVoices([...voices], chosen?.id ?? null);
    panel.setState(player.getState());
  })();

  /**
   * Find out how many real speeds this engine has, and tell the slider.
   *
   * Cached, because it is a property of the browser and the operating system
   * rather than of the page. When there is no cached verdict the probe runs
   * here -- two silent utterances, about four seconds -- but only while the
   * player is idle, and it abandons itself the moment the user presses play.
   * See lib/player/rate.ts for what the answer is used for.
   */
  async function applyRateQuantization(): Promise<void> {
    let quantized = await loadRateQuantization();
    if (destroyed) return;

    if (quantized === null) {
      const idle = () => !destroyed && player.getState().status === 'idle';
      const probe = await probeRateQuantization(null, idle);
      if (destroyed || !probe) return;
      quantized = probe.quantized;
      void saveRateQuantization(quantized);
    }

    if (destroyed) return;
    rateQuantized = quantized;
    player.updateSettings({ rateQuantized: quantized });
    panel.setRateLadder(quantized, settings.rate);
    panel.setState(player.getState());
  }

  return instance;
}

export default defineUnlistedScript(() => {
  const global = window as unknown as Record<string, ReaderInstance | undefined>;
  const existing = global[INSTANCE_KEY];
  if (existing) return;

  const instance = createReader();
  global[INSTANCE_KEY] = instance;

  browser.runtime.onMessage.addListener((message) => {
    const command = unwrap<ReaderCommand>(message);
    if (!command) return undefined;
    return Promise.resolve(wrap(instance.command(command)));
  });
});
