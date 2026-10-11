/**
 * Live DOM -> ordered, speakable blocks.
 *
 * Deliberately NOT @mozilla/readability: it hands back a detached clone, and a
 * clone has no relationship to the nodes we need to highlight. Keeping node
 * identity is the whole point, so we filter the live tree instead.
 */

import { type OffsetMap } from './offsets';
import {
  normalizeElement,
  DEFAULT_NORMALIZE_OPTIONS,
  type NormalizeOptions,
} from './normalize';
import { segmentSentences, type Span } from './segment';

export type BlockKind =
  | 'paragraph'
  | 'heading'
  | 'listitem'
  | 'quote'
  | 'code'
  | 'cell'
  | 'caption';

export interface Block {
  readonly id: number;
  readonly element: Element;
  readonly kind: BlockKind;
  /** 1-6 for headings, 0 otherwise. */
  readonly level: number;
  readonly lang: string;
  readonly text: string;
  readonly map: OffsetMap;
  readonly sentences: readonly Span[];
}

/**
 * A sentence's address in flattened reading order. The player cursor is just
 * an index into this list, which is what makes skip and rewind exact rather
 * than approximate.
 */
export interface SentenceRef {
  readonly blockId: number;
  readonly indexInBlock: number;
  readonly span: Span;
}

export interface ReaderDocument {
  readonly blocks: readonly Block[];
  readonly sentences: readonly SentenceRef[];
  readonly lang: string;
}

export interface CollectOptions extends NormalizeOptions {
  /**
   * What to do with <pre> blocks. Inline <code> is always read: it is
   * ordinary prose in a sentence, and skipping it leaves holes.
   *
   * There was an 'announce' value here that was never implemented and behaved
   * exactly like 'skip'; an enum member that quietly lies is worse than a
   * missing feature, so it is gone until something actually announces.
   */
  readonly code: 'skip' | 'read';
  readonly root?: Element;
  /**
   * Skip every visibility and page-furniture check.
   *
   * Used for reading a selection. The user highlighting text is direct proof
   * that it is visible and that they want it read, which beats any heuristic
   * we have -- so this is the escape hatch when the filters get a site wrong.
   * Never set for a whole-page read.
   */
  readonly trustEverything?: boolean;
  /**
   * Diagnostics hook: called with a reason and the text for every node the
   * filters drop. Used by the harness to answer "why was this page's content
   * missed", which is otherwise pure guesswork. Unset in normal operation.
   */
  readonly trace?: (reason: string, text: string) => void;
}

export const DEFAULT_COLLECT_OPTIONS: CollectOptions = {
  ...DEFAULT_NORMALIZE_OPTIONS,
  code: 'skip',
};

/** Marks our own injected UI, so the reader never reads itself aloud. */
export const UI_MARKER = 'data-whisper-reader';

const BLOCK_TAGS: Record<string, { kind: BlockKind; level: number }> = {
  P: { kind: 'paragraph', level: 0 },
  H1: { kind: 'heading', level: 1 },
  H2: { kind: 'heading', level: 2 },
  H3: { kind: 'heading', level: 3 },
  H4: { kind: 'heading', level: 4 },
  H5: { kind: 'heading', level: 5 },
  H6: { kind: 'heading', level: 6 },
  LI: { kind: 'listitem', level: 0 },
  DT: { kind: 'listitem', level: 0 },
  DD: { kind: 'listitem', level: 0 },
  BLOCKQUOTE: { kind: 'quote', level: 0 },
  TD: { kind: 'cell', level: 0 },
  TH: { kind: 'cell', level: 0 },
  FIGCAPTION: { kind: 'caption', level: 0 },
  PRE: { kind: 'code', level: 0 },
  ARTICLE: { kind: 'paragraph', level: 0 },
  SECTION: { kind: 'paragraph', level: 0 },
  DIV: { kind: 'paragraph', level: 0 },
};

/** Never contributes speech, whatever it contains. */
const OPAQUE_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'SVG',
  'MATH',
  'TEMPLATE',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'CANVAS',
  'AUDIO',
  'VIDEO',
  'BUTTON',
]);

