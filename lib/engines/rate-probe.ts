/**
 * Find out whether this browser's speech engine has a continuous rate control
 * or a staircase one, by measuring it.
 *
 * The trick that makes this bearable is that a `volume: 0` utterance still
 * takes its full time and fires every event. So we can ask the engine to speak
 * a short phrase twice, inaudibly, and time it -- no audio, no interruption,
 * about four seconds.
 *
 * 0.9 and 1.0 are the chosen pair because they straddle nothing: on a
 * continuous engine 0.9 is about 11% slower, while a Chromium/SAPI engine maps
 * both to rate step 0 and returns the same duration to within measurement
 * noise. See lib/player/rate.ts for the full measurement this is derived from.
 */

const PROBE_TEXT = 'Whisper reader is ready.';

/** Measured with this phrase on Microsoft David: same step 1.3%, a real step
 *  7.8%, repeat noise 1.2% (the first utterance after a pause runs a touch
 *  slow). 4% sits clear of both. */
const SAME_STEP_TOLERANCE = 0.04;

/** A duration below this means the engine skipped the utterance rather than
 *  speaking it silently, which makes the comparison meaningless. */
const MIN_PLAUSIBLE_MS = 300;

/** Well clear of the ~2s each utterance should take. */
const PROBE_TIMEOUT_MS = 15_000;

export interface RateProbe {
  readonly quantized: boolean;
  readonly samples: ReadonlyArray<{ rate: number; ms: number }>;
}

function timeOne(rate: number, voice: SpeechSynthesisVoice | null): Promise<number> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(PROBE_TEXT);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.pitch = 1;
    utterance.volume = 0;

    let started = 0;
    let settled = false;
    const finish = (ms: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ms);
    };
    const timer = setTimeout(() => {
      synth.cancel();
      finish(-1);
    }, PROBE_TIMEOUT_MS);

    utterance.onstart = () => {
      started = performance.now();
    };
    utterance.onend = () => finish(started ? performance.now() - started : -1);
    utterance.onerror = () => finish(-1);

    synth.cancel();
    synth.speak(utterance);
  });
}

/**
 * Returns null when the answer cannot be trusted -- no engine, no voice, an
 * error, or a duration too short to have been real speech. Callers should
 * treat null as "assume continuous", which is the conservative choice: it
 * leaves the finer ladder in place rather than hiding speeds that work.
 */
export async function probeRateQuantization(
  voice: SpeechSynthesisVoice | null = null,
  /**
   * Checked immediately before each utterance. The probe starts with
   * synth.cancel(), so running it on a page where the user has since pressed
   * play would cut them off; the reader passes its own idle check here.
   */
  canSpeak: () => boolean = () => true,
): Promise<RateProbe | null> {
  if (
    typeof window === 'undefined' ||
    typeof window.speechSynthesis === 'undefined' ||
    typeof SpeechSynthesisUtterance === 'undefined'
  ) {
    return null;
  }

  // Probing on top of live speech would cancel it. Never worth it.
  if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
    return null;
  }

  // Measure an on-device voice when there is one. The staircase belongs to
  // the local engine (SAPI); Chrome's network voices resample real audio and
  // are continuous, so probing one would report "continuous" on a machine
  // whose local voices are anything but -- and Chrome on Windows lists its
  // network voices first in headless and some other configurations.
  const target =
    voice ??
    window.speechSynthesis.getVoices().find((v) => v.localService) ??
    null;

  if (!canSpeak()) return null;
  const atOne = await timeOne(1, target);
  if (!canSpeak()) return null;
  const atNinety = await timeOne(0.9, target);
  // Also check afterwards. Something that started speaking mid-probe would
  // have cancelled our utterance, and a truncated duration that still cleared
  // MIN_PLAUSIBLE_MS would read as a large difference and produce a confident
  // wrong answer.
  if (!canSpeak()) return null;

  if (atOne < MIN_PLAUSIBLE_MS || atNinety < MIN_PLAUSIBLE_MS) return null;

  const delta = Math.abs(atNinety - atOne) / atOne;
  return {
    quantized: delta < SAME_STEP_TOLERANCE,
    samples: [
      { rate: 1, ms: Math.round(atOne) },
      { rate: 0.9, ms: Math.round(atNinety) },
    ],
  };
}
