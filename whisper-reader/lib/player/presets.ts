/**
 * Calm presets.
 *
 * The four rates are 0.63, 0.79, 1.0 and 1.3 rather than rounder numbers
 * because those are the only values that land on four *different* speeds on a
 * quantizing engine. Bedtime, Calm and Focus were previously 0.8, 0.9 and 1.0,
 * which Chromium on Windows maps to a single speed: three presets, three
 * descriptions, one identical pace. See lib/player/rate.ts.
 *
 * With Kokoro ruled out, pacing is the main lever left -- and it was always
 * the bigger one. Perceived calmness comes mostly from speaking slightly under
 * natural pace and leaving real silence between sentences, not from timbre.
 * A mediocre system voice at 0.82 with 420 ms between sentences sounds calmer
 * than a good voice run flat out.
 */

import type { PlayerSettings } from './controller';

export type PresetId = 'bedtime' | 'calm' | 'focus' | 'brisk' | 'custom';

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  readonly description: string;
  readonly settings: Pick<
    PlayerSettings,
    'rate' | 'pitch' | 'sentencePauseMs' | 'paragraphPauseMs' | 'headingPauseMs'
  >;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'bedtime',
    label: 'Bedtime',
    description: 'Slowest, with long silences. For listening with eyes closed.',
    settings: {
      rate: 0.63,
      pitch: 0.94,
      sentencePauseMs: 430,
      paragraphPauseMs: 820,
      headingPauseMs: 1000,
    },
  },
  {
    id: 'calm',
    label: 'Calm',
    description: 'Unhurried but not sleepy. The default.',
    settings: {
      rate: 0.79,
      pitch: 0.98,
      sentencePauseMs: 260,
      paragraphPauseMs: 520,
      headingPauseMs: 640,
    },
  },
  {
    id: 'focus',
    label: 'Focus',
    description: 'Natural pace, shorter gaps. For reading along.',
    settings: {
      rate: 1,
      pitch: 1,
      sentencePauseMs: 180,
      paragraphPauseMs: 360,
      headingPauseMs: 450,
    },
  },
  {
    id: 'brisk',
    label: 'Brisk',
    description: 'For getting through something quickly.',
    settings: {
      rate: 1.3,
      pitch: 1,
      sentencePauseMs: 110,
      paragraphPauseMs: 240,
      headingPauseMs: 300,
    },
  },
];

export function findPreset(id: PresetId): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/**
 * A named preset means "use that preset's values", so they are re-applied on
 * load rather than trusted from storage. Any manual change already switches
 * the preset to 'custom', so nothing deliberate is overwritten -- but values a
 * preset had in an older version are. That matters: Calm was 0.9 before it
 * was 0.79, and 0.9 is the same speed as Focus on a quantizing engine.
 */
export function withPresetApplied<T extends { preset: PresetId }>(
  settings: T,
): T {
  const preset = findPreset(settings.preset);
  return preset ? { ...settings, ...preset.settings } : settings;
}

/** Which preset the current settings correspond to, or 'custom' once the user
 *  has nudged the speed slider away from a preset's value. */
export function matchPreset(
  settings: Pick<PlayerSettings, 'rate' | 'sentencePauseMs'>,
): PresetId {
  for (const preset of PRESETS) {
    if (
      Math.abs(preset.settings.rate - settings.rate) < 0.02 &&
      preset.settings.sentencePauseMs === settings.sentencePauseMs
    ) {
      return preset.id;
    }
  }
  return 'custom';
}
