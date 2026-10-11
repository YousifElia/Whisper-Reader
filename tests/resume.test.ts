import { describe, it, expect } from 'vitest';
import { pageKey, findResumeIndex, type ResumePoint } from '../lib/resume';

const point = (text: string, index: number): ResumePoint => ({
  text,
  index,
  savedAt: Date.now(),
});

const doc = (...texts: string[]) => texts.map((text) => ({ text }));

describe('pageKey', () => {
  it('ignores query strings and fragments', () => {
    const a = pageKey('https://example.com/article?utm_source=x#section-2');
    const b = pageKey('https://example.com/article');
    expect(a).toBe(b);
  });

  it('keeps different articles apart', () => {
    expect(pageKey('https://example.com/a')).not.toBe(
      pageKey('https://example.com/b'),
    );
  });

  it('survives a malformed url', () => {
    expect(pageKey('not a url')).toBe('not a url');
  });
});

describe('findResumeIndex', () => {
  it('finds the sentence by its text, not its index', () => {
    // The realistic case: a section was lazy-loaded above where you stopped,
    // so every index shifted but the sentence itself is unchanged.
    const sentences = doc('New banner.', 'One.', 'Two.', 'Three.');
    expect(findResumeIndex(sentences, point('Three.', 2))).toBe(3);
  });

  it('falls back to the index when the text is gone', () => {
    const sentences = doc('One.', 'Two.', 'Three.');
    expect(findResumeIndex(sentences, point('Vanished.', 2))).toBe(2);
  });

  it('gives up rather than guessing when the index is out of range', () => {
    const sentences = doc('One.', 'Two.');
    expect(findResumeIndex(sentences, point('Vanished.', 40))).toBeNull();
  });

  it('never resumes onto the very first sentence', () => {
    // Indistinguishable from not resuming, so it should report nothing rather
    // than imply it restored a position.
    const sentences = doc('One.', 'Two.');
    expect(findResumeIndex(sentences, point('Vanished.', 0))).toBeNull();
  });

  it('handles an empty document', () => {
    expect(findResumeIndex([], point('One.', 1))).toBeNull();
  });
});
