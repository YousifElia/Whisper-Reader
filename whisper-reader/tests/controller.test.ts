import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectDocument, type ReaderDocument } from '../lib/extract/collector';
import {
  PlayerController,
  BOOST_MULTIPLIER,
  MAX_RATE,
  MIN_RATE,
  type Highlighter,
} from '../lib/player/controller';
import type {
  SpeakCallbacks,
  SpeakHandle,
  SpeakRequest,
  TTSEngine,
} from '../lib/engines/types';

/**
 * A hand-driven engine. Nothing happens until the test says so, which is what
 * makes the ordering assertions (late callbacks, cancellation races) possible
 * to write at all.
 */
class FakeHandle implements SpeakHandle {
  finished = false;
  stopped = false;
  paused = false;
  fakeElapsed = 0;
  rateAccepted = false;

  constructor(
    readonly request: SpeakRequest,
    private readonly callbacks: SpeakCallbacks,
  ) {}

  fireStart(): void {
    this.callbacks.onStart?.();
  }
  fireWord(charIndex: number, length = 0): void {
    this.callbacks.onWord?.(charIndex, length);
  }
  fireEnd(): void {
    this.finished = true;
    this.callbacks.onEnd?.();
  }
  fireError(message = 'boom'): void {
    this.callbacks.onError?.({ kind: 'unknown', message, retryable: true });
  }

  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  stop(): void {
    this.stopped = true;
  }
  setRate(): boolean {
    return this.rateAccepted;
  }
  get elapsedMs(): number {
    return this.fakeElapsed;
  }
  get done(): boolean {
    return this.finished;
  }
  get speaking(): boolean {
    return !this.stopped && !this.finished && !this.paused;
  }
}

class FakeEngine implements TTSEngine {
  readonly id = 'webspeech' as const;
  capabilities = {
    wordTimings: 'native' as const,
    seek: false,
    ssml: false,
    offline: true,
    metered: false,
    // Matches Web Speech, whose pause() keeps talking after acknowledging.
    reliablePause: false,
  };
  readonly handles: FakeHandle[] = [];

  isAvailable(): boolean {
    return true;
  }
  async listVoices() {
    return [];
  }
  speak(request: SpeakRequest, callbacks: SpeakCallbacks): SpeakHandle {
    const handle = new FakeHandle(request, callbacks);
    this.handles.push(handle);
    return handle;
  }

  get last(): FakeHandle {
    return this.handles[this.handles.length - 1]!;
  }
  get spokenText(): string[] {
    return this.handles.map((h) => h.request.text);
  }
}

class FakeHighlighter implements Highlighter {
  sentence: string | null = null;
  word: string | null = null;
  clears = 0;

  show(sentence: Range | null, word: Range | null): void {
    this.sentence = sentence ? sentence.toString() : null;
    this.word = word ? word.toString() : null;
  }
  clear(): void {
    this.clears++;
    this.sentence = null;
    this.word = null;
  }
}

const HTML = `<main>
  <p>Alpha one. Alpha two. Alpha three.</p>
  <p>Beta one. Beta two.</p>
  <p>Gamma one.</p>
</main>`;

let engine: FakeEngine;
let highlighter: FakeHighlighter;
let player: PlayerController;
let model: ReaderDocument;

/** Play the first sentence and let it actually start. */
function begin(): void {
  player.play();
  engine.last.fireStart();
}

/** Finish the current sentence and run out the inter-sentence pause. */
function finishSentence(): void {
  engine.last.fireEnd();
  vi.runOnlyPendingTimers();
  engine.last.fireStart();
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = HTML;
  model = collectDocument(document);

  engine = new FakeEngine();
  highlighter = new FakeHighlighter();
  player = new PlayerController(engine, highlighter);
  player.load(model);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fixture sanity', () => {
  it('gives us six sentences across three paragraphs', () => {
    expect(model.sentences).toHaveLength(6);
    expect(model.blocks).toHaveLength(3);
  });
});

