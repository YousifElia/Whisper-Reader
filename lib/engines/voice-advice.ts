/**
 * What to tell someone whose machine only has poor voices.
 *
 * This exists because the on-device neural tier did not work out. The browser
 * can only offer what the operating system has installed, and on a stock
 * Windows box that means the legacy SAPI voices, which are not calm by any
 * measure. Both Windows and macOS ship far better neural voices for free --
 * they are just not installed by default, and almost nobody knows they exist.
 */

import type { Voice } from './types';

/** Below this, the curated ranking considers a voice poor enough to be worth
 *  telling the user there is a free upgrade available. */
export const POOR_VOICE_SCORE = 50;

export interface VoiceAdvice {
  readonly headline: string;
  readonly steps: readonly string[];
}

function platform(): 'windows' | 'macos' | 'linux' | 'other' {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'windows';
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) return 'macos';
  if (ua.includes('Linux') || ua.includes('X11')) return 'linux';
  return 'other';
}

const ADVICE: Record<string, VoiceAdvice> = {
  windows: {
    headline: 'Windows has better voices available, free.',
    steps: [
      'Open Settings, then Accessibility, then Narrator.',
      'Under Narrator’s voice, choose Add natural voices.',
      'Add one — Aria, Jenny and Guy are the calmest.',
      'Restart your browser and pick it in the list above.',
    ],
  },
  macos: {
    headline: 'macOS has much better voices available, free.',
    steps: [
      'Open System Settings, then Accessibility, then Spoken Content.',
      'Click the info button next to System Voice, then Manage Voices.',
      'Download an Enhanced or Premium English voice — Ava, Serena or Samantha.',
      'Restart your browser and pick it in the list above.',
    ],
  },
  linux: {
    headline: 'Your system only exposes eSpeak, which is very robotic.',
    steps: [
      'Install a better speech-dispatcher backend, such as Pico or Mbrola.',
      'Set it as the speech-dispatcher default output module.',
      'Restart your browser and pick it in the list above.',
    ],
  },
};

/**
 * Advice for the current machine, or null when the available voices are
 * already good enough that a nag would just be noise.
 */
export function voiceAdvice(voices: readonly Voice[]): VoiceAdvice | null {
  if (voices.length === 0) return null;

  const best = voices.reduce(
    (top, v) => (v.calmScore > top ? v.calmScore : top),
    -1,
  );
  if (best >= POOR_VOICE_SCORE) return null;

  return ADVICE[platform()] ?? null;
}
