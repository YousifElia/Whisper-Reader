/**
 * The in-page player.
 *
 * This is the surface the user actually operates, and it lives in the page
 * rather than in the toolbar popup for one unavoidable reason: a browser
 * action popup cannot be resized by the user and closes the instant it loses
 * focus. Neither is acceptable for a control you keep open while reading.
 *
 * Built with plain DOM rather than Svelte. Mounting a framework inside a
 * closed shadow root from an on-demand injected script means hand-plumbing
 * the component CSS that the bundler would normally emit as a separate file --
 * real coupling to build output, for a widget this size. The popup and options
 * pages, which are ordinary extension pages, still use Svelte.
 */

import type { PlayerState, SkipUnit } from '../../lib/player/controller';
import type { Voice } from '../../lib/engines/types';
import { UI_MARKER } from '../../lib/extract/collector';
import { PRESETS, type PresetId } from '../../lib/player/presets';
import {
  formatRate,
  ladderFor,
  ladderIndex,
} from '../../lib/player/rate';
import { voiceAdvice } from '../../lib/engines/voice-advice';
import { PANEL_STYLES, type ThemeChoice } from './styles';
import {
  COMPACT_HEIGHT,
  DEFAULT_GEOMETRY,
  EDGE_GAP,
  MIN_HEIGHT,
  MIN_WIDTH,
  type PanelGeometry,
  type PanelMode,
} from './geometry';

export {
  COMPACT_HEIGHT,
  DEFAULT_GEOMETRY,
  type PanelGeometry,
  type PanelMode,
} from './geometry';
export type { ThemeChoice } from './styles';



/** Settle time before a mid-drag rate change is sent to the engine. */
const RATE_COMMIT_DELAY_MS = 220;

export interface PanelCallbacks {
  onPlayPause(): void;
  onStop(): void;
  onSkip(direction: 1 | -1, unit: SkipUnit): void;
  onBoost(on: boolean): void;
  onRate(rate: number): void;
  onVoice(voiceId: string): void;
  onWordHighlight(on: boolean): void;
  onPreset(id: PresetId): void;
  onTheme(choice: ThemeChoice): void;
  onGeometry(geometry: PanelGeometry): void;
  onClose(): void;
}

const ICON = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  stop: 'M6 6h12v12H6z',
  prev: 'M6 6h2v12H6zm12 0v12l-9-6z',
  next: 'M16 6h2v12h-2zM6 6l9 6-9 6z',
  fast: 'M4 6l8 6-8 6zm9 0l8 6-8 6z',
  expand: 'M4 10V4h6M20 14v6h-6',
  collapse: 'M10 4v6H4M14 20v-6h6',
  close: 'M6 6l12 12M18 6L6 18',
};

function svg(path: string, filled = true): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  if (filled) {
    p.setAttribute('fill', 'currentColor');
  } else {
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
  }
  node.appendChild(p);
  return node;
}



/**
 * "8 min", "45s", or nothing at all.
 *
 * Deliberately coarse above a minute: a second-by-second countdown on a
 * twenty-minute article is noise, and watching it tick is the opposite of what
 * this extension is for.
 */
