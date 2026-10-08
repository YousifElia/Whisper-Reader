/**
 * Tier 1: the browser's own speechSynthesis.
 *
 * Free, offline, zero configuration, and available the moment the extension
 * installs. It is also the buggiest of the three tiers, and most of the code
 * here exists to paper over specific, well-known misbehaviour rather than to
 * do anything clever.
 */

import type {
  EngineCapabilities,
  SpeakCallbacks,
  SpeakError,
  SpeakHandle,
  SpeakRequest,
  TTSEngine,
  Voice,
  WordTimingSupport,
} from './types';

/**
 * Curated calm ranking. Timbre is only half of it -- pacing does at least as
 * much work (see PROSODY in lib/player) -- but starting the user on Zira
 * rather than Samantha undoes a lot of that.
 */
const CALM_RANKING: ReadonlyArray<{ match: RegExp; score: number }> = [
  // Apple's enhanced/premium downloads are the best free voices anywhere.
  { match: /\((?:Enhanced|Premium)\)/i, score: 96 },
  // Windows 11 neural voices, when the user has them installed.
  { match: /Natural/i, score: 94 },
  { match: /^(?:Samantha|Ava|Allison|Susan|Serena|Nicky|Karen|Moira|Fiona|Tessa)\b/i, score: 88 },
  // Chrome's network voices: smooth and pleasant, but see NO_BOUNDARY below.
  { match: /^Google (?:UK English Female|US English)\b/i, score: 84 },
  { match: /^Microsoft (?:Aria|Jenny|Sonia|Libby|Emma|Guy|Ryan)\b/i, score: 78 },
  { match: /^Google\b/i, score: 70 },
  { match: /^(?:Daniel|Alex|Fred|Victoria)\b/i, score: 60 },
  // Legacy SAPI voices. Serviceable, not calm.
  { match: /^Microsoft (?:Zira|David|Hazel|Mark|George)\b/i, score: 38 },
  { match: /espeak|eSpeak/i, score: 8 },
];

/**
 * Voices known not to emit boundary events. This is a prior, not a verdict:
 * `probeWordTimings` still confirms at runtime, because the set changes
 * between Chrome versions and platforms.
 */
const NO_BOUNDARY = /^Google\b/i;

function scoreVoice(name: string): number {
  for (const { match, score } of CALM_RANKING) {
    if (match.test(name)) return score;
  }
  return -1;
}

let voicePromise: Promise<SpeechSynthesisVoice[]> | null = null;

/**
 * getVoices() is empty on first call in most browsers and fills in
 * asynchronously. Firefox sometimes never fires voiceschanged at all, so the
 * timeout is load-bearing rather than defensive.
 */
function loadNativeVoices(): Promise<SpeechSynthesisVoice[]> {
  if (voicePromise) return voicePromise;

  voicePromise = new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const immediate = synth.getVoices();
    if (immediate.length > 0) {
      resolve(immediate);
      return;
    }

    const settle = () => {
      clearTimeout(timer);
      synth.removeEventListener('voiceschanged', settle);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(settle, 1500);
    synth.addEventListener('voiceschanged', settle);
  });

  return voicePromise;
}

/** Voice list changes when the user installs system voices mid-session. */
export function invalidateVoiceCache(): void {
  voicePromise = null;
}

function toVoice(native: SpeechSynthesisVoice): Voice {
  return {
    id: native.voiceURI,
    name: native.name,
    lang: native.lang,
    engineId: 'webspeech',
    localService: native.localService,
    calmScore: scoreVoice(native.name),
    wordTimings: NO_BOUNDARY.test(native.name) ? 'none' : 'unknown',
  };
}

function classifyError(event: SpeechSynthesisErrorEvent): SpeakError {
  switch (event.error) {
    case 'interrupted':
    case 'canceled':
      return { kind: 'interrupted', message: event.error, retryable: false };
    case 'not-allowed':
      return {
        kind: 'unsupported',
        message: 'Speech was blocked by the browser.',
        retryable: false,
      };
    case 'language-unavailable':
    case 'voice-unavailable':
      return {
        kind: 'no-voice',
        message: 'That voice is no longer available.',
        retryable: false,
      };
    case 'network':
      return {
        kind: 'network',
        message: 'This voice needs a network connection.',
        retryable: true,
      };
    default:
      return { kind: 'unknown', message: event.error ?? 'unknown', retryable: true };
  }
}

/**
 * Chrome stops speaking after roughly 15 seconds of a single utterance. Our
 * per-sentence chunking keeps most utterances well under that, but a long
 * sentence at a calm 0.85 rate can still cross it, so we nudge the queue.
 * resume() on a non-paused synth is a no-op everywhere, which is what makes
 * this safe to run unconditionally.
 */
const KEEPALIVE_MS = 10_000;

