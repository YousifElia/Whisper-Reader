import { describe, expect, it } from 'vitest';
import {
  actualRate,
  BOOST_MULTIPLIER,
  engineStep,
  formatRate,
  ladderFor,
  ladderIndex,
  MAX_RATE,
  MIN_RATE,
  QUANTIZED_LADDER,
  rateForStep,
  SMOOTH_LADDER,
  snapToLadder,
  stepLadder,
} from '../lib/player/rate';
import { PRESETS, withPresetApplied } from '../lib/player/presets';

/**
 * The measurements the whole module rests on.
 *
 * One fixed 71-character sentence, spoken by Microsoft David through Chromium
 * on Windows at volume 0, timed from onstart to onend. Reproduce with
 * tests/harness if the numbers are ever doubted -- but the shape, not the
 * absolute values, is what these tests assert, because the absolute values are
 * a property of that machine.
 */
const MEASURED: ReadonlyArray<{ rate: number; ms: number }> = [
  { rate: 0.5, ms: 5837 },
  { rate: 0.6, ms: 5209 },
  { rate: 0.63, ms: 5211 },
  { rate: 0.7, ms: 4707 },
  { rate: 0.79, ms: 4702 },
  { rate: 0.8, ms: 4320 },
  { rate: 0.9, ms: 4317 },
  { rate: 1.0, ms: 4316 },
  { rate: 1.1, ms: 4310 },
  { rate: 1.2, ms: 4311 },
  { rate: 1.3, ms: 3721 },
  { rate: 1.4, ms: 3725 },
  { rate: 1.5, ms: 3719 },
  { rate: 1.6, ms: 3381 },
  { rate: 1.7, ms: 3370 },
  { rate: 1.8, ms: 3361 },
  { rate: 1.9, ms: 3381 },
  { rate: 2.0, ms: 2963 },
];

describe('engineStep, against the measured staircase', () => {
  it('gives one step per distinct measured duration', () => {
    const byStep = new Map<number, number[]>();
    for (const { rate, ms } of MEASURED) {
      const step = engineStep(rate);
      byStep.set(step, [...(byStep.get(step) ?? []), ms]);
    }

    // Within a step the engine produced the same audio, so the durations
    // agree to within measurement noise (observed: 0.2%).
    for (const [step, durations] of byStep) {
      const lo = Math.min(...durations);
      const hi = Math.max(...durations);
      expect((hi - lo) / lo, `step ${step} should be one speed`).toBeLessThan(0.02);
    }

    // And each step really is a different speed (observed: 9-12% apart).
    const steps = [...byStep.keys()].sort((a, b) => a - b);
    for (let i = 1; i < steps.length; i++) {
      const previous = Math.min(...byStep.get(steps[i - 1]!)!);
      const current = Math.max(...byStep.get(steps[i]!)!);
      expect(current, `step ${steps[i]} should be faster than ${steps[i - 1]}`)
        .toBeLessThan(previous * 0.97);
    }
  });

  it('puts 0.8, 0.9 and 1.0 on the same step', () => {
    // The bug this module exists for: three pacing presets that all spoke at
    // exactly the same speed on Chromium/Windows.
    expect(engineStep(0.8)).toBe(engineStep(1));
    expect(engineStep(0.9)).toBe(engineStep(1));
  });

  it('puts 2.0 and 2.5 on the same step, which is what the old reading missed', () => {
    // Sampling only these two produced the false conclusion that the engine
    // plateaus above 2.0. It does not: 2.5 is simply inside the same bucket.
    expect(engineStep(2.5)).toBe(engineStep(2));
    expect(engineStep(3)).toBeGreaterThan(engineStep(2));
  });
});

describe('actualRate', () => {
  it('reports the same speed for every rate inside one step', () => {
    for (const group of [
      [0.8, 0.9, 1.0],
      [1.3, 1.4, 1.5],
      [1.6, 1.7, 1.8, 1.9],
    ]) {
      const answers = new Set(group.map(actualRate));
      expect(answers.size, `${group.join('/')} are one speed`).toBe(1);
    }
  });

  it('never claims a speed outside the offered range', () => {
    for (const rate of [0.01, 0.5, 1, 2, 2.5, 99]) {
      expect(actualRate(rate)).toBeGreaterThanOrEqual(MIN_RATE);
      expect(actualRate(rate)).toBeLessThanOrEqual(MAX_RATE);
    }
  });

  it('is idempotent, so repeated reporting cannot drift', () => {
    for (const rate of [0.5, 0.77, 1, 1.45, 1.9, 2]) {
      expect(actualRate(actualRate(rate))).toBe(actualRate(rate));
    }
  });
});

