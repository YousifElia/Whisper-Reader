/**
 * Word timing when the engine will not tell us.
 *
 * Chrome's Google network voices emit no boundary events at all, and they are
 * among the best-sounding free voices available. Rather than silently dropping
 * word highlighting for whoever picks one, we predict it: measure how fast
 * this voice actually speaks, then walk the words on that schedule.
 *
 * This drifts, and it drifts worst on long sentences. It is offered as a
 * clearly-labelled option, not as a pretend equivalent of real timings.
 */

import type { Span } from '../extract/segment';

/** Characters per second at rate 1.0. Seeded near a typical English TTS pace
 *  and corrected from the first real sentence onwards. */
const SEED_CPS = 14.5;

/** Weight early observations heavily, then settle down. */
const FAST_ALPHA = 0.5;
const SLOW_ALPHA = 0.15;
const SETTLE_AFTER = 5;

export class SpeechRateEstimator {
  private cps = SEED_CPS;
  private samples = 0;

  /** Feed a completed sentence back in. Called for every sentence, including
   *  ones spoken with real boundary events, so the estimate is already warm
   *  if the user switches to a voice that lacks them. */
  observe(textLength: number, durationMs: number, rate: number): void {
    if (durationMs < 250 || textLength < 12 || rate <= 0) return;

    const observed = textLength / (durationMs / 1000) / rate;
    // Reject implausible samples: a paused or interrupted sentence otherwise
    // poisons the average for everything after it.
    if (observed < 3 || observed > 60) return;

    const alpha = this.samples < SETTLE_AFTER ? FAST_ALPHA : SLOW_ALPHA;
    this.cps = this.cps * (1 - alpha) + observed * alpha;
    this.samples++;
  }

  estimateMs(textLength: number, rate: number): number {
    return (textLength / (this.cps * Math.max(rate, 0.1))) * 1000;
  }

  get charsPerSecond(): number {
    return this.cps;
  }
}

/**
 * Distribute a sentence's predicted duration across its words.
 *
 * Weighting by character count plus a constant matters: a bare proportional
 * split makes "a" and "extraordinarily" take the same time, and the highlight
 * visibly races ahead on short function words.
 */
function scheduleWords(
  words: readonly Span[],
  totalMs: number,
): number[] {
  const weights = words.map((w) => w.end - w.start + 2.5);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return words.map(() => 0);

  const starts: number[] = [];
  let acc = 0;
  for (const weight of weights) {
    starts.push((acc / sum) * totalMs);
    acc += weight;
  }
  return starts;
}

export interface WordClock {
  stop(): void;
}

/**
 * Drives word highlighting off a predicted schedule, on requestAnimationFrame
 * so it stays in step with painting and stops burning cycles in a hidden tab.
 */
export class EstimatedWordClock implements WordClock {
  private frame: number | null = null;
  private index = -1;
  private readonly startedAt: number;
  private readonly starts: number[];

  constructor(
    words: readonly Span[],
    totalMs: number,
    private readonly onWord: (wordIndex: number) => void,
  ) {
    this.starts = scheduleWords(words, totalMs);
    this.startedAt = performance.now();
    if (words.length > 0) this.tick();
  }

  private tick = (): void => {
    const elapsed = performance.now() - this.startedAt;

    let next = this.index;
    while (next + 1 < this.starts.length && this.starts[next + 1]! <= elapsed) {
      next++;
    }
    if (next !== this.index && next >= 0) {
      this.index = next;
      this.onWord(next);
    }

    if (this.index < this.starts.length - 1) {
      this.frame = requestAnimationFrame(this.tick);
    } else {
      this.frame = null;
    }
  };

  stop(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }
}

/** Placeholder for engines that report their own boundaries. */
export const NULL_WORD_CLOCK: WordClock = { stop() {} };

export { scheduleWords as _scheduleWordsForTest };