/** Never prose, wherever they appear. */
const ALWAYS_CHROME_TAGS = new Set(['NAV', 'ASIDE']);

/**
 * Skipped only when we fell back to <body> as the root. Unlike <nav>, a
 * <header> inside the content root often holds the article title, so filtering
 * it unconditionally would cost us the headline.
 */
const BODY_ONLY_CHROME_TAGS = new Set(['HEADER', 'FOOTER']);

const CHROME_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'menu',
  'menubar',
  'toolbar',
  'tablist',
  'dialog',
]);

/**
 * Blocks that are almost entirely link text are navigation, whatever tags they
 * happen to use.
 *
 * This is what catches Wikipedia's interlanguage sidebar, which lives inside a
 * <header> inside <main> and therefore survives every tag-based rule we could
 * reasonably apply without also throwing away article titles. Real prose does
 * not approach this density; menus and link lists always do.
 */
const LINK_DENSITY_LIMIT = 0.7;

/** Above this length, heavy linking is much more likely to be genuine prose
 *  (a paragraph citing many sources) than a menu. */
const LINK_DENSITY_MAX_CHARS = 250;

interface VisibilityChecker {
  checkVisibility?(options?: {
    checkOpacity?: boolean;
    checkVisibilityCSS?: boolean;
  }): boolean;
}

/**
 * Whether this element alone is hidden, and why. Ancestors are handled by the
 * chain cache in groupTextNodes, so this must not walk upwards itself.
 *
 * Opacity is deliberately NOT treated as hidden. Scroll-reveal animations are
 * everywhere -- a section sits at `opacity: 0` until it scrolls into view --
 * and we collect the whole document once, up front, while most of it is still
 * below the fold. Treating opacity as hidden silently dropped everything a
 * reader had not scrolled past yet, which is the single largest cause of "it
 * didn't grab all the text". Genuinely invisible content is still caught by
 * display, visibility, hidden and aria-hidden.
 */
function hiddenReason(el: Element): string | null {
  if (el.hasAttribute('hidden')) return 'hidden-attr';
  if (el.getAttribute('aria-hidden') === 'true') return 'aria-hidden';

  // Fast path. checkVisibility settles in one call what getComputedStyle needs
  // several property reads to establish. A `true` here is conclusive.
  const check = (el as Element & VisibilityChecker).checkVisibility;
  if (typeof check === 'function' && check.call(el, { checkVisibilityCSS: true })) {
    return null;
  }

  // A `false` is NOT conclusive, which is the trap. checkVisibility reports
  // false for `display: contents` -- an element that generates no box of its
  // own while its children render completely normally. Tailwind ships it as
  // the `contents` class and React wrappers lean on it, so trusting `false`
  // silently swallowed whole articles. Confirm against the real properties.
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return null;

  if (style.display === 'none') return 'display-none';
  if (style.visibility === 'hidden' || style.visibility === 'collapse') {
    return 'visibility-hidden';
  }
  // content-visibility: hidden really is hidden; `auto` only defers painting
  // for off-screen content and must not be treated as invisible.
  if (style.contentVisibility === 'hidden') return 'content-visibility-hidden';

  return null;
}

/**
 * Best guess at the article container. A wrong guess is recoverable: the user
 * can always select text and read just that instead.
 */
function findRoot(doc: Document): { root: Element | null; isBody: boolean } {
  for (const sel of ['article', 'main', '[role="main"]']) {
    const el = doc.querySelector(sel);
    if (el && (el.textContent ?? '').trim().length > 200) {
      return { root: el, isBody: false };
    }
  }
  return { root: doc.body, isBody: true };
}

function nearestLang(el: Element): string {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const lang = cur.getAttribute('lang');
    if (lang) return lang;
  }
  return el.ownerDocument.documentElement.lang || 'en';
}

/**
 * Assign each text node to its nearest block ancestor.
 *
 * Doing it this way, rather than querying a block selector and then reading
 * each match's textContent, means nested blocks are never read twice -- a <p>
 * inside a <blockquote>, or a <li> inside a nested <ul>, belongs to exactly
 * one owner by construction.
 */
interface Group {
  readonly nodes: Text[];
  /** Characters sitting inside an <a>, for link-density filtering. */
  linkedChars: number;
  totalChars: number;
}

