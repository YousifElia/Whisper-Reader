/**
 * One interface, three tiers behind it.
 *
 * The player controller talks only to this. That is what keeps the cloud and
 * on-device neural tiers from leaking their very different mechanics --
 * network latency, audio buffers, real seeking -- into the transport logic.
 */

export type EngineId =
  | 'webspeech'
  | 'cloud:openai'
  | 'cloud:google'
  | 'cloud:elevenlabs'
  | 'local:kokoro';

/**
 * How (and whether) an engine can tell us which word is being spoken.
 *
 *   native      - the engine emits boundary events as it speaks
 *   timestamps  - the engine returns word offsets up front, and we drive the
 *                 highlight off audio playback position
 *   estimated   - no timing at all; we predict from a calibrated speaking rate
 *   none        - word highlighting is off; sentence highlighting still works
 *   unknown     - not probed yet
 *
 * 'unknown' matters more than it looks. Chrome's Google network voices are
 * among the nicest-sounding free options and emit no boundary events
 * whatsoever, so the only honest answer is to probe at runtime and tell the
 * user what they get, rather than shipping a feature that silently does
 * nothing on the voice they picked.
 */
export type WordTimingSupport =
  | 'native'
  | 'timestamps'
  | 'estimated'
  | 'none'
  | 'unknown';

export interface Voice {
  readonly id: string;
  readonly name: string;
  readonly lang: string;
  readonly engineId: EngineId;
  /** Runs on-device. Network voices stop working offline and usually cost. */
  readonly localService: boolean;
  /** 0-100 curated "calm" ranking; -1 when we have no opinion. */
  readonly calmScore: number;
  readonly wordTimings: WordTimingSupport;
}

export interface EngineCapabilities {
  readonly wordTimings: WordTimingSupport;
  /** True only when real audio backs playback, which is what makes
   *  within-sentence seeking and seamless rate changes possible. */
  readonly seek: boolean;
  readonly ssml: boolean;
  readonly offline: boolean;
  /** Costs money per use, so the UI should say so before it is enabled. */
  readonly metered: boolean;
  /**
   * Whether pause() actually stops the audio promptly.
   *
   * Web Speech does not: measured on Windows SAPI, pause() sets
   * speechSynthesis.paused within 11 ms while speechSynthesis.speaking stays
   * true and the voice audibly keeps going. When this is false the controller
   * cancels and remembers the position instead, which stops instantly at the
   * cost of resuming from the start of the current word.
   */
  readonly reliablePause: boolean;
}

export interface SpeakRequest {
  readonly text: string;
  readonly voice: Voice | null;
  /** 0.5 - 3.0, where 1 is the voice's natural pace. */
  readonly rate: number;
  readonly pitch: number;
  readonly volume: number;
  readonly lang: string;
}

export type SpeakErrorKind =
  | 'interrupted'
  | 'no-voice'
  | 'network'
  | 'auth'
  | 'quota'
  | 'unsupported'
  | 'unknown';

export interface SpeakError {
  readonly kind: SpeakErrorKind;
  readonly message: string;
  /** Retrying the same request is pointless for auth or quota failures. */
  readonly retryable: boolean;
}

export interface SpeakCallbacks {
  onStart?(): void;
  /** `charIndex` is an offset into the request's `text`, which the controller
   *  maps back to the DOM through the block's OffsetMap. */
  onWord?(charIndex: number, charLength: number): void;
  onEnd?(): void;
  onError?(error: SpeakError): void;
}

export interface SpeakHandle {
  pause(): void;
  resume(): void;
  /** Idempotent, and must not fire onEnd -- the controller distinguishes
   *  "finished naturally, advance" from "was cancelled, do not advance". */
  stop(): void;
  /**
   * Returns true if the new rate took effect on the current utterance.
   * Web Speech cannot retune a live utterance and returns false, telling the
   * controller to restart the sentence from the current word instead.
   */
  setRate(rate: number): boolean;
  readonly elapsedMs: number;
  readonly done: boolean;
  /**
   * Whether audio is actually coming out right now.
   *
   * Needed because Chrome's speechSynthesis.pause()/resume() is unreliable on
   * some platforms: resume() can return having silently dropped the utterance.
   * The controller checks this shortly after resuming and restarts the
   * sentence from the current word if the engine lied.
   */
  readonly speaking: boolean;
}

export interface TTSEngine {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  /** Cheap synchronous check; a tier can be compiled in but unusable here. */
  isAvailable(): boolean;
  listVoices(): Promise<Voice[]>;
  speak(request: SpeakRequest, callbacks: SpeakCallbacks): SpeakHandle;
}
