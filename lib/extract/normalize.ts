/**
 * DOM text -> spoken text, emitted through SpokenTextBuilder so the piece
 * table stays in lockstep with the string.
 *
 * Everything here is a rule applied at a position. Nothing rewrites the string
 * after the fact, because a post-hoc rewrite is exactly what breaks the
 * offset mapping.
 */

import { SpokenTextBuilder, type OffsetMap } from './offsets';

export interface NormalizeOptions {
  /** Expand "Dr." to "Doctor" etc. Doubles as sentence-segmentation repair:
   *  removing the period removes the false sentence break. */
  readonly expandAbbreviations: boolean;
  /** Drop "[1]", "[edit]", "[citation needed]". */
  readonly stripFootnoteMarkers: boolean;
  /** Bare URLs are miserable to listen to character by character. */
  readonly urls: 'link' | 'read';
}

export const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = {
  expandAbbreviations: true,
  stripFootnoteMarkers: true,
  urls: 'link',
};

/**
 * `terminal` says what to do with the trailing period.
 *   never - the abbreviation effectively never ends a sentence, so dropping
 *           the period is a pure win (it stops "Dr. Chen" splitting in two).
 *   maybe - it might, so we look ahead: a following capital or end-of-text
 *           means the period was doing real work and we keep it.
 */
type Terminal = 'never' | 'maybe';

const ABBREVIATIONS: ReadonlyArray<readonly [string, string, Terminal]> = [
  ['e.g.', 'for example', 'maybe'],
  ['i.e.', 'that is', 'maybe'],
  ['etc.', 'et cetera', 'maybe'],
  ['et al.', 'and others', 'maybe'],
  ['cf.', 'compare', 'maybe'],
  ['ca.', 'circa', 'maybe'],
  // "(c. 1843)" is extremely common in encyclopedic prose and its period was
  // splitting the caption in two. Never terminal: nobody ends a sentence on it.
  ['c.', 'circa', 'never'],
  ['approx.', 'approximately', 'maybe'],
  ['vs.', 'versus', 'never'],
  ['Dr.', 'Doctor', 'never'],
  ['Prof.', 'Professor', 'never'],
  ['Mr.', 'Mister', 'never'],
  ['Mrs.', 'Missus', 'never'],
  ['Ms.', 'Miz', 'never'],
  ['Fig.', 'Figure', 'never'],
  ['Eq.', 'Equation', 'never'],
];

const INVISIBLE = /[\u200B-\u200D\uFEFF\u00AD\u2060]/;
const WORDISH = /[\p{L}\p{N}]/u;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ABBREV_ALT = ABBREVIATIONS.map(([k]) => escapeRe(k)).join('|');

/**
 * Finds the next position where any rule could match, so plain prose is copied
 * in long runs instead of one character at a time.
 *
 * Assembled from `.source` of real regex literals rather than a template
 * string: every alternative here needs backslashes, and hand-doubling them
 * inside a string is a reliable way to ship a regex that silently matches the
 * wrong thing.
 */
const INTERESTING = new RegExp(
  [
    /\s/.source,
    INVISIBLE.source,
    /\[/.source,
    /https?:\/\//.source,
    ABBREV_ALT,
  ].join('|'),
  'gu',
);

const FOOTNOTE = /\[(?:\d{1,3}[a-z]?|edit|citation needed|sic|\u2026|\.\.\.)\]/iy;
const URL = /https?:\/\/[^\s<>"')\]]+/y;
const WHITESPACE = /\s+/y;
const INVISIBLE_RUN = /[\u200B-\u200D\uFEFF\u00AD\u2060]+/y;

function atWordStart(data: string, i: number): boolean {
  return i === 0 || !WORDISH.test(data[i - 1]!);
}

/** After an abbreviation whose period we dropped: did that period end a
 *  sentence? A following capital letter (or nothing at all) says yes. */
function periodWasTerminal(data: string, after: number): boolean {
  let j = after;
  while (j < data.length && /\s/.test(data[j]!)) j++;
  if (j >= data.length) return true;
  const ch = data[j]!;
  return ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

/**
 * Append one text node's contribution. The builder is shared across every
 * text node in a block, which is what lets whitespace collapse work across
 * element boundaries ("Hello </em> world" -> one space).
 */
export function appendTextNode(
  node: Text,
  builder: SpokenTextBuilder,
  opts: NormalizeOptions = DEFAULT_NORMALIZE_OPTIONS,
): void {
  const data = node.data;
  let i = 0;

  while (i < data.length) {
    const ch = data[i]!;

    if (/\s/.test(ch)) {
      WHITESPACE.lastIndex = i;
      const m = WHITESPACE.exec(data)!;
      const len = m[0].length;
      const prev = builder.lastChar;
      if (prev === '' || prev === ' ') {
        builder.skip(node, i, len); // leading, or a space we already emitted
      } else if (len === 1 && ch === ' ') {
        builder.copy(node, i, ' '); // exact, and the common case
      } else {
        builder.replace(node, i, len, ' ');
      }
      i += len;
      continue;
    }

    if (INVISIBLE.test(ch)) {
      INVISIBLE_RUN.lastIndex = i;
      const m = INVISIBLE_RUN.exec(data)!;
      builder.skip(node, i, m[0].length);
      i += m[0].length;
      continue;
    }

    if (opts.stripFootnoteMarkers && ch === '[') {
      FOOTNOTE.lastIndex = i;
      const m = FOOTNOTE.exec(data);
      if (m) {
        builder.skip(node, i, m[0].length);
        i += m[0].length;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H') && atWordStart(data, i)) {
      URL.lastIndex = i;
      const m = URL.exec(data);
      if (m) {
        if (opts.urls === 'link') {
          builder.replace(node, i, m[0].length, 'link');
        } else {
          builder.copy(node, i, m[0]);
        }
        i += m[0].length;
        continue;
      }
    }

    if (opts.expandAbbreviations && atWordStart(data, i)) {
      let matched = false;
      for (const [key, spoken, terminal] of ABBREVIATIONS) {
        if (!data.startsWith(key, i)) continue;
        // Don't swallow a longer word: "vs." inside "vs.something" is fine,
        // but "Dr." must not match the start of "Drive".
        const after = i + key.length;
        if (after < data.length && WORDISH.test(data[after]!)) continue;

        const keepPeriod =
          terminal === 'maybe' && periodWasTerminal(data, after);
        builder.replace(node, i, key.length, keepPeriod ? `${spoken}.` : spoken);
        i = after;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    // Nothing special here: copy forward to the next candidate in one go.
    INTERESTING.lastIndex = i + 1;
    const next = INTERESTING.exec(data);
    const end = next ? next.index : data.length;
    builder.copy(node, i, data.slice(i, end));
    i = end;
  }
}

export interface NormalizedText {
  readonly text: string;
  readonly map: OffsetMap;
}

/** Normalise a block's speakable text nodes into one spoken string. The nodes
 *  share a builder, which is what lets whitespace collapse across element
 *  boundaries: "Hello </em> world" becomes one space, not three. */
export function normalizeElement(
  textNodes: readonly Text[],
  opts: NormalizeOptions = DEFAULT_NORMALIZE_OPTIONS,
): NormalizedText {
  const builder = new SpokenTextBuilder();
  for (const node of textNodes) appendTextNode(node, builder, opts);
  const { text, map } = builder.build();
  // A block that ends in a collapsed space would otherwise leave a dangling
  // highlight target; trailing spaces are trimmed at the span level instead.
  return { text: text.trimEnd(), map };
}