function groupTextNodes(
  root: Element,
  isBody: boolean,
  opts: CollectOptions,
): Map<Element, Group> {
  const doc = root.ownerDocument;
  const groups = new Map<Element, Group>();
  const stop = root.parentElement;

  /**
   * Whether an element and every ancestor up to the root is speakable.
   *
   * Memoised per element rather than per text node. A long article has tens of
   * thousands of text nodes over a few thousand elements, and re-walking the
   * ancestor chain for each one was costing tens of seconds -- almost all of
   * it in repeated style lookups.
   */
  const chainOk = new Map<Element, string | null>();

  /** Why this element alone disqualifies its text, or null if it does not. */
  function ownReason(el: Element): string | null {
    // Script and style tags never contain speech, and our own UI must never
    // read itself -- those two hold even when we trust everything else.
    if (OPAQUE_TAGS.has(el.tagName)) return `tag:${el.tagName.toLowerCase()}`;
    if (el.hasAttribute(UI_MARKER)) return 'our-own-ui';
    if (opts.trustEverything) return null;
    if ((el as HTMLElement).isContentEditable) return 'contenteditable';
    if (ALWAYS_CHROME_TAGS.has(el.tagName)) {
      return `chrome:${el.tagName.toLowerCase()}`;
    }
    if (isBody && BODY_ONLY_CHROME_TAGS.has(el.tagName)) {
      // A <header> containing an <h1> is an article header, not site chrome --
      // on pages with no <main> landmark the title is routinely wrapped this
      // way, and blanket-filtering headers silently dropped it. Footers never
      // get this exemption; nothing worth reading hides in one.
      const isArticleHeader =
        el.tagName === 'HEADER' && el.querySelector('h1') !== null;
      if (!isArticleHeader) return `chrome:${el.tagName.toLowerCase()}`;
    }
    // Only <pre> is skipped, not every <code>. Inline <code> is ordinary
    // prose on any technical page -- "the SpeechSynthesis.paused property
    // returns..." -- and dropping it left sentences with holes in them.
    // A <code> inside a <pre> is still skipped, because the <pre> ancestor
    // fails first and short-circuits the chain.
    if (opts.code !== 'read' && el.tagName === 'PRE') {
      return 'code';
    }
    const role = el.getAttribute('role');
    if (role && CHROME_ROLES.has(role)) return `role:${role}`;
    return hiddenReason(el);
  }

  /**
   * Null when the element and every ancestor up to the root is speakable,
   * otherwise the reason the chain failed.
   *
   * Memoised per element rather than per text node. A long article has tens of
   * thousands of text nodes over a few thousand elements, and re-walking the
   * ancestor chain for each one was costing tens of seconds -- almost all of
   * it in repeated style lookups.
   */
  function rejects(el: Element | null): string | null {
    if (!el || el === stop) return null;

    const cached = chainOk.get(el);
    if (cached !== undefined) return cached;

    // Only recurse when this element itself passed; a failed element short
    // circuits without touching its ancestors.
    const result = ownReason(el) ?? rejects(el.parentElement);
    chainOk.set(el, result);
    return result;
  }

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      // Whitespace-only nodes are kept, not rejected. They carry real word
      // separation: Wikipedia writes "Known<span>&nbsp;</span>for", and
      // dropping that node welds the two words into "Knownfor". The
      // normaliser collapses them to a single space downstream.
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;

      const reason = rejects(node.parentElement);
      if (reason) {
        opts.trace?.(reason, node.nodeValue);
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;

    let owner: Element = root;
    let insideLink = false;
    for (let el = text.parentElement; el && el !== stop; el = el.parentElement) {
      if (el.tagName === 'A') insideLink = true;
      if (BLOCK_TAGS[el.tagName]) {
        owner = el;
        break;
      }
    }

    let group = groups.get(owner);
    if (!group) {
      group = { nodes: [], linkedChars: 0, totalChars: 0 };
      groups.set(owner, group);
    }
    group.nodes.push(text);

    const length = text.data.trim().length;
    group.totalChars += length;
    if (insideLink) group.linkedChars += length;
  }

  return groups;
}

