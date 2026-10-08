import { describe, it, expect, beforeEach } from 'vitest';
import {
  pageIsDark,
  highlightStyles,
  DEFAULT_THEME,
  SENTENCE_HIGHLIGHT,
  WORD_HIGHLIGHT,
} from '../lib/highlight/theme';

beforeEach(() => {
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
  document.body.innerHTML = '';
});

describe('pageIsDark', () => {
  it('reads a light page as light', () => {
    document.body.style.backgroundColor = '#ffffff';
    expect(pageIsDark(document)).toBe(false);
  });

  it('reads a dark page as dark', () => {
    document.body.style.backgroundColor = '#111114';
    expect(pageIsDark(document)).toBe(true);
  });

  it('walks past transparent layers to the first painted one', () => {
    // The common real shape: <html> carries the colour, <body> is transparent.
    document.documentElement.style.backgroundColor = 'rgb(18, 18, 20)';
    document.body.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    expect(pageIsDark(document)).toBe(true);
  });

  it('treats mid greys by luminance, not by guesswork', () => {
    document.body.style.backgroundColor = 'rgb(200, 200, 200)';
    expect(pageIsDark(document)).toBe(false);
    document.body.style.backgroundColor = 'rgb(60, 60, 60)';
    expect(pageIsDark(document)).toBe(true);
  });

  it('does not mistake a saturated but light colour for dark', () => {
    document.body.style.backgroundColor = 'rgb(255, 214, 122)';
    expect(pageIsDark(document)).toBe(false);
  });
});

describe('highlightStyles', () => {
  it('emits one variant, not a media query', () => {
    const light = highlightStyles(DEFAULT_THEME, false);
    // A media query would reintroduce the bug this replaced: the OS setting
    // deciding colours for a page whose background it knows nothing about.
    expect(light).not.toContain('prefers-color-scheme');
    expect(light).toContain(`::highlight(${SENTENCE_HIGHLIGHT})`);
    expect(light).toContain(`::highlight(${WORD_HIGHLIGHT})`);
    expect(light).toContain(DEFAULT_THEME.sentence);
    expect(light).not.toContain(DEFAULT_THEME.sentenceDark);
  });

  it('uses the dark tints when the page is dark', () => {
    const dark = highlightStyles(DEFAULT_THEME, true);
    expect(dark).toContain(DEFAULT_THEME.sentenceDark);
    expect(dark).toContain(DEFAULT_THEME.wordDark);
  });

  it('switches the word layer to an underline when asked', () => {
    const underlined = highlightStyles(
      { ...DEFAULT_THEME, underlineOnly: true },
      false,
    );
    expect(underlined).toContain('text-decoration: underline');
    expect(underlined).toContain('background-color: transparent');
  });
});
