/**
 * Real-page probe.
 *
 * jsdom fixtures prove the logic; they cannot prove the collector survives
 * actual published HTML, nor answer the question that actually matters in the
 * field: *how much of this page did we miss, and why*. This bundles the
 * extraction pipeline into a standalone script that can be pasted into any
 * page to report exactly that.
 */

import { collectDocument, DEFAULT_COLLECT_OPTIONS } from '../../lib/extract/collector';

export interface ProbeReport {
  url: string;
  title: string;
  blocks: number;
  sentences: number;
  /** Characters we would speak. */
  collectedChars: number;
  /** Characters visibly on the page, as a fair denominator. */
  pageChars: number;
  coveragePercent: number;
  unresolved: number;
  ms: number;
  /** Where the missing text went, biggest loss first. */
  rejections: Array<{ reason: string; chars: number; sample: string }>;
  /** Which element the collector chose to read from, and how much text lives
   *  outside it. Text outside the root is never walked, so it is neither
   *  collected nor traced -- usually correct (sidebars, breadcrumbs), but it
   *  has to be named or it masquerades as a mystery loss. */
  rootSelector: string;
  outsideRootChars: number;
  /** Text inside the root that no filter rejected and yet never reached a
   *  block. This is the only figure that indicates a genuine leak. */
  unaccountedChars: number;
  firstSentences: string[];
}

/** Never counted in the denominator: it is not content on any reading. */
const NEVER_CONTENT = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TITLE',
  'HEAD',
]);

/** Mirrors the collector's own root choice so the probe measures the same
 *  subtree the collector actually walks. */
function chosenRoot(doc: Document): { el: Element; selector: string } {
  for (const sel of ['article', 'main', '[role="main"]']) {
    const el = doc.querySelector(sel);
    if (el && (el.textContent ?? '').trim().length > 200) {
      return { el, selector: sel };
    }
  }
  return { el: doc.body, selector: 'body (fallback)' };
}

/** Total non-whitespace text a sighted reader could plausibly encounter. */
function pageTextLength(doc: Document, from: Element = doc.body): number {
  let total = 0;
  const walker = doc.createTreeWalker(from, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue?.trim();
    if (!text) continue;

    let skip = false;
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (NEVER_CONTENT.has(el.tagName)) {
        skip = true;
        break;
      }
      // display:none really is invisible; it belongs in neither number.
      const style = doc.defaultView?.getComputedStyle(el);
      if (style?.display === 'none' || style?.visibility === 'hidden') {
        skip = true;
        break;
      }
    }
    if (!skip) total += text.length;
  }
  return total;
}

export function probe(): ProbeReport {
  const started = performance.now();

  const lost = new Map<string, { chars: number; sample: string }>();
  const model = collectDocument(document, {
    ...DEFAULT_COLLECT_OPTIONS,
    trace: (reason, text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const entry = lost.get(reason) ?? { chars: 0, sample: '' };
      entry.chars += trimmed.length;
      if (!entry.sample && trimmed.length > 20) {
        entry.sample = trimmed.slice(0, 70);
      }
      lost.set(reason, entry);
    },
  });

  let unresolved = 0;
  for (const ref of model.sentences) {
    const block = model.blocks[ref.blockId]!;
    if (!block.map.rangeFor(ref.span.start, ref.span.end)) unresolved++;
  }

  const collectedChars = model.blocks.reduce((n, b) => n + b.text.length, 0);
  const root = chosenRoot(document);
  // Coverage is measured against the root the collector reads from, not the
  // whole document -- otherwise every page with a sidebar looks broken.
  const pageChars = pageTextLength(document, root.el);
  const wholeDocChars = pageTextLength(document);
  const rejectedChars = [...lost.values()].reduce((n, e) => n + e.chars, 0);

  return {
    url: location.href,
    title: document.title,
    blocks: model.blocks.length,
    sentences: model.sentences.length,
    collectedChars,
    pageChars,
    coveragePercent: pageChars
      ? Number(((100 * collectedChars) / pageChars).toFixed(1))
      : 0,
    unresolved,
    ms: Math.round(performance.now() - started),
    rejections: [...lost.entries()]
      .map(([reason, e]) => ({ reason, chars: e.chars, sample: e.sample }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 10),
    // Filters explain some of the gap; anything left over was lost later, in
    // the link-density check or block assembly.
    rootSelector: root.selector,
    outsideRootChars: Math.max(0, wholeDocChars - pageChars),
    unaccountedChars: Math.max(0, pageChars - collectedChars - rejectedChars),
    firstSentences: model.sentences.slice(0, 5).map((ref) => {
      const block = model.blocks[ref.blockId]!;
      return block.text.slice(ref.span.start, ref.span.end);
    }),
  };
}

(globalThis as unknown as { __calmProbe: typeof probe }).__calmProbe = probe;

// Exposed so the live-page harness can exercise the real collector directly --
// notably the selection path, which uses a different option set.
Object.assign(globalThis, { __calmCollect: collectDocument, __calmOpts: DEFAULT_COLLECT_OPTIONS });