class WebSpeechHandle implements SpeakHandle {
  private readonly startedAt = performance.now();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;
  private finished = false;
  private userPaused = false;

  constructor(
    private readonly utterance: SpeechSynthesisUtterance,
    private readonly callbacks: SpeakCallbacks,
  ) {
    utterance.onstart = () => {
      if (this.cancelled) return;
      this.keepalive = setInterval(() => {
        // Only nudge when we believe we should be speaking.
        if (!this.userPaused && !this.finished) window.speechSynthesis.resume();
      }, KEEPALIVE_MS);
      callbacks.onStart?.();
    };

    utterance.onboundary = (event) => {
      if (this.cancelled) return;
      // Firefox omits `name`; Chrome sends 'word' and sometimes 'sentence'.
      if (event.name && event.name !== 'word') return;
      callbacks.onWord?.(event.charIndex, event.charLength ?? 0);
    };

    utterance.onend = () => {
      this.cleanup();
      // cancel() fires onend too, with nothing to distinguish it from a
      // natural finish. Without this guard, every skip would advance twice.
      if (this.cancelled) return;
      this.finished = true;
      callbacks.onEnd?.();
    };

    utterance.onerror = (event) => {
      this.cleanup();
      if (this.cancelled) return;
      this.finished = true;
      const error = classifyError(event);
      if (error.kind === 'interrupted') return;
      callbacks.onError?.(error);
    };
  }

  private cleanup(): void {
    if (this.keepalive !== null) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  pause(): void {
    this.userPaused = true;
    window.speechSynthesis.pause();
  }

  resume(): void {
    this.userPaused = false;
    window.speechSynthesis.resume();
  }

  stop(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cleanup();
    window.speechSynthesis.cancel();
  }

  /** Web Speech cannot retune a live utterance; the controller restarts the
   *  sentence from the current word instead. */
  setRate(_rate: number): boolean {
    return false;
  }

  get elapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  get done(): boolean {
    return this.finished;
  }

  get speaking(): boolean {
    return (
      !this.cancelled &&
      !this.finished &&
      window.speechSynthesis.speaking &&
      !window.speechSynthesis.paused
    );
  }

  /** True once cancelled, so the controller can tell a user-driven stop from
   *  an engine failure. */
  get wasCancelled(): boolean {
    return this.cancelled;
  }
}

export class WebSpeechEngine implements TTSEngine {
  readonly id = 'webspeech' as const;

  readonly capabilities: EngineCapabilities = {
    wordTimings: 'native',
    seek: false,
    ssml: false,
    offline: true,
    metered: false,
    // Measured, not assumed: pause() acknowledges in ~11 ms but the voice
    // keeps talking. The controller cancels and resumes from the word instead.
    reliablePause: false,
  };

  isAvailable(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.speechSynthesis !== 'undefined' &&
      typeof SpeechSynthesisUtterance !== 'undefined'
    );
  }

  async listVoices(): Promise<Voice[]> {
    if (!this.isAvailable()) return [];
    const native = await loadNativeVoices();
    return native
      .map(toVoice)
      .sort((a, b) => b.calmScore - a.calmScore || a.name.localeCompare(b.name));
  }

  speak(request: SpeakRequest, callbacks: SpeakCallbacks): SpeakHandle {
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(request.text);

    if (request.voice) {
      const native = synth
        .getVoices()
        .find((v) => v.voiceURI === request.voice!.id);
      if (native) utterance.voice = native;
    }
    utterance.lang = request.voice?.lang ?? request.lang;
    utterance.rate = clamp(request.rate, 0.1, 10);
    utterance.pitch = clamp(request.pitch, 0, 2);
    utterance.volume = clamp(request.volume, 0, 1);

    const handle = new WebSpeechHandle(utterance, callbacks);

    // Clear anything the page (or a previous sentence) left queued, otherwise
    // Chrome plays them back to back and the highlight desynchronises.
    synth.cancel();
    synth.speak(utterance);

    return handle;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Decide a voice's real word-timing support by watching one utterance.
 *
 * Called once per voice and cached, because the answer is a property of the
 * voice and platform, not of the text. A voice that speaks a reasonably long
 * sentence without emitting a single boundary event does not support word
 * highlighting, whatever its name suggests.
 */
export function probeWordTimings(
  boundaryEvents: number,
  textLength: number,
  spokeToCompletion: boolean,
): WordTimingSupport {
  if (!spokeToCompletion) return 'unknown';
  if (boundaryEvents > 0) return 'native';
  // Too short to be conclusive; a three-word sentence can legitimately emit
  // nothing useful, so we withhold judgement rather than disabling the feature.
  if (textLength < 40) return 'unknown';
  return 'none';
}

export const webSpeechEngine = new WebSpeechEngine();
