/**
 * Sentence and word segmentation.
 *
 * Sentences are our transport unit: we speak one at a time, which is what
 * makes skip/rewind exact and also sidesteps Chrome's long-utterance bug
 * (playback dies after roughly fifteen seconds on a single utterance).
 * Words are our highlight unit.
 */

export interface Span {
  readonly start: number;
  readonly end: number;
}

const HAS_SEGMENTER = typeof Intl !== 'undefined' && 'Segmenter' in Intl;

/** Longer than this and we split on a word boundary anyway. A 900-character
 *  "sentence" is nearly always missing punctuation rather than genuinely long,
 *  and leaving it whole makes skipping useless and risks the Chrome bug. */
const MAX_SENTENCE_CHARS = 320;

const sentenceCache = new Map<string, Intl.Segmenter>();
const wordCache = new Map<string, Intl.Segmenter>();

function segmenter(
  cache: Map<string, Intl.Segmenter>,
  locale: string,
  granularity: 'sentence' | 'word',
): Intl.Segmenter {
  let s = cache.get(locale);
  if (!s) {
    s = new Intl.Segmenter(locale, { granularity });
    cache.set(locale, s);
  }
  return s;
}

/** Trim whitespace off both ends of a span so highlights never include the
 *  gap between sentences. Returns null if nothing is left. */
function trimSpan(text: string, start: number, end: number): Span | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return e > s ? { start: s, end: e } : null;
}

/**
 * Break an over-long span at word boundaries, preferring a break after
 * clause punctuation and falling back to the last space before the limit.
 */
function splitLong(text: string, span: Span, limit: number): Span[] {
  if (span.end - span.start <= limit) return [span];

  const out: Span[] = [];
  let cursor = span.start;

  while (span.end - cursor > limit) {
    const hardStop = cursor + limit;
    let cut = -1;

    // Prefer a clause boundary in the back half of the window.
    for (let i = hardStop; i > cursor + limit / 2; i--) {
      const ch = text[i - 1]!;
      if (ch === ',' || ch === ';' || ch === ':' || ch === '\u2014') {
        cut = i;
        break;
      }
    }
    // Otherwise the last space we can find.
    if (cut < 0) {
      for (let i = hardStop; i > cursor + limit / 2; i--) {
        if (/\s/.test(text[i - 1]!)) {
          cut = i;
          break;
        }
      }
    }
    // A single unbroken token longer than the limit: cut it bluntly.
    if (cut < 0) cut = hardStop;

    const piece = trimSpan(text, cursor, cut);
    if (piece) out.push(piece);
    cursor = cut;
  }

  const tail = trimSpan(text, cursor, span.end);
  if (tail) out.push(tail);
  return out;
}

/** Regex fallback for engines without Intl.Segmenter. Deliberately simple:
 *  normalize.ts has already expanded "Dr." and friends, so the classic
 *  false-break cases are mostly gone by the time we get here. */
function regexSentences(text: string): Span[] {
  const out: Span[] = [];
  const re = /[^.!?\u2026]*[.!?\u2026]+(?:["'\u201D\u2019)\]]*)|[^.!?\u2026]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const span = trimSpan(text, m.index, m.index + m[0].length);
    if (span) out.push(span);
  }
  return out;
}

/**
 * A sentence ending on an initial has almost certainly been cut in half.
 *
 * Intl.Segmenter breaks "By A. Writer" after "A." and "J. R. R. Tolkien" three
 * times. normalize.ts fixes the abbreviation cases by expanding them, but it
 * cannot expand an arbitrary initial, so those are repaired here instead.
 */
const ENDS_WITH_INITIAL = /(?:^|[\s(["'])[A-Z]\.$/;

/** Dotted acronyms: "U.S.", "Ph.D." -- same problem, different shape. */
const ENDS_WITH_ACRONYM = /(?:^|[\s(["'])(?:[A-Za-z]\.){2,}$/;

function mergeFalseBreaks(text: string, spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const previous = out[out.length - 1];
    if (previous) {
      const before = text.slice(previous.start, previous.end);
      if (ENDS_WITH_INITIAL.test(before) || ENDS_WITH_ACRONYM.test(before)) {
        // Absorb this span into the previous one. The merged text no longer
        // ends on an initial, so the next iteration will not chain onwards.
        out[out.length - 1] = { start: previous.start, end: span.end };
        continue;
      }
    }
    out.push(span);
  }
  return out;
}

export function segmentSentences(text: string, locale = 'en'): Span[] {
  if (text.trim().length === 0) return [];

  let raw: Span[];
  if (HAS_SEGMENTER) {
    raw = [];
    for (const seg of segmenter(sentenceCache, locale, 'sentence').segment(text)) {
      const span = trimSpan(text, seg.index, seg.index + seg.segment.length);
      if (span) raw.push(span);
    }
  } else {
    raw = regexSentences(text);
  }

  const out: Span[] = [];
  for (const span of mergeFalseBreaks(text, raw)) {
    out.push(...splitLong(text, span, MAX_SENTENCE_CHARS));
  }
  return out;
}

export function segmentWords(text: string, locale = 'en'): Span[] {
  if (text.length === 0) return [];
  const out: Span[] = [];

  if (HAS_SEGMENTER) {
    const seg = segmenter(wordCache, locale, 'word') as Intl.Segmenter;
    for (const s of seg.segment(text)) {
      // isWordLike drops spaces and standalone punctuation, so the highlight
      // steps word to word rather than pausing on every comma.
      if ((s as { isWordLike?: boolean }).isWordLike) {
        out.push({ start: s.index, end: s.index + s.segment.length });
      }
    }
    return out;
  }

  const re = /[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Index of the word span containing (or immediately preceding) `index`.
 *  Used to resume mid-sentence after a rate change or a pause. */
export function wordIndexAt(words: readonly Span[], index: number): number {
  if (words.length === 0) return 0;
  let lo = 0;
  let hi = words.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid]!;
    if (index < w.start) {
      hi = mid - 1;
    } else if (index >= w.end) {
      best = mid;
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return best;
}
