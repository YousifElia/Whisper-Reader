/**
 * Highlight colours.
 *
 * The constraint that matters: a highlight must never make the text under it
 * harder to read than it was before. That rules out saturated blocks, which is
 * what most reading extensions use. These are washes -- low-alpha tints that
 * survive on white and on dark backgrounds, over black text and light text
 * alike, because we cannot know what the page underneath looks like.
 */

export interface HighlightTheme {
  readonly sentence: string;
  readonly word: string;
  readonly sentenceDark: string;
  readonly wordDark: string;
  /** Draw a baseline under the word instead of tinting it. Better on pages
   *  with busy backgrounds, and better for some kinds of low vision. */
  readonly underlineOnly: boolean;
  readonly underlineColor: string;
}

export const DEFAULT_THEME: HighlightTheme = {
  sentence: 'rgba(255, 206, 92, 0.26)',
  word: 'rgba(255, 176, 32, 0.58)',
  sentenceDark: 'rgba(255, 214, 122, 0.16)',
  wordDark: 'rgba(255, 190, 70, 0.42)',
  underlineOnly: false,
  underlineColor: 'rgba(255, 160, 20, 0.95)',
};

export const HIGH_CONTRAST_THEME: HighlightTheme = {
  sentence: 'rgba(0, 90, 200, 0.20)',
  word: 'rgba(0, 90, 200, 0.72)',
  sentenceDark: 'rgba(120, 190, 255, 0.22)',
  wordDark: 'rgba(120, 190, 255, 0.70)',
  underlineOnly: false,
  underlineColor: 'rgba(0, 110, 240, 1)',
};

export const SENTENCE_HIGHLIGHT = 'whisper-reader-sentence';
export const WORD_HIGHLIGHT = 'whisper-reader-word';

/** Parse the rgb()/rgba() string getComputedStyle hands back. */
function parseRgb(value: string): [number, number, number, number] | null {
  const parts = value.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  return [
    Number(parts[0]),
    Number(parts[1]),
    Number(parts[2]),
    parts.length > 3 ? Number(parts[3]) : 1,
  ];
}

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Is the page we are highlighting onto dark?
 *
 * Deliberately NOT prefers-color-scheme. The highlight sits on the page, and
 * most pages stay white regardless of the reader's OS setting -- so keying off
 * the OS put the barely-there dark wash on a white background and made the
 * highlight almost invisible. What matters is the actual paint underneath.
 */
export function pageIsDark(doc: Document = document): boolean {
  const view = doc.defaultView;
  if (!view) return false;

  for (
    let el: Element | null = doc.body ?? doc.documentElement;
    el;
    el = el.parentElement
  ) {
    const parsed = parseRgb(view.getComputedStyle(el).backgroundColor);
    // Skip fully transparent layers and keep walking up.
    if (!parsed || parsed[3] === 0) continue;
    return relativeLuminance(parsed[0], parsed[1], parsed[2]) < 0.35;
  }

  // Nothing opaque anywhere: the canvas shows through, so fall back to the OS.
  return view.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * One variant, chosen for the page rather than for the OS. Written as a plain
 * string because it is injected into the page document, not our own.
 */
export function highlightStyles(theme: HighlightTheme, dark: boolean): string {
  const sentence = dark ? theme.sentenceDark : theme.sentence;
  const wordFill = dark ? theme.wordDark : theme.word;

  const word = theme.underlineOnly
    ? `background-color: transparent;
  text-decoration: underline;
  text-decoration-color: ${theme.underlineColor};
  text-decoration-thickness: 0.18em;
  text-underline-offset: 0.12em;`
    : `background-color: ${wordFill};`;

  return `
::highlight(${SENTENCE_HIGHLIGHT}) {
  background-color: ${sentence};
}
::highlight(${WORD_HIGHLIGHT}) {
  ${word}
}`;
}
