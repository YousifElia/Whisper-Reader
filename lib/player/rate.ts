/**
 * Speed, and the fact that it is not continuous.
 *
 * Chromium on Windows does not pass `rate` through to the speech engine. It
 * converts it to SAPI's integer rate scale with
 *
 *     sapiRate = trunc(10 * log10(rate))
 *
 * so whole ranges of requested rates collapse onto one real speed. Measured on
 * this machine's SAPI voices through Chromium, one fixed 71-character
 * sentence, volume 0 (silent utterances still take full time and fire every
 * event, which is what makes the probe below possible):
 *
 *   requested  0.5   0.6   0.63  0.7   0.79  0.8   0.9   1.0
 *   duration  5837  5209  5211  4707  4702  4320  4317  4316 ms
 *   sapi        -3    -2    -2    -1    -1     0     0     0
 *
 *   requested  1.0   1.1   1.2   1.3   1.4   1.5   1.6   1.7   1.8   1.9   2.0
 *   duration  4320  4310  4311  3721  3725  3719  3381  3370  3361  3381  2963
 *   sapi         0     0     0     1     1     1     2     2     2     2     3
 *
 * Identical within measurement noise (0.1%) inside a step, 9-12% apart across
 * one. The same staircase appears on every voice, because it is the engine's
 * mapping and not the voice's.
 *
 * Two consequences the product got wrong:
 *
 *  1. Dragging the speed slider mostly does nothing, and then jumps a whole
 *     26% step at once. That sudden jump into a more compressed SAPI rate is
 *     what gets heard as the voice starting to mumble -- there is no gentle
 *     way up, because the engine has no intermediate speed to offer.
 *
 *  2. 0.8, 0.9 and 1.0 are the same speed. "Bedtime", "Calm" and "Focus" were
 *     all speaking at exactly 1.0 on this platform.
 *
 * A previous measurement sampled only 2.0 and 2.5, found them identical, and
 * concluded the engine plateaus above 2.0. It does not -- 2.0 and 2.5 simply
 * land in the same bucket (2.5 < 10^0.4 = 2.512). Rate 3.0 and 4.0 are
 * measurably faster still. The 2.0 ceiling stays, but for the honest reason:
 * SAPI step 3 is the fastest that still articulates.
 */

export const MIN_RATE = 0.5;

/**
 * Highest rate worth offering. SAPI step 3 (1.995) is fast but still
 * articulate; step 4 and beyond slur badly on the stock Windows voices.
 */
export const MAX_RATE = 2;

/** Hold the fast-forward key and the voice runs at this multiple, capped at
 *  MAX_RATE. */
export const BOOST_MULTIPLIER = 2;

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

/** The engine's integer rate for a requested rate, on a quantizing engine. */
export function engineStep(rate: number): number {
  if (!(rate > 0)) return 0;
  // The trailing "|| 0" normalises the negative zero Math.trunc returns for
  // anything in (-1, 0), which is every rate between 0.795 and 1. Same number,
  // but it compares unequal to 0 under Object.is and reads as a bug.
  return Math.trunc(10 * Math.log10(rate)) || 0;
}

/** The requested rate that sits exactly on a given step. */
export function rateForStep(step: number): number {
  return 10 ** (step / 10);
}

/**
 * A presentable rate that still lands on the intended step.
 *
 * The exact step rates are values like 1.58489, which are no good as slider
 * stops or labels, but rounding them to two places is not safe in either
 * direction: 1.585 rounds to 1.58, and 10*log10(1.58) is 1.987, so the rung
 * would quietly fall back into the step below it and duplicate the one before.
 * Rounding away from 1.0 always lands just inside the intended step.
 */
function stepRate(step: number): number {
  const exact = rateForStep(step) * 100;
  const rounded = (step >= 0 ? Math.ceil(exact) : Math.floor(exact)) / 100;
  return clamp(rounded, MIN_RATE, MAX_RATE);
}

/**
 * What a quantizing engine will actually speak at when asked for `rate`.
 *
 * This is truth-telling rather than policy: asking for 1.9 and asking for
 * 1.59 produce byte-identical audio, so reporting 1.59 is simply the correct
 * answer to "how fast is this going to be".
 */
export function actualRate(rate: number): number {
  return stepRate(engineStep(clamp(rate, MIN_RATE, MAX_RATE)));
}

/**
 * Every distinct speed a quantizing engine can produce between MIN and MAX.
 * Seven of them, and nothing in between exists to be offered.
 */
export const QUANTIZED_LADDER: readonly number[] = (() => {
  const out: number[] = [];
  for (let step = engineStep(MIN_RATE); step <= engineStep(MAX_RATE); step++) {
    out.push(stepRate(step));
  }
  return out;
})();

/**
 * For engines whose rate really is continuous (Firefox, macOS, and Chrome's
 * network voices, which resample real audio instead of driving SAPI). Still a
 * ladder rather than a free slider: discrete notches are what every podcast
 * player uses, and they make the control reproducible.
 */
export const SMOOTH_LADDER: readonly number[] = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2,
];

export function ladderFor(quantized: boolean): readonly number[] {
  return quantized ? QUANTIZED_LADDER : SMOOTH_LADDER;
}

/** Nearest rung, for placing a stored or preset rate on the slider. */
export function snapToLadder(
  rate: number,
  ladder: readonly number[],
): number {
  const target = clamp(rate, MIN_RATE, MAX_RATE);
  let best = ladder[0] ?? target;
  for (const rung of ladder) {
    if (Math.abs(rung - target) < Math.abs(best - target)) best = rung;
  }
  return best;
}

export function ladderIndex(
  rate: number,
  ladder: readonly number[],
): number {
  // On a quantizing engine, place the thumb on the speed actually being
  // heard, not the nearest label. A stored 0.85 is nearer the 0.79 rung but
  // plays at 1.0; showing 0.8x would be wrong, and the first + press would
  // move to 1.0 and change nothing audible.
  const snapped =
    ladder === QUANTIZED_LADDER ? actualRate(rate) : snapToLadder(rate, ladder);
  const index = ladder.indexOf(snapped);
  return index < 0 ? 0 : index;
}

/** Speeds are shown to one decimal. 1.26 is a real speed but a silly label. */
export function formatRate(rate: number): string {
  return `${rate.toFixed(1)}x`;
}

/**
 * The next rung up or down from wherever `rate` currently sits.
 *
 * For the + and - keys. Adding 0.1 to the rate was the keyboard twin of the
 * old free slider: on a quantizing engine four presses in a row could all land
 * in the same step and change nothing, then the fifth jumped a whole step.
 */
export function stepLadder(
  rate: number,
  ladder: readonly number[],
  direction: 1 | -1,
): number {
  const index = ladderIndex(rate, ladder) + direction;
  return ladder[clamp(index, 0, ladder.length - 1)] ?? rate;
}
