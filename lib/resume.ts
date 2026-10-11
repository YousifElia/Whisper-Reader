/**
 * Remember where you stopped on each page.
 *
 * The single most useful thing a reader can do for a long article: come back
 * tomorrow and pick up mid-paragraph instead of hunting for your place. It
 * costs no UI at all, which is why it earns its keep here.
 *
 * Positions are stored by URL in `local` (not `sync`) -- they are worthless on
 * another machine and would burn the small sync quota fast.
 */

import { browser } from 'wxt/browser';

const KEY = 'resumePositions';

/** Enough to cover anything you are realistically still reading. */
const MAX_ENTRIES = 150;

export interface ResumePoint {
  /** Index at save time; only a hint, since the page may have changed. */
  index: number;
  /**
   * The sentence's text. This, not the index, is what actually finds your
   * place again: articles gain comment counts and lazy-loaded sections between
   * visits, and an index alone silently lands you somewhere else entirely.
   */
  text: string;
  savedAt: number;
}

type Store = Record<string, ResumePoint>;

/** Query strings and fragments rarely change which article you are on, and
 *  keeping them would store the same page many times over. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

async function readStore(): Promise<Store> {
  try {
    const stored = await browser.storage.local.get(KEY);
    return (stored[KEY] as Store) ?? {};
  } catch {
    return {};
  }
}

export async function loadResumePoint(url: string): Promise<ResumePoint | null> {
  const store = await readStore();
  return store[pageKey(url)] ?? null;
}

export async function saveResumePoint(
  url: string,
  point: ResumePoint,
): Promise<void> {
  try {
    const store = await readStore();
    store[pageKey(url)] = point;

    // Evict oldest first, so a long tail of pages read once does not crowd out
    // the one you are actually part-way through.
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => (store[a]?.savedAt ?? 0) - (store[b]?.savedAt ?? 0))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((key) => delete store[key]);
    }

    await browser.storage.local.set({ [KEY]: store });
  } catch {
    // Losing a bookmark is never worth interrupting playback for.
  }
}

export async function clearResumePoint(url: string): Promise<void> {
  try {
    const store = await readStore();
    delete store[pageKey(url)];
    await browser.storage.local.set({ [KEY]: store });
  } catch {
    // Ignore.
  }
}

/**
 * Find the saved sentence in a freshly collected document.
 *
 * Matches on text first and falls back to the index only when the text is
 * gone, because landing on the wrong sentence silently is worse than starting
 * over. Returns null when neither is usable.
 */
export function findResumeIndex(
  sentences: ReadonlyArray<{ text: string }>,
  point: ResumePoint,
): number | null {
  if (sentences.length === 0) return null;

  const exact = sentences.findIndex((s) => s.text === point.text);
  if (exact >= 0) return exact;

  // The page changed. Only trust the raw index if it still points at something,
  // and never resume from the very first sentence -- that is indistinguishable
  // from not resuming at all.
  if (point.index > 0 && point.index < sentences.length) return point.index;
  return null;
}