function isLinkList(group: Group): boolean {
  if (group.totalChars === 0) return false;
  if (group.totalChars > LINK_DENSITY_MAX_CHARS) return false;
  return group.linkedChars / group.totalChars > LINK_DENSITY_LIMIT;
}

/**
 * Below this, the landmark clearly did not contain the article.
 *
 * Deliberately low. The fallback re-reads from <body>, where the chrome rules
 * are looser about what counts as content, so firing it on a landmark that
 * merely holds a *short* article drags navigation back in. findRoot already
 * demands 200 characters of raw text in the landmark; collecting almost
 * nothing from that means the text was all buttons and menus.
 */
const PLAUSIBLE_ARTICLE_CHARS = 120;

export function collectDocument(
  doc: Document = document,
  opts: CollectOptions = DEFAULT_COLLECT_OPTIONS,
): ReaderDocument {
  const model = collectFrom(doc, opts);
  if (opts.root) return model;

  // Safety net for pages whose <main> or <article> is a thin wrapper that does
  // not actually contain the prose -- a shape common enough in app-style
  // layouts that trusting the landmark blindly loses the whole page. If the
  // landmark yielded almost nothing, try again from <body>, where the chrome
  // filters are stricter but the content is at least present.
  const chars = model.blocks.reduce((n, b) => n + b.text.length, 0);
  if (chars >= PLAUSIBLE_ARTICLE_CHARS || !doc.body) return model;

  const fallback = collectFrom(doc, { ...opts, root: doc.body }, true);
  const fallbackChars = fallback.blocks.reduce((n, b) => n + b.text.length, 0);
  return fallbackChars > chars ? fallback : model;
}

function collectFrom(
  doc: Document,
  opts: CollectOptions,
  forceBodyRules = false,
): ReaderDocument {
  const docLang = doc.documentElement.lang || 'en';
  const found = opts.root
    ? { root: opts.root, isBody: forceBodyRules }
    : findRoot(doc);

  if (!found.root) return { blocks: [], sentences: [], lang: docLang };

  const groups = groupTextNodes(found.root, found.isBody, opts);
  const blocks: Block[] = [];
  const sentences: SentenceRef[] = [];

  for (const [element, group] of groups) {
    const groupText = () => group.nodes.map((n) => n.data).join('');

    if (isLinkList(group)) {
      opts.trace?.('link-list', groupText());
      continue;
    }

    const meta = BLOCK_TAGS[element.tagName] ?? {
      kind: 'paragraph' as BlockKind,
      level: 0,
    };
    const lang = nearestLang(element);
    const { text, map } = normalizeElement(group.nodes, opts);
    if (text.trim().length === 0) {
      opts.trace?.('empty-after-normalise', groupText());
      continue;
    }

    const spans = segmentSentences(text, lang);
    if (spans.length === 0) {
      opts.trace?.('no-sentences', text);
      continue;
    }

    const id = blocks.length;
    blocks.push({
      id,
      element,
      kind: meta.kind,
      level: meta.level,
      lang,
      text,
      map,
      sentences: spans,
    });

    spans.forEach((span, indexInBlock) => {
      sentences.push({ blockId: id, indexInBlock, span });
    });
  }

  return { blocks, sentences, lang: docLang };
}

/**
 * First sentence of the adjacent block. Backs Shift+skip (jump a paragraph)
 * without needing a second index.
 *
 * Going backwards lands on the *first* sentence of the previous block rather
 * than its last, which is what "go back a paragraph" means to a listener.
 */
export function blockBoundary(
  model: ReaderDocument,
  from: number,
  direction: 1 | -1,
): number {
  const list = model.sentences;
  const current = list[from];
  if (!current) return from;

  if (direction === 1) {
    for (let i = from + 1; i < list.length; i++) {
      if (list[i]!.blockId !== current.blockId) return i;
    }
    return Math.max(0, list.length - 1);
  }

  let i = from - 1;
  while (i >= 0 && list[i]!.blockId === current.blockId) i--;
  if (i < 0) return 0;

  const target = list[i]!.blockId;
  while (i > 0 && list[i - 1]!.blockId === target) i--;
  return i;
}
