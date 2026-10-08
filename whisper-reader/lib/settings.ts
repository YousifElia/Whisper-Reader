/**
 * Preferences.
 *
 * Split deliberately across two stores. `sync` carries the small, portable
 * preferences worth following you between machines. `local` carries everything
 * machine-specific or sensitive: voice capability verdicts (which differ per
 * platform and would be actively wrong if synced), and later the cloud tier's
 * API keys, which must never leave the device they were entered on.
 */

import { browser } from 'wxt/browser';
import type { WordTimingSupport } from './engines/types';
import { withPresetApplied, type PresetId } from './player/presets';
import type { ThemeChoice } from '../ui/panel/styles';
import {
  DEFAULT_GEOMETRY,
  type PanelGeometry,
} from '../ui/panel/panel';

export interface Settings {
  preset: PresetId;
  /** Panel appearance: follow the OS, or force light/dark. */
  theme: ThemeChoice;
  rate: number;
  pitch: number;
  volume: number;
  voiceId: string | null;
  wordHighlight: boolean;
  autoScroll: boolean;
  highContrast: boolean;
  underlineOnly: boolean;
  sentencePauseMs: number;
  paragraphPauseMs: number;
  headingPauseMs: number;
  panel: PanelGeometry;
}

export const DEFAULT_SETTINGS: Settings = {
  preset: 'calm',
  theme: 'system',
  // A shade under natural pace. Most of the "calm" comes from here and from
  // the inter-sentence pauses, not from the voice itself. Matches the Calm
  // preset, and sits one real engine step below normal rather than inside
  // normal's band -- see lib/player/rate.ts.
  rate: 0.79,
  pitch: 0.98,
  volume: 1,
  voiceId: null,
  wordHighlight: true,
  autoScroll: true,
  highContrast: false,
  underlineOnly: false,
  sentencePauseMs: 260,
  paragraphPauseMs: 520,
  headingPauseMs: 640,
  panel: DEFAULT_GEOMETRY,
};

const SETTINGS_KEY = 'settings';
const CAPABILITY_KEY = 'voiceCapabilities';

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await browser.storage.sync.get(SETTINGS_KEY);
    const value = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
    return withPresetApplied({
      ...DEFAULT_SETTINGS,
      ...value,
      panel: { ...DEFAULT_SETTINGS.panel, ...value?.panel },
    });
  } catch {
    // Sync storage can be unavailable (disabled, quota, private window).
    // Defaults are always better than failing to start.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  try {
    const current = await loadSettings();
    await browser.storage.sync.set({
      [SETTINGS_KEY]: { ...current, ...patch },
    });
  } catch {
    // Losing a preference write is not worth interrupting playback for.
  }
}

/**
 * Per-voice word-timing verdicts, learned by watching one utterance.
 *
 * Local rather than sync because the answer depends on the browser build and
 * the installed system voices: a verdict learned on a Mac is meaningless on
 * the same user's Windows machine.
 */
export async function loadVoiceCapabilities(): Promise<
  Record<string, WordTimingSupport>
> {
  try {
    const stored = await browser.storage.local.get(CAPABILITY_KEY);
    return (stored[CAPABILITY_KEY] as Record<string, WordTimingSupport>) ?? {};
  } catch {
    return {};
  }
}

export async function recordVoiceCapability(
  voiceId: string,
  support: WordTimingSupport,
): Promise<void> {
  if (support === 'unknown') return;
  try {
    const all = await loadVoiceCapabilities();
    if (all[voiceId] === support) return;
    all[voiceId] = support;
    await browser.storage.local.set({ [CAPABILITY_KEY]: all });
  } catch {
    // Non-fatal: we simply re-probe next time.
  }
}

const RATE_QUANTIZATION_KEY = 'rateQuantization';
const ONBOARDING_KEY = 'onboarding';

/**
 * Whether this browser's speech engine offers a continuous rate or a
 * staircase one.
 *
 * Local, and for the same reason as the capability cache: it is a fact about
 * this browser on this operating system. Chromium on Windows quantizes;
 * Firefox and macOS do not. Syncing the verdict would apply one machine's
 * answer to another machine where it is wrong.
 *
 * Null means "not measured yet".
 */
export async function loadRateQuantization(): Promise<boolean | null> {
  try {
    const stored = await browser.storage.local.get(RATE_QUANTIZATION_KEY);
    const value = stored[RATE_QUANTIZATION_KEY] as { quantized: boolean } | undefined;
    return value?.quantized ?? null;
  } catch {
    return null;
  }
}

export async function saveRateQuantization(quantized: boolean): Promise<void> {
  try {
    await browser.storage.local.set({
      [RATE_QUANTIZATION_KEY]: { quantized, at: Date.now() },
    });
  } catch {
    // We simply re-probe next time setup is opened.
  }
}

/**
 * Whether the first-run setup has been completed.
 *
 * Local rather than sync: what setup decides is which of *this* machine's
 * installed voices to use, and those differ between machines. A new machine
 * with a different voice list is worth asking about again.
 */
export async function isOnboarded(): Promise<boolean> {
  try {
    const stored = await browser.storage.local.get(ONBOARDING_KEY);
    return Boolean((stored[ONBOARDING_KEY] as { done?: boolean } | undefined)?.done);
  } catch {
    return false;
  }
}

export async function markOnboarded(): Promise<void> {
  try {
    await browser.storage.local.set({
      [ONBOARDING_KEY]: { done: true, at: Date.now() },
    });
  } catch {
    // Worst case the setup page offers itself again.
  }
}