describe('playback', () => {
  it('speaks the first sentence and reports speaking', () => {
    begin();
    expect(engine.spokenText).toEqual(['Alpha one.']);
    expect(player.getState().status).toBe('speaking');
  });

  it('advances one sentence at a time', () => {
    begin();
    finishSentence();
    expect(engine.spokenText).toEqual(['Alpha one.', 'Alpha two.']);
    expect(player.getState().sentenceIndex).toBe(1);
  });

  it('waits a longer beat when crossing into a new paragraph', () => {
    begin();
    finishSentence(); // Alpha two
    finishSentence(); // Alpha three

    // Last sentence of the block: the next gap is a paragraph pause.
    engine.last.fireEnd();
    vi.advanceTimersByTime(300); // past a sentence pause, short of a paragraph
    expect(engine.spokenText).toHaveLength(3);

    vi.advanceTimersByTime(400);
    expect(engine.spokenText[3]).toBe('Beta one.');
  });

  it('ends after the final sentence and clears the highlight', () => {
    begin();
    for (let i = 0; i < 5; i++) finishSentence();
    expect(player.getState().sentenceIndex).toBe(5);

    engine.last.fireEnd();
    vi.runOnlyPendingTimers();

    expect(player.getState().status).toBe('ended');
    expect(highlighter.sentence).toBeNull();
  });

  it('restarts from the top once ended', () => {
    begin();
    for (let i = 0; i < 5; i++) finishSentence();
    engine.last.fireEnd();
    vi.runOnlyPendingTimers();

    player.play();
    expect(engine.last.request.text).toBe('Alpha one.');
  });
});

describe('highlighting', () => {
  it('highlights the sentence being spoken', () => {
    begin();
    expect(highlighter.sentence).toBe('Alpha one.');
    expect(highlighter.word).toBeNull();
  });

  it('highlights the word from a boundary event', () => {
    begin();
    engine.last.fireWord(6); // "one" inside "Alpha one."
    expect(highlighter.word).toBe('one');
    expect(highlighter.sentence).toBe('Alpha one.');
  });

  it('maps boundary indices relative to a mid-sentence restart', () => {
    begin();
    engine.last.fireWord(6);

    // Rate change forces a restart from "one"; the engine now receives only
    // the tail, so its charIndex 0 must still resolve to "one", not "Alpha".
    player.setRate(1.5);
    expect(engine.last.request.text).toBe('one.');

    engine.last.fireStart();
    engine.last.fireWord(0);
    expect(highlighter.word).toBe('one');
  });

  it('stops emitting words when word highlighting is switched off', () => {
    begin();
    engine.last.fireWord(6);
    expect(highlighter.word).toBe('one');

    player.updateSettings({ wordHighlight: false });
    expect(highlighter.word).toBeNull();

    engine.last.fireWord(0);
    expect(highlighter.word).toBeNull();
  });
});

describe('skipping', () => {
  it('moves forward a sentence and cancels the current utterance', () => {
    begin();
    const first = engine.last;
    player.skip(1);

    expect(first.stopped).toBe(true);
    expect(engine.last.request.text).toBe('Alpha two.');
  });

  it('goes to the previous sentence when pressed early', () => {
    begin();
    finishSentence(); // now on "Alpha two."
    engine.last.fakeElapsed = 500;

    player.skip(-1);
    expect(engine.last.request.text).toBe('Alpha one.');
  });

  it('repeats the current sentence when pressed late', () => {
    begin();
    finishSentence();
    engine.last.fakeElapsed = 4000;

    player.skip(-1);
    // Someone four seconds into a line who presses Back wants that line again.
    expect(engine.last.request.text).toBe('Alpha two.');
  });

  it('jumps a whole paragraph forward', () => {
    begin();
    player.skip(1, 'paragraph');
    expect(engine.last.request.text).toBe('Beta one.');
  });

  it('jumps back to the start of the previous paragraph', () => {
    begin();
    player.skip(1, 'paragraph'); // Beta one
    player.skip(1); // Beta two
    player.skip(-1, 'paragraph');
    expect(engine.last.request.text).toBe('Alpha one.');
  });

  it('clamps at the ends', () => {
    begin();
    player.skip(-1);
    expect(engine.last.request.text).toBe('Alpha one.');

    player.jumpTo(99);
    expect(player.getState().sentenceIndex).toBe(5);
  });
});

