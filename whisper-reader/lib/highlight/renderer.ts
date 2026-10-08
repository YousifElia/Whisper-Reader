/**
 * Two ways to paint a highlight, one interface.
 *
 * Both are non-destructive. That is not a nicety: wrapping page text in <mark>
 * elements mutates the DOM, which makes React and Vue reconcile, which breaks
 * the page and sometimes detaches the very nodes we are tracking. Whatever
 * else changes here, nothing in this file may edit the page's own nodes.
 */

import type { Highlighter } from '../player/controller';
import { UI_MARKER } from '../extract/collector';
import {
  DEFAULT_THEME,
  SENTENCE_HIGHLIGHT,
  WORD_HIGHLIGHT,
  highlightStyles,
  pageIsDark,
  type HighlightTheme,
} from './theme';

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightApi(): {
  registry: HighlightRegistry;
  Ctor: HighlightConstructor;
} | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Ctor = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  if (!css?.highlights || typeof Ctor !== 'function') return null;
  return { registry: css.highlights, Ctor };
}

/**
 * Preferred renderer: the CSS Custom Highlight API paints ranges with no DOM
 * involvement at all. Chrome 105+, Firefox 140+.
 */
export class CustomHighlightRenderer implements Highlighter {
  private readonly style: HTMLStyleElement;
  private readonly api = highlightApi()!;

  static isSupported(): boolean {
    return highlightApi() !== null;
  }

  constructor(
    private readonly doc: Document = document,
    theme: HighlightTheme = DEFAULT_THEME,
  ) {
    this.style = doc.createElement('style');
    this.style.setAttribute(UI_MARKER, 'styles');
    this.style.textContent = highlightStyles(theme, pageIsDark(doc));
    doc.head.appendChild(this.style);
  }

  setTheme(theme: HighlightTheme): void {
    this.style.textContent = highlightStyles(theme, pageIsDark(this.doc));
  }

  show(sentence: Range | null, word: Range | null): void {
    const { registry, Ctor } = this.api;

    if (sentence) registry.set(SENTENCE_HIGHLIGHT, new Ctor(sentence));
    else registry.delete(SENTENCE_HIGHLIGHT);

    if (word) registry.set(WORD_HIGHLIGHT, new Ctor(word));
    else registry.delete(WORD_HIGHLIGHT);
  }

  clear(): void {
    this.api.registry.delete(SENTENCE_HIGHLIGHT);
    this.api.registry.delete(WORD_HIGHLIGHT);
  }

  destroy(): void {
    this.clear();
    this.style.remove();
  }
}

/**
 * Fallback for Firefox before 140: draw the range's client rects as absolutely
 * positioned boxes in our own overlay. Still touches none of the page's nodes.
 *
 * The overlay lives in a shadow root so the page's stylesheets cannot reach
 * it, and carries pointer-events: none so it never intercepts a click.
 */
export class OverlayRenderer implements Highlighter {
  private readonly host: HTMLDivElement;
  private readonly root: ShadowRoot;
  private readonly sentenceLayer: HTMLDivElement;
  private readonly wordLayer: HTMLDivElement;
  private frame: number | null = null;
  private current: { sentence: Range | null; word: Range | null } = {
    sentence: null,
    word: null,
  };

  constructor(
    private readonly doc: Document = document,
    private theme: HighlightTheme = DEFAULT_THEME,
  ) {
    this.host = doc.createElement('div');
    this.host.setAttribute(UI_MARKER, 'highlight-overlay');
    this.host.setAttribute('aria-hidden', 'true');
    this.host.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';

    this.root = this.host.attachShadow({ mode: 'closed' });
    // Same reasoning as CustomHighlightRenderer: the variant follows the page's
    // own background, not the OS colour scheme.
    const dark = pageIsDark(doc);
    const style = doc.createElement('style');
    style.textContent = `
      :host { all: initial; }
      div { position: fixed; pointer-events: none; border-radius: 2px; }
      .s { background: ${dark ? theme.sentenceDark : theme.sentence}; }
      .w { background: ${dark ? theme.wordDark : theme.word}; }`;
    this.root.appendChild(style);

    this.sentenceLayer = doc.createElement('div');
    this.wordLayer = doc.createElement('div');
    this.root.append(this.sentenceLayer, this.wordLayer);

    doc.documentElement.appendChild(this.host);

    // Client rects are viewport-relative, so anything that moves the page
    // invalidates every box we drew.
    this.doc.defaultView?.addEventListener('scroll', this.invalidate, {
      passive: true,
      capture: true,
    });
    this.doc.defaultView?.addEventListener('resize', this.invalidate, {
      passive: true,
    });
  }

  setTheme(theme: HighlightTheme): void {
    this.theme = theme;
    this.repaint();
  }

  private invalidate = (): void => {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.repaint();
    });
  };

  private paintLayer(layer: HTMLElement, range: Range | null, cls: string): void {
    layer.textContent = '';
    if (!range) return;

    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const box = this.doc.createElement('div');
      box.className = cls;
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      layer.appendChild(box);
    }
  }

  private repaint(): void {
    this.paintLayer(this.sentenceLayer, this.current.sentence, 's');
    this.paintLayer(this.wordLayer, this.current.word, 'w');
  }

  show(sentence: Range | null, word: Range | null): void {
    this.current = { sentence, word };
    this.repaint();
  }

  clear(): void {
    this.current = { sentence: null, word: null };
    this.repaint();
  }

  destroy(): void {
    this.doc.defaultView?.removeEventListener('scroll', this.invalidate, {
      capture: true,
    });
    this.doc.defaultView?.removeEventListener('resize', this.invalidate);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.host.remove();
  }
}

export interface ManagedHighlighter extends Highlighter {
  setTheme(theme: HighlightTheme): void;
  destroy(): void;
}

export function createHighlighter(
  doc: Document = document,
  theme: HighlightTheme = DEFAULT_THEME,
): ManagedHighlighter {
  return CustomHighlightRenderer.isSupported()
    ? new CustomHighlightRenderer(doc, theme)
    : new OverlayRenderer(doc, theme);
}