describe('the quantized ladder', () => {
  it('has one rung per real engine speed, in order', () => {
    const steps = QUANTIZED_LADDER.map(engineStep);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size, 'no two rungs share a step').toBe(steps.length);
  });

  it('keeps every rung inside the step it was built for', () => {
    // The rounding trap: 1.58489 rounded to 1.58 falls back into step 1 and
    // becomes a silent duplicate of 1.26. Rungs must round away from 1.0.
    for (let i = 0; i < QUANTIZED_LADDER.length; i++) {
      const rung = QUANTIZED_LADDER[i]!;
      expect(actualRate(rung), `rung ${rung} must be its own speed`).toBe(rung);
    }
  });

  it('stays within the offered range', () => {
    for (const rung of QUANTIZED_LADDER) {
      expect(rung).toBeGreaterThanOrEqual(MIN_RATE);
      expect(rung).toBeLessThanOrEqual(MAX_RATE);
    }
  });

  it('labels every rung distinctly', () => {
    const labels = QUANTIZED_LADDER.map(formatRate);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('the smooth ladder', () => {
  it('ascends and stays in range', () => {
    expect(SMOOTH_LADDER).toEqual([...SMOOTH_LADDER].sort((a, b) => a - b));
    expect(SMOOTH_LADDER[0]).toBe(MIN_RATE);
    expect(SMOOTH_LADDER[SMOOTH_LADDER.length - 1]).toBe(MAX_RATE);
  });

  it('is the default, because hiding a working speed is worse than offering a duplicate', () => {
    expect(ladderFor(false)).toBe(SMOOTH_LADDER);
    expect(ladderFor(true)).toBe(QUANTIZED_LADDER);
  });
});

describe('snapping', () => {
  it('lands a stored rate on the nearest rung', () => {
    expect(snapToLadder(1, QUANTIZED_LADDER)).toBe(1);
    expect(snapToLadder(1.95, QUANTIZED_LADDER)).toBe(2);
    expect(snapToLadder(0.51, QUANTIZED_LADDER)).toBe(0.5);
  });

  it('clamps a rate from outside the range rather than falling off the slider', () => {
    for (const ladder of [QUANTIZED_LADDER, SMOOTH_LADDER]) {
      expect(ladderIndex(99, ladder)).toBe(ladder.length - 1);
      expect(ladderIndex(0.01, ladder)).toBe(0);
    }
  });

  it('round-trips every rung to its own index', () => {
    for (const ladder of [QUANTIZED_LADDER, SMOOTH_LADDER]) {
      ladder.forEach((rung, index) => {
        expect(ladderIndex(rung, ladder)).toBe(index);
      });
    }
  });
});

describe('presets', () => {
  it('re-applies a named preset over stale stored values', () => {
    // Calm used to be 0.9, which a quantizing engine plays at Focus speed.
    const migrated = withPresetApplied({ preset: 'calm' as const, rate: 0.9 });
    expect(migrated.rate).toBe(0.79);
  });

  it('leaves a custom speed alone', () => {
    const custom = withPresetApplied({ preset: 'custom' as const, rate: 1.42 });
    expect(custom.rate).toBe(1.42);
  });

  it('gives each pacing preset a genuinely different speed', () => {
    // Bedtime, Calm and Focus used to be 0.8, 0.9 and 1.0 -- one speed wearing
    // three labels on Chromium/Windows.
    const steps = PRESETS.map((preset) => engineStep(preset.settings.rate));
    expect(new Set(steps).size).toBe(PRESETS.length);
  });

  it('keeps every preset within the offered range', () => {
    for (const preset of PRESETS) {
      expect(preset.settings.rate).toBeGreaterThanOrEqual(MIN_RATE);
      expect(preset.settings.rate).toBeLessThanOrEqual(MAX_RATE);
    }
  });
});

describe('boost', () => {
  it('cannot be pushed past the ceiling', () => {
    for (const rung of QUANTIZED_LADDER) {
      const boosted = Math.min(rung * BOOST_MULTIPLIER, MAX_RATE);
      expect(actualRate(boosted)).toBeLessThanOrEqual(MAX_RATE);
    }
  });
});

describe('stepLadder, for the + and - keys', () => {
  it('moves exactly one real speed per press', () => {
    // The old +0.1 could take four presses to change anything audible.
    let rate = 0.79;
    const visited = [rate];
    for (let i = 0; i < 4; i++) {
      rate = stepLadder(rate, QUANTIZED_LADDER, 1);
      visited.push(rate);
    }
    expect(visited).toEqual([0.79, 1, 1.26, 1.59, 2]);
    expect(new Set(visited.map(engineStep)).size).toBe(visited.length);
  });

  it('stops at the ends instead of falling off them', () => {
    expect(stepLadder(MAX_RATE, QUANTIZED_LADDER, 1)).toBe(MAX_RATE);
    expect(stepLadder(MIN_RATE, SMOOTH_LADDER, -1)).toBe(MIN_RATE);
  });

  it('steps from the speed being heard, not the nearest label', () => {
    // 0.85 is nearer the 0.79 rung but plays at 1.0, so one press up must
    // reach 1.26 -- going to 1.0 would be a press that changes nothing.
    expect(stepLadder(0.85, QUANTIZED_LADDER, 1)).toBe(1.26);
    expect(stepLadder(0.85, QUANTIZED_LADDER, -1)).toBe(0.79);
    expect(ladderIndex(0.85, QUANTIZED_LADDER)).toBe(QUANTIZED_LADDER.indexOf(1));
  });
});

describe('rateForStep', () => {
  it('ascends', () => {
    for (let step = -3; step < 3; step++) {
      expect(rateForStep(step + 1)).toBeGreaterThan(rateForStep(step));
    }
  });

  it('puts each step a quarter faster than the last', () => {
    // Why the ladder is only seven rungs wide: the engine's steps are
    // multiplicative, not additive, so there is genuinely nothing between
    // them to offer.
    for (let step = -3; step < 3; step++) {
      const ratio = rateForStep(step + 1) / rateForStep(step);
      expect(ratio).toBeCloseTo(1.259, 3);
    }
  });
});