describe('stale callbacks', () => {
  it('ignores a late onEnd from a cancelled utterance', () => {
    begin();
    const first = engine.last;

    player.skip(1); // cancels the first utterance
    expect(player.getState().sentenceIndex).toBe(1);

    // The cancelled utterance now fires onEnd, as Chrome really does after
    // cancel(). Acting on it would advance the cursor a second time and put
    // the highlight a sentence ahead of the audio.
    first.fireEnd();
    vi.runOnlyPendingTimers();

    expect(player.getState().sentenceIndex).toBe(1);
    expect(engine.spokenText).toEqual(['Alpha one.', 'Alpha two.']);
  });

  it('ignores late word events from a superseded utterance', () => {
    begin();
    const first = engine.last;
    player.skip(1);
    engine.last.fireStart();

    first.fireWord(6);
    expect(highlighter.sentence).toBe('Alpha two.');
  });

  it('ignores a late error from a cancelled utterance', () => {
    begin();
    const first = engine.last;
    player.skip(1);

    first.fireError();
    expect(player.getState().status).not.toBe('error');
  });
});

describe('pause and resume, engines whose pause() is unreliable', () => {
  it('stops the audio immediately rather than letting it drain', () => {
    begin();
    const first = engine.last;
    player.pause();

    // Web Speech's pause() acknowledges in ~11ms and then keeps talking, which
    // reads as a dead button. Cancelling is the only way to stop on demand.
    expect(first.stopped).toBe(true);
    expect(player.getState().status).toBe('paused');
  });

  it('resumes from the word that was in progress', () => {
    begin();
    engine.last.fireWord(6); // on "one"
    player.pause();
    player.resume();

    expect(player.getState().status).not.toBe('paused');
    expect(engine.last.request.text).toBe('one.');
  });

  it('resumes from the start of the sentence if no word was reported yet', () => {
    begin();
    player.pause();
    player.resume();
    expect(engine.last.request.text).toBe('Alpha one.');
  });

  it('ignores a late onEnd from the utterance pause cancelled', () => {
    begin();
    const first = engine.last;
    player.pause();

    // The cancelled utterance still fires onEnd, as Chrome really does.
    first.fireEnd();
    vi.runOnlyPendingTimers();

    // It must not advance the cursor or resume playback behind our back.
    expect(player.getState().status).toBe('paused');
    expect(player.getState().sentenceIndex).toBe(0);
  });

  it('toggles between playing and paused', () => {
    begin();
    player.toggle();
    expect(player.getState().status).toBe('paused');
    player.toggle();
    vi.advanceTimersByTime(500);
    expect(player.getState().status).toBe('speaking');
  });
});

describe('pause and resume, engines whose pause() is reliable', () => {
  beforeEach(() => {
    engine.capabilities = { ...engine.capabilities, reliablePause: true };
  });

  it('pauses and resumes without re-speaking', () => {
    begin();
    player.pause();
    expect(engine.last.paused).toBe(true);
    expect(player.getState().status).toBe('paused');

    player.resume();
    vi.advanceTimersByTime(500);
    expect(player.getState().status).toBe('speaking');
    expect(engine.handles).toHaveLength(1);
  });

  it('re-speaks when the engine silently dropped the utterance on resume', () => {
    begin();
    engine.last.fireWord(6);
    player.pause();

    // Simulate Chrome discarding the utterance while paused: resume() returns
    // cleanly but no audio is playing.
    engine.last.stopped = true;

    player.resume();
    vi.advanceTimersByTime(500);

    expect(engine.handles).toHaveLength(2);
    expect(engine.last.request.text).toBe('one.');
  });
});

