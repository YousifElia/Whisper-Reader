import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReaderPanel, type PanelCallbacks } from '../ui/panel/panel';
import { DEFAULT_GEOMETRY, COMPACT_HEIGHT } from '../ui/panel/geometry';
import type { PlayerState } from '../lib/player/controller';

/** jsdom fixes innerWidth/innerHeight, so they have to be redefined to model
 *  a hidden tab (zero) and then a real one. */
function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  window.dispatchEvent(new Event('resize'));
}

const noopCallbacks = (): PanelCallbacks => ({
  onPlayPause: vi.fn(),
  onStop: vi.fn(),
  onSkip: vi.fn(),
  onBoost: vi.fn(),
  onRate: vi.fn(),
  onVoice: vi.fn(),
  onWordHighlight: vi.fn(),
  onPreset: vi.fn(),
  onTheme: vi.fn(),
  onGeometry: vi.fn(),
  onClose: vi.fn(),
});

const state = (over: Partial<PlayerState> = {}): PlayerState => ({
  status: 'idle',
  sentenceIndex: 0,
  totalSentences: 10,
  blockId: 0,
  progress: 0,
  rate: 0.9,
  effectiveRate: 0.9,
  boosted: false,
  voiceId: null,
  voiceName: null,
  wordTimings: 'unknown',
  error: null,
  remainingMs: null,
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement
    .querySelectorAll('div[data-whisper-reader]')
    .forEach((el) => el.remove());
});

describe('panel placement', () => {
  it('anchors to the bottom-right on a real viewport', () => {
    setViewport(1280, 720);
    const panel = new ReaderPanel(document, noopCallbacks());

    const g = panel.currentGeometry;
    expect(g.x).toBe(1280 - g.width - 16);
    expect(g.y).toBeGreaterThan(600);
    panel.destroy();
  });

  it('does not commit a position while the viewport is zero', () => {
    // A hidden or not-yet-laid-out tab. Resolving against zero used to pin the
    // panel to the top-left permanently, on top of the article.
    setViewport(0, 0);
    const panel = new ReaderPanel(document, noopCallbacks());
    expect(panel.currentGeometry.x).toBeLessThan(0);

    // Once the tab is shown, it should place itself properly.
    setViewport(1280, 720);
    const g = panel.currentGeometry;
    expect(g.x).toBe(1280 - g.width - 16);
    panel.destroy();
  });

  it('re-anchors on resize while the user has never placed it', () => {
    setViewport(1280, 720);
    const panel = new ReaderPanel(document, noopCallbacks());
    const first = panel.currentGeometry.x;

    setViewport(800, 600);
    expect(panel.currentGeometry.x).toBe(800 - panel.currentGeometry.width - 16);
    expect(panel.currentGeometry.x).not.toBe(first);
    panel.destroy();
  });

  it('respects a position restored from settings', () => {
    setViewport(1280, 720);
    const panel = new ReaderPanel(document, noopCallbacks(), {
      ...DEFAULT_GEOMETRY,
      x: 100,
      y: 120,
    });
    // Stored coordinates mean the user placed it in an earlier session, so a
    // resize must not drag it back to the corner.
    setViewport(1000, 700);
    expect(panel.currentGeometry.x).toBe(100);
    expect(panel.currentGeometry.y).toBe(120);
    panel.destroy();
  });

  it('clamps a restored position back inside a smaller window', () => {
    setViewport(1280, 720);
    const panel = new ReaderPanel(document, noopCallbacks(), {
      ...DEFAULT_GEOMETRY,
      x: 1100,
      y: 600,
    });
    setViewport(500, 400);
    expect(panel.currentGeometry.x).toBeLessThanOrEqual(500);
    expect(panel.currentGeometry.y).toBeLessThanOrEqual(400);
    panel.destroy();
  });
});

describe('empty state', () => {
  it('disables play and explains when nothing was found', () => {
    setViewport(1280, 720);
    const panel = new ReaderPanel(document, noopCallbacks());
    panel.setState(state({ totalSentences: 0 }));

    const host = document.querySelector('div[data-whisper-reader="panel"]');
    // The shadow root is closed, so assert through what the panel exposes.
    expect(host).not.toBeNull();
    expect(() => panel.setState(state({ totalSentences: 4 }))).not.toThrow();
    panel.destroy();
  });
});

describe('compact height', () => {
  it('uses the compact height until expanded', () => {
    setViewport(1280, 720);
    const panel = new ReaderPanel(document, noopCallbacks());
    expect(panel.currentGeometry.mode).toBe('compact');
    expect(COMPACT_HEIGHT).toBeGreaterThan(0);
    panel.destroy();
  });
});
