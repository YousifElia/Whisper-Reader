import { describe, it, expect } from 'vitest';
import {
  segmentSentences,
  segmentWords,
  wordIndexAt,
} from '../lib/extract/segment';

const texts = (t: string) =>
  segmentSentences(t).map((s) => t.slice(s.start, s.end));

describe('sentence segmentation', () => {
  it('splits on terminal punctuation', () => {
    expect(texts('One fish. Two fish! Red fish? Blue fish.')).toEqual([
      'One fish.',
      'Two fish!',
      'Red fish?',
      'Blue fish.',
    ]);
  });

  it('excludes the whitespace between sentences from the spans', () => {
    const t = 'First.   Second.';
    const spans = segmentSentences(t);
    expect(spans).toHaveLength(2);
    // The gap must not be inside either span, or the highlight visibly
    // overshoots into the space before the next sentence.
    expect(t.slice(spans[0]!.start, spans[0]!.end)).toBe('First.');
    expect(t.slice(spans[1]!.start, spans[1]!.end)).toBe('Second.');
  });

  it('handles a single sentence with no terminator', () => {
    expect(texts('no punctuation here')).toEqual(['no punctuation here']);
  });

  it('returns nothing for blank input', () => {
    expect(segmentSentences('')).toEqual([]);
    expect(segmentSentences('   \n  ')).toEqual([]);
  });

  it('keeps a closing quote with its sentence', () => {
    const out = texts('He said "go." Then he left.');
    expect(out[0]).toContain('go.');
    expect(out).toHaveLength(2);
  });
});

describe('long-span splitting', () => {
  it('breaks an unpunctuated wall of text into speakable chunks', () => {
    const t = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const spans = segmentSentences(t);

    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(320);

    // Splitting must be lossless apart from the whitespace we trimmed.
    const rejoined = spans.map((s) => t.slice(s.start, s.end)).join(' ');
    expect(rejoined).toBe(t);
  });

  it('prefers to break after clause punctuation', () => {
    const clause = `${'filler word '.repeat(20)}, `;
    const t = (clause + 'x '.repeat(10)).repeat(3);
    const spans = segmentSentences(t);
    expect(spans.length).toBeGreaterThan(1);
  });

  it('cuts a single oversized token rather than looping forever', () => {
    const t = 'a'.repeat(1000);
    const spans = segmentSentences(t);
    expect(spans.length).toBeGreaterThan(1);
    expect(spans.every((s) => s.end > s.start)).toBe(true);
  });
});

describe('word segmentation', () => {
  it('returns word-like spans only', () => {
    const t = 'Hello, brave new world!';
    const words = segmentWords(t).map((w) => t.slice(w.start, w.end));
    expect(words).toEqual(['Hello', 'brave', 'new', 'world']);
  });

  it('keeps contractions and hyphenated words whole', () => {
    const t = "don't re-enter";
    const words = segmentWords(t).map((w) => t.slice(w.start, w.end));
    expect(words).toContain("don't");
  });

  it('handles digits', () => {
    const t = 'about 100 degrees';
    const words = segmentWords(t).map((w) => t.slice(w.start, w.end));
    expect(words).toEqual(['about', '100', 'degrees']);
  });
});

describe('wordIndexAt', () => {
  const t = 'alpha beta gamma';
  const words = segmentWords(t);

  it('finds the word containing an index', () => {
    expect(wordIndexAt(words, 0)).toBe(0);
    expect(wordIndexAt(words, 7)).toBe(1);
    expect(wordIndexAt(words, 15)).toBe(2);
  });

  it('falls back to the preceding word when landing in a gap', () => {
    // Index 5 is the space after "alpha"; resuming should re-speak from
    // "alpha", never jump ahead to "beta".
    expect(wordIndexAt(words, 5)).toBe(0);
  });

  it('is safe on empty input', () => {
    expect(wordIndexAt([], 4)).toBe(0);
  });
});

describe('false sentence breaks', () => {
  it('keeps an initial with the name that follows it', () => {
    expect(texts('By A. Writer')).toEqual(['By A. Writer']);
  });

  it('keeps a chain of initials together', () => {
    expect(texts('J. R. R. Tolkien wrote it.')).toEqual([
      'J. R. R. Tolkien wrote it.',
    ]);
  });

  it('keeps a dotted acronym with its sentence', () => {
    expect(texts('The U.S. Congress voted. Then it adjourned.')).toEqual([
      'The U.S. Congress voted.',
      'Then it adjourned.',
    ]);
  });

  it('still splits normally after a real sentence end', () => {
    expect(texts('He arrived. She left.')).toEqual([
      'He arrived.',
      'She left.',
    ]);
  });
});