describe('rate and boost', () => {
  it('restarts the sentence when the engine cannot retune live', () => {
    begin();
    engine.last.rateAccepted = false;
    player.setRate(1.4);

    expect(engine.handles).toHaveLength(2);
    expect(engine.last.request.rate).toBeCloseTo(1.4);
  });

  it('does not restart when the engine accepts the new rate', () => {
    begin();
    engine.last.rateAccepted = true;
    player.setRate(1.4);

    expect(engine.handles).toHaveLength(1);
    expect(player.getState().rate).toBeCloseTo(1.4);
  });

  it('multiplies the rate while boost is held and restores it after', () => {
    begin();
    player.setRate(1);

    player.setBoost(true);
    expect(player.effectiveRate).toBeCloseTo(BOOST_MULTIPLIER);
    expect(engine.last.request.rate).toBeCloseTo(BOOST_MULTIPLIER);

    player.setBoost(false);
    expect(player.effectiveRate).toBeCloseTo(1);
    expect(engine.last.request.rate).toBeCloseTo(1);
  });

  it('resumes boost from the current word, not the start of the sentence', () => {
    begin();
    engine.last.fireWord(6); // on "one"
    player.setBoost(true);
    expect(engine.last.request.text).toBe('one.');
  });

  it('keeps the persistent rate independent of the boost', () => {
    begin();
    player.setRate(0.8);
    player.setBoost(true);
    player.setBoost(false);
    expect(player.getState().rate).toBeCloseTo(0.8);
  });

  it('clamps the rate to the range the engine can actually deliver', () => {
    // MAX_RATE is the fastest engine step that still articulates, not a
    // plateau -- see lib/player/rate.ts for the measurement.
    player.setRate(99);
    expect(player.getState().rate).toBe(MAX_RATE);
    player.setRate(0.01);
    expect(player.getState().rate).toBe(MIN_RATE);
  });

  it('keeps the boosted rate inside the usable range too', () => {
    player.setRate(MAX_RATE);
    player.setBoost(true);
    expect(player.effectiveRate).toBeLessThanOrEqual(MAX_RATE);
  });

  it('reports the rate the engine will really use on a staircase engine', () => {
    player.updateSettings({ rateQuantized: true });
    // 1.9 and 1.59 are the same engine step, so 1.9 is not a speed that
    // exists. Reporting it would make the label, the time-left estimate and
    // the pause scaling all wrong by the same amount.
    player.setRate(1.9);
    expect(player.getState().rate).toBeCloseTo(1.9);
    expect(player.effectiveRate).toBeCloseTo(1.59);
  });

  it('leaves the rate alone on an engine with a continuous one', () => {
    player.updateSettings({ rateQuantized: false });
    player.setRate(1.9);
    expect(player.effectiveRate).toBeCloseTo(1.9);
  });

  it('speaks at the real rate rather than the requested one', () => {
    player.updateSettings({ rateQuantized: true });
    begin();
    player.setRate(1.9);
    expect(engine.last.request.rate).toBeCloseTo(1.59);
  });
});

describe('errors and teardown', () => {
  it('surfaces an engine error', () => {
    begin();
    engine.last.fireError('no voice');
    const state = player.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('no voice');
  });

  it('stop resets to the beginning and clears highlights', () => {
    begin();
    finishSentence();
    player.stop();

    const state = player.getState();
    expect(state.status).toBe('idle');
    expect(state.sentenceIndex).toBe(0);
    expect(highlighter.sentence).toBeNull();
  });

  it('jumpTo while idle moves the highlight without speaking', () => {
    player.jumpTo(3);
    expect(engine.handles).toHaveLength(0);
    expect(highlighter.sentence).toBe('Beta one.');
    expect(player.getState().sentenceIndex).toBe(3);
  });

  it('is safe to destroy mid-sentence', () => {
    begin();
    player.destroy();
    expect(engine.last.stopped).toBe(true);
    expect(() => engine.last.fireEnd()).not.toThrow();
  });

  it('does nothing on an empty document', () => {
    document.body.innerHTML = '<main></main>';
    player.load(collectDocument(document));
    player.play();
    expect(engine.handles).toHaveLength(0);
  });
});

describe('pausing in the gap between sentences', () => {
  it('resumes on the NEXT sentence, not the one just finished', () => {
    begin();
    // The sentence ends; we are now inside the inter-sentence silence with the
    // cursor not yet advanced. Pausing here and resuming used to replay the
    // sentence the listener had just heard in full.
    engine.last.fireEnd();
    expect(player.getState().sentenceIndex).toBe(0);

    player.pause();
    expect(player.getState().status).toBe('paused');

    player.resume();
    expect(engine.last.request.text).toBe('Alpha two.');
    expect(player.getState().sentenceIndex).toBe(1);
  });

  it('ends cleanly if the gap was after the final sentence', () => {
    begin();
    for (let i = 0; i < 5; i++) finishSentence();
    engine.last.fireEnd(); // last sentence done, nothing left to advance to

    player.pause();
    player.resume();
    expect(player.getState().status).toBe('ended');
  });

  it('still resumes mid-sentence when paused mid-sentence', () => {
    begin();
    engine.last.fireWord(6); // partway through "Alpha one."
    player.pause();
    player.resume();

    expect(engine.last.request.text).toBe('one.');
    expect(player.getState().sentenceIndex).toBe(0);
  });

  it('a skip while paused clears the pending advance', () => {
    begin();
    engine.last.fireEnd();
    player.pause();

    player.jumpTo(4);
    player.resume();
    // Must honour the jump, not the remembered "advance by one".
    expect(player.getState().sentenceIndex).toBe(4);
  });
});