function formatRemaining(ms: number | null): string {
  if (ms === null || ms <= 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function button(
  label: string,
  path: string,
  onClick: () => void,
  opts: { filled?: boolean; className?: string } = {},
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  if (opts.className) b.className = opts.className;
  b.appendChild(svg(path, opts.filled ?? true));
  b.addEventListener('click', onClick);
  return b;
}

export class ReaderPanel {
  private readonly host: HTMLDivElement;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly playButton: HTMLButtonElement;
  private readonly expandButton: HTMLButtonElement;
  private readonly progressFill: HTMLElement;
  private readonly rateLabel: HTMLElement;
  private readonly remainingLabel: HTMLElement;
  private readonly live: HTMLElement;
  private voiceSelect: HTMLSelectElement | null = null;
  private rateSlider: HTMLInputElement | null = null;
  private rateValue: HTMLElement | null = null;
  private rateHint: HTMLElement | null = null;
  /**
   * The speeds this engine can actually produce, in order.
   *
   * A free-running slider was the wrong control: on Chromium/Windows the
   * engine only has seven real speeds between 0.5x and 2x, so most of the
   * slider's travel did nothing and the rest jumped 26% at a time. The slider
   * now indexes this list, which means every notch is an audible change and
   * none of them is a leap. Replaced once the engine has been probed.
   */
  private ladder: readonly number[] = ladderFor(false);
  private wordToggle: HTMLInputElement | null = null;
  private timingNote: HTMLElement | null = null;
  private presetSelect: HTMLSelectElement | null = null;
  private presetNote: HTMLElement | null = null;
  private adviceBox: HTMLElement | null = null;
  private emptyNote: HTMLElement | null = null;
  private rateCommitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly themeButtons = new Map<ThemeChoice, HTMLButtonElement>();
  private theme: ThemeChoice = 'system';
  /**
   * Has the user actually placed this panel?
   *
   * Until they do, it stays anchored to the bottom-right on every resize.
   * Anchoring once at construction meant a window resized afterwards left the
   * panel stranded mid-page, on top of the article it is meant to be reading.
   * Once dragged or resized, the user's position is respected and only clamped.
   */
  private userPlaced = false;
  private viewportWatcher: ResizeObserver | null = null;

  private geometry: PanelGeometry;
  private state: PlayerState | null = null;
  private voices: Voice[] = [];

  constructor(
    private readonly doc: Document,
    private readonly callbacks: PanelCallbacks,
    geometry: PanelGeometry = DEFAULT_GEOMETRY,
  ) {
    this.geometry = { ...geometry };
    // A stored non-negative position means they placed it in a past session.
    this.userPlaced = geometry.x >= 0 && geometry.y >= 0;

    this.host = doc.createElement('div');
    this.host.setAttribute(UI_MARKER, 'panel');
    // The host must take up no layout space at all. Left unstyled it is an
    // ordinary block element at the end of the document, which pads the page's
    // scroll height with an empty strip below the real content. Zero-sized and
    // fixed, it anchors the shadow tree without participating in flow; the
    // panel inside is itself position:fixed and lays out against the viewport.
    this.host.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    this.root = this.host.attachShadow({ mode: 'closed' });

    const style = doc.createElement('style');
    style.textContent = PANEL_STYLES;
    this.root.appendChild(style);

    this.panel = doc.createElement('div');
    this.panel.className = 'panel';
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', 'Whisper Reader player');

    // Announce transport changes to screen readers without stealing focus.
    this.live = doc.createElement('div');
    this.live.className = 'sr';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');

    const bar = doc.createElement('div');
    bar.className = 'bar';

    const grip = doc.createElement('div');
    grip.className = 'grip';
    grip.title = 'Drag to move';
    grip.appendChild(doc.createElement('span'));
    grip.addEventListener('pointerdown', this.startDrag);

    this.playButton = button('Play', ICON.play, () => callbacks.onPlayPause(), {
      className: 'play',
    });

    const prev = button('Previous sentence', ICON.prev, () => {});
    prev.addEventListener('click', (e) =>
      callbacks.onSkip(-1, e.shiftKey ? 'paragraph' : 'sentence'),
    );
    const next = button('Next sentence', ICON.next, () => {});
    next.addEventListener('click', (e) =>
      callbacks.onSkip(1, e.shiftKey ? 'paragraph' : 'sentence'),
    );

    // Press and hold to speed up, release to drop back. A click handler
    // cannot express this, so it is wired to pointer down/up directly.
    const fast = button('Hold to fast forward', ICON.fast, () => {});
    fast.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      fast.setPointerCapture(e.pointerId);
      callbacks.onBoost(true);
    });
    const endBoost = () => callbacks.onBoost(false);
    fast.addEventListener('pointerup', endBoost);
    fast.addEventListener('pointercancel', endBoost);

    const stop = button('Stop', ICON.stop, () => callbacks.onStop());

    this.progressFill = doc.createElement('i');
    const progress = doc.createElement('div');
    progress.className = 'progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', 'Reading progress');
    progress.appendChild(this.progressFill);

    // Time left sits next to the progress bar: the single most useful thing
    // to know while listening, and it costs one short label.
    this.remainingLabel = doc.createElement('span');
    this.remainingLabel.className = 'rate remaining';
    this.remainingLabel.textContent = '';

    this.rateLabel = doc.createElement('span');
    this.rateLabel.className = 'rate';
    this.rateLabel.textContent = '1.0x';

    this.expandButton = button('Expand', ICON.expand, () => this.toggleMode(), {
      filled: false,
    });
    const close = button('Close', ICON.close, () => callbacks.onClose(), {
      filled: false,
    });

    // Time left and speed share one stacked readout. Side by side they cost
    // 72px, and with eleven items in the bar that pushed Close past the
    // panel's edge: half hidden at the default 380px width, and Expand and
    // Close both gone at the 320px minimum.
    const readout = doc.createElement('div');
    readout.className = 'readout';
    readout.append(this.remainingLabel, this.rateLabel);

    bar.append(
      grip,
      this.playButton,
      prev,
      next,
      fast,
      stop,
      progress,
      readout,
      this.expandButton,
      close,
    );

    this.body = doc.createElement('div');
    this.body.className = 'body';
    this.buildBody();

    const resize = doc.createElement('div');
    resize.className = 'resize';
    resize.title = 'Drag to resize';
    resize.setAttribute('aria-hidden', 'true');
    resize.addEventListener('pointerdown', this.startResize);

    this.panel.append(this.live, bar, this.body, resize);
    this.root.appendChild(this.panel);
    doc.documentElement.appendChild(this.host);

    this.applyGeometry();
    this.doc.defaultView?.addEventListener('resize', this.clampToViewport);

    // A hidden or not-yet-laid-out tab reports a zero viewport and fires no
    // resize event when it finally gets one, so watch the document element.
    if (typeof ResizeObserver === 'function') {
      this.viewportWatcher = new ResizeObserver(() => this.clampToViewport());
      this.viewportWatcher.observe(doc.documentElement);
    }
  }

  // ------------------------------------------------------------- full mode

  private buildBody(): void {
    const doc = this.doc;

    this.emptyNote = doc.createElement('p');
    this.emptyNote.className = 'note warn';
    this.emptyNote.style.display = 'none';
    this.emptyNote.textContent =
      'No readable text found on this page. Select any text and it will be ' +
      'read aloud from there.';

    const voiceField = doc.createElement('div');
    voiceField.className = 'field';
    const voiceLabel = doc.createElement('label');
    voiceLabel.textContent = 'Voice';
    voiceLabel.htmlFor = 'calm-voice';
    this.voiceSelect = doc.createElement('select');
    this.voiceSelect.id = 'calm-voice';
    this.voiceSelect.addEventListener('change', () => {
      if (this.voiceSelect) this.callbacks.onVoice(this.voiceSelect.value);
    });
    this.timingNote = doc.createElement('p');
    this.timingNote.className = 'note';

    // Shown only when every available voice scores poorly. Both Windows and
    // macOS ship far better neural voices for free; they are simply not
    // installed by default and almost nobody knows they exist.
    this.adviceBox = doc.createElement('div');
    this.adviceBox.className = 'advice';
    this.adviceBox.style.display = 'none';

    voiceField.append(voiceLabel, this.voiceSelect, this.timingNote, this.adviceBox);

    const presetField = doc.createElement('div');
    presetField.className = 'field';
    const presetLabel = doc.createElement('label');
    presetLabel.textContent = 'Pacing';
    presetLabel.htmlFor = 'calm-preset';
    this.presetSelect = doc.createElement('select');
    this.presetSelect.id = 'calm-preset';
    for (const preset of PRESETS) {
      const option = doc.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      this.presetSelect.appendChild(option);
    }
    const customOption = doc.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = 'Custom';
    this.presetSelect.appendChild(customOption);

    this.presetNote = doc.createElement('p');
    this.presetNote.className = 'note';
    this.presetSelect.addEventListener('change', () => {
      if (!this.presetSelect) return;
      const id = this.presetSelect.value as PresetId;
      this.describePreset(id);
      this.callbacks.onPreset(id);
    });
    presetField.append(presetLabel, this.presetSelect, this.presetNote);

    const rateField = doc.createElement('div');
    rateField.className = 'field';
    const rateLabelEl = doc.createElement('label');
    rateLabelEl.textContent = 'Speed';
    rateLabelEl.htmlFor = 'calm-rate';
    const rateRow = doc.createElement('div');
    rateRow.className = 'row';
    this.rateSlider = doc.createElement('input');
    this.rateSlider.type = 'range';
    this.rateSlider.id = 'calm-rate';
    this.rateSlider.step = '1';
    this.rateValue = doc.createElement('span');
    this.rateValue.className = 'value';
    this.applyLadderToSlider(0.9);

    // `input` fires continuously while dragging. Applying each one restarted
    // the utterance dozens of times across a single drag, which stuttered the
    // audio and threw the highlight around -- the "highlight doesn't follow
    // above 1x" bug. The label tracks the thumb; the engine hears the final
    // value once the drag settles, and immediately on release.
    const commitRate = () => {
      if (!this.rateSlider) return;
      this.callbacks.onRate(this.rateAt(Number(this.rateSlider.value)));
    };
    this.rateSlider.addEventListener('input', () => {
      if (!this.rateSlider) return;
      const rate = this.rateAt(Number(this.rateSlider.value));
      if (this.rateValue) this.rateValue.textContent = formatRate(rate);
      if (this.rateCommitTimer !== null) clearTimeout(this.rateCommitTimer);
      this.rateCommitTimer = setTimeout(commitRate, RATE_COMMIT_DELAY_MS);
    });
    this.rateSlider.addEventListener('change', () => {
      if (this.rateCommitTimer !== null) clearTimeout(this.rateCommitTimer);
      this.rateCommitTimer = null;
      commitRate();
    });
    rateRow.append(this.rateSlider, this.rateValue);
    this.rateHint = doc.createElement('p');
    this.rateHint.className = 'note';
    this.describeLadder();
    rateField.append(rateLabelEl, rateRow, this.rateHint);

    const wordField = doc.createElement('div');
    wordField.className = 'field';
    const check = doc.createElement('label');
    check.className = 'check';
    this.wordToggle = doc.createElement('input');
    this.wordToggle.type = 'checkbox';
    this.wordToggle.checked = true;
    this.wordToggle.addEventListener('change', () => {
      if (this.wordToggle) this.callbacks.onWordHighlight(this.wordToggle.checked);
    });
    const checkText = doc.createElement('span');
    checkText.textContent = 'Highlight each word';
    check.append(this.wordToggle, checkText);
    wordField.append(check);

    const themeField = doc.createElement('div');
    themeField.className = 'field';
    const themeLabel = doc.createElement('label');
    themeLabel.textContent = 'Appearance';
    const segmented = doc.createElement('div');
    segmented.className = 'segmented';
    segmented.setAttribute('role', 'group');
    segmented.setAttribute('aria-label', 'Appearance');

    const CHOICES: ReadonlyArray<[ThemeChoice, string]> = [
      ['system', 'System'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ];
    for (const [choice, label] of CHOICES) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = label;
      // aria-pressed rather than a checked radio: these are toggle buttons,
      // and it is what carries the selected state to assistive tech.
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        this.setTheme(choice);
        this.callbacks.onTheme(choice);
      });
      this.themeButtons.set(choice, b);
      segmented.appendChild(b);
    }
    themeField.append(themeLabel, segmented);

    this.body.append(
      this.emptyNote,
      voiceField,
      presetField,
      rateField,
      wordField,
      themeField,
    );
    this.setTheme('system');
    // setPreset, not describePreset: a <select> defaults to its first option
    // (Bedtime), so describing 'calm' alone left the control and its caption
    // disagreeing with each other.
    this.setPreset('calm');
  }

  private describePreset(id: PresetId): void {
    if (!this.presetNote) return;
    const preset = PRESETS.find((p) => p.id === id);
    this.presetNote.textContent = preset
      ? preset.description
      : 'Your own speed and pause settings.';
  }

  // ----------------------------------------------------------------- speed

  /**
   * Tell the panel which speeds this engine can really produce.
   *
   * Called once the rate probe has a verdict. Until then the finer ladder is
   * shown, which is the safe default: it offers speeds that may turn out to be
   * duplicates rather than hiding speeds that would have worked.
   */
  setRateLadder(quantized: boolean, currentRate: number): void {
    this.ladder = ladderFor(quantized);
    this.applyLadderToSlider(currentRate);
    this.describeLadder();
  }

  private rateAt(index: number): number {
    return this.ladder[index] ?? this.ladder[0] ?? 1;
  }

  private applyLadderToSlider(rate: number): void {
    if (!this.rateSlider) return;
    this.rateSlider.min = '0';
    this.rateSlider.max = String(this.ladder.length - 1);
    const index = ladderIndex(rate, this.ladder);
    this.rateSlider.value = String(index);
    this.rateSlider.setAttribute('aria-valuetext', formatRate(this.rateAt(index)));
    if (this.rateValue) this.rateValue.textContent = formatRate(this.rateAt(index));
  }

  private describeLadder(): void {
    if (!this.rateHint) return;
    const quantized = this.ladder === ladderFor(true);
    const boost = 'Hold the fast-forward button, or hold F, to skim at 2x. ';
    this.rateHint.textContent = quantized
      ? boost +
        'This browser has ' +
        this.ladder.length +
        ' real speeds, so the slider steps between them rather than sliding ' +
        'through settings that sound identical.'
      : boost + '2x is the ceiling: the fastest that still articulates.';
  }

  // ------------------------------------------------------------- geometry

  private applyGeometry(): void {
    const view = this.doc.defaultView;
    const vw = view?.innerWidth ?? 1200;
    const vh = view?.innerHeight ?? 800;
    const g = this.geometry;

    // Only commit a default position once the viewport is real. Resolving it
    // against zero pins the panel to the top-left and, because the coordinates
    // are then non-negative, it never gets another chance to place itself.
    if ((g.x < 0 || g.y < 0) && vw > 0 && vh > 0) {
      g.x = Math.max(EDGE_GAP, vw - g.width - EDGE_GAP);
      g.y = Math.max(EDGE_GAP, vh - COMPACT_HEIGHT - EDGE_GAP * 2);
    }

    const height = g.mode === 'compact' ? COMPACT_HEIGHT : g.height;
    this.panel.style.left = `${g.x}px`;
    this.panel.style.top = `${g.y}px`;
    this.panel.style.width = `${g.width}px`;
    this.panel.style.height = `${height}px`;

    const full = g.mode === 'full';
    this.body.style.display = full ? 'block' : 'none';
    this.expandButton.replaceChildren(
      svg(full ? ICON.collapse : ICON.expand, false),
    );
    this.expandButton.title = full ? 'Compact' : 'Expand';
    this.expandButton.setAttribute('aria-label', this.expandButton.title);
  }

  private clampToViewport = (): void => {
    const view = this.doc.defaultView;
    if (!view) return;
    const height =
      this.geometry.mode === 'compact' ? COMPACT_HEIGHT : this.geometry.height;

    // A viewport of zero means the page has not laid out yet, or the tab is
    // hidden. Positioning against it puts the panel in the top-left corner and
    // leaves it there; better to keep what we have and re-anchor once real
    // dimensions arrive.
    if (view.innerWidth === 0 || view.innerHeight === 0) return;

    if (!this.userPlaced) {
      // Never been placed: keep it pinned to the bottom-right corner.
      this.geometry.x = Math.max(
        EDGE_GAP,
        view.innerWidth - this.geometry.width - EDGE_GAP,
      );
      this.geometry.y = Math.max(
        EDGE_GAP,
        view.innerHeight - height - EDGE_GAP,
      );
      this.applyGeometry();
      return;
    }

    this.geometry.x = Math.min(
      Math.max(0, this.geometry.x),
      Math.max(0, view.innerWidth - this.geometry.width),
    );
    this.geometry.y = Math.min(
      Math.max(0, this.geometry.y),
      Math.max(0, view.innerHeight - height),
    );
    this.applyGeometry();
  };

  private toggleMode(): void {
    this.geometry.mode = this.geometry.mode === 'compact' ? 'full' : 'compact';
    this.clampToViewport();
    this.callbacks.onGeometry({ ...this.geometry });
  }

  private startDrag = (event: PointerEvent): void => {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const startX = event.clientX - this.geometry.x;
    const startY = event.clientY - this.geometry.y;

    const move = (e: PointerEvent) => {
      this.geometry.x = e.clientX - startX;
      this.geometry.y = e.clientY - startY;
      this.applyGeometry();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      this.userPlaced = true;
      this.clampToViewport();
      this.callbacks.onGeometry({ ...this.geometry });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  private startResize = (event: PointerEvent): void => {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    // Resizing implies you want the full panel; snapping to it here avoids a
    // confusing drag that appears to do nothing vertically.
    if (this.geometry.mode === 'compact') {
      this.geometry.mode = 'full';
      this.applyGeometry();
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const startW = this.geometry.width;
    const startH = this.geometry.height;

    const move = (e: PointerEvent) => {
      this.geometry.width = Math.max(MIN_WIDTH, startW + (e.clientX - startX));
      this.geometry.height = Math.max(MIN_HEIGHT, startH + (e.clientY - startY));
      this.applyGeometry();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      this.userPlaced = true;
      this.clampToViewport();
      this.callbacks.onGeometry({ ...this.geometry });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  // ---------------------------------------------------------------- render

  setVoices(voices: Voice[], selectedId: string | null): void {
    this.voices = voices;
    if (!this.voiceSelect) return;

    this.voiceSelect.replaceChildren();
    const byLang = new Map<string, Voice[]>();
    for (const voice of voices) {
      const key = voice.lang.split('-')[0] ?? voice.lang;
      const list = byLang.get(key);
      if (list) list.push(voice);
      else byLang.set(key, [voice]);
    }

    for (const [lang, list] of byLang) {
      const group = this.doc.createElement('optgroup');
      group.label = lang.toUpperCase();
      for (const voice of list) {
        const option = this.doc.createElement('option');
        option.value = voice.id;
        // Flag the trade-off at the point of choice rather than letting the
        // user wonder why word highlighting stopped working.
        const noWords = voice.wordTimings === 'none' ? ' - no word timing' : '';
        option.textContent = `${voice.name}${noWords}`;
        option.selected = voice.id === selectedId;
        group.appendChild(option);
      }
      this.voiceSelect.appendChild(group);
    }

    this.renderAdvice(voices);
  }

  private renderAdvice(voices: Voice[]): void {
    if (!this.adviceBox) return;
    const advice = voiceAdvice(voices);

    if (!advice) {
      this.adviceBox.style.display = 'none';
      this.adviceBox.replaceChildren();
      return;
    }

    const heading = this.doc.createElement('strong');
    heading.textContent = advice.headline;

    const list = this.doc.createElement('ol');
    for (const step of advice.steps) {
      const item = this.doc.createElement('li');
      item.textContent = step;
      list.appendChild(item);
    }

    this.adviceBox.replaceChildren(heading, list);
    this.adviceBox.style.display = 'block';
  }

  /**
   * Light, dark, or follow the OS.
   *
   * 'system' removes the attribute entirely rather than setting it to
   * system, so the prefers-color-scheme rule in the stylesheet is the only
   * thing deciding -- and keeps deciding live if the OS theme changes.
   */
  setTheme(choice: ThemeChoice): void {
    this.theme = choice;
    if (choice === 'system') this.panel.removeAttribute('data-theme');
    else this.panel.setAttribute('data-theme', choice);

    for (const [id, button] of this.themeButtons) {
      button.setAttribute('aria-pressed', String(id === choice));
    }
  }

  get currentTheme(): ThemeChoice {
    return this.theme;
  }

  setPreset(id: PresetId): void {
    if (this.presetSelect) this.presetSelect.value = id;
    this.describePreset(id);
  }

  setState(state: PlayerState): void {
    const previous = this.state;
    this.state = state;

    const speaking = state.status === 'speaking';
    this.playButton.replaceChildren(svg(speaking ? ICON.pause : ICON.play));
    this.playButton.title = speaking ? 'Pause' : 'Play';
    this.playButton.setAttribute('aria-label', this.playButton.title);

    // A play button that silently does nothing is the worst possible failure.
    // If the page yielded no text, say so and point at the way out.
    const empty = state.totalSentences === 0;
    if (this.emptyNote) this.emptyNote.style.display = empty ? 'block' : 'none';
    this.playButton.disabled = empty;
    if (empty) {
      this.playButton.title = 'No readable text found - select some text';
      this.playButton.setAttribute('aria-label', this.playButton.title);
    }

    this.remainingLabel.textContent = formatRemaining(state.remainingMs);
    this.remainingLabel.title = state.remainingMs
      ? 'Estimated time left at the current speed'
      : '';

    this.progressFill.style.width = `${Math.round(state.progress * 100)}%`;
    this.rateLabel.textContent = `${state.effectiveRate.toFixed(1)}x`;
    this.rateLabel.style.opacity = state.boosted ? '1' : '0.75';

    if (this.rateSlider && this.root.activeElement !== this.rateSlider) {
      this.applyLadderToSlider(state.rate);
    }

    if (this.timingNote) {
      if (state.wordTimings === 'none') {
        this.timingNote.className = 'note warn';
        this.timingNote.textContent =
          'This voice does not report word positions, so only the sentence is highlighted. Word highlighting is estimated.';
      } else {
        this.timingNote.className = 'note';
        this.timingNote.textContent = '';
      }
    }

    if (state.status !== previous?.status) {
      this.live.textContent =
        state.status === 'speaking'
          ? 'Reading'
          : state.status === 'paused'
            ? 'Paused'
            : state.status === 'ended'
              ? 'Finished'
              : state.status === 'error'
                ? `Error: ${state.error ?? 'unknown'}`
                : 'Stopped';
    }
  }

  /** Speak a one-off message to assistive tech without stealing focus. */
  announce(message: string): void {
    this.live.textContent = message;
  }

  get currentGeometry(): PanelGeometry {
    return { ...this.geometry };
  }

  destroy(): void {
    if (this.rateCommitTimer !== null) clearTimeout(this.rateCommitTimer);
    this.viewportWatcher?.disconnect();
    this.doc.defaultView?.removeEventListener('resize', this.clampToViewport);
    this.host.remove();
  }
}
