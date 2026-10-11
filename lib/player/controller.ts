/**
 * The transport. Owns the cursor, drives the engine one sentence at a time,
 * and decides what is highlighted.
 *
 * Speaking sentence by sentence rather than handing the engine a whole article
 * is the decision everything else rests on: it makes skip and rewind exact,
 * it lets us insert real pauses between sentences (which is most of what makes
 * a voice sound calm), and it keeps every utterance short enough to dodge
 * Chrome's long-utterance bug.
 */

import {
  blockBoundary,
  type Block,
  type ReaderDocument,
  type SentenceRef,
} from '../extract/collector';
import { segmentWords, wordIndexAt, type Span } from '../extract/segment';
import type {
  SpeakHandle,
  TTSEngine,
  Voice,
  WordTimingSupport,
} from '../engines/types';
import {
  EstimatedWordClock,
  NULL_WORD_CLOCK,
  SpeechRateEstimator,
  type WordClock,
} from './boundary';
import { actualRate, BOOST_MULTIPLIER, MAX_RATE, MIN_RATE } from './rate';

export type PlayerStatus =
  | 'idle'
  | 'speaking'
  | 'paused'
  | 'ended'
  | 'error';

export type SkipUnit = 'sentence' | 'paragraph';

export interface PlayerSettings {
  rate: number;
  pitch: number;
  volume: number;
  wordHighlight: boolean;
  /**
   * Whether this browser's speech engine quantizes rate into discrete steps.
   * Probed once and cached; see lib/engines/rate-probe.ts.
   */
  rateQuantized: boolean;
  /** Silence between sentences. Does more for perceived calm than timbre. */
  sentencePauseMs: number;
  paragraphPauseMs: number;
  headingPauseMs: number;
}

export const DEFAULT_SETTINGS: PlayerSettings = {
  rate: 0.79,
  pitch: 0.98,
  volume: 1,
  wordHighlight: true,
  rateQuantized: false,
  sentencePauseMs: 260,
  paragraphPauseMs: 520,
  headingPauseMs: 640,
};

export interface PlayerState {
  readonly status: PlayerStatus;
  readonly sentenceIndex: number;
  readonly totalSentences: number;
  readonly blockId: number;
  readonly progress: number;
  readonly rate: number;
  readonly effectiveRate: number;
  readonly boosted: boolean;
  readonly voiceId: string | null;
  readonly voiceName: string | null;
  readonly wordTimings: WordTimingSupport;
  readonly error: string | null;
  /**
   * Milliseconds of reading left, or null before we can say.
   *
   * Uses the same rate estimator that drives word timing, so it calibrates
   * against how fast this particular voice actually speaks rather than a
   * guess -- and gets more accurate the longer you listen.
   */
  readonly remainingMs: number | null;
}

export interface Highlighter {
  show(sentence: Range | null, word: Range | null): void;
  clear(): void;
}

export interface ControllerHooks {
  onState?(state: PlayerState): void;
  /** Fired when the active sentence moves, so the host can scroll to it. */
  onSentenceChange?(range: Range | null): void;
  /** Fired once per voice when we learn whether it reports word boundaries,
   *  so the caller can cache the verdict and label the voice honestly. */
  onVoiceCapability?(voiceId: string, support: WordTimingSupport): void;
}

/**
 * The rate limits live in ./rate, next to the measurements that justify them,
 * because "why is 2.0 the ceiling" and "why is 1.9 the same speed as 1.6" are
 * the same question. Re-exported here: the controller is what the UI imports
 * the transport's limits from.
 */
export { BOOST_MULTIPLIER, MAX_RATE, MIN_RATE } from './rate';

/**
 * Inter-sentence pauses shrink as the rate rises, but not proportionally.
 * Requesting 2.0 only yields about 1.45x real speedup, so dividing gaps by the
 * requested rate clips them far too short and the reading loses its rhythm
 * exactly where it most needs one.
 */
function pauseDivisorFor(rate: number): number {
  return 1 + (rate - 1) * 0.55;
}

/** Press Back after this long and you get the current sentence again rather
 *  than the previous one -- the behaviour every music player has trained
 *  people to expect. */
const RESTART_WINDOW_MS = 2000;

/** How long to wait before deciding Chrome dropped an utterance on resume. */
const RESUME_VERIFY_MS = 350;

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

export class PlayerController {
  private model: ReaderDocument | null = null;
  private cursor = 0;
  private handle: SpeakHandle | null = null;
  private clock: WordClock = NULL_WORD_CLOCK;
  private status: PlayerStatus = 'idle';
  private boosted = false;
  private voice: Voice | null = null;
  private error: string | null = null;

  private words: readonly Span[] = [];
  private wordIndex = 0;
  /** Character offset into the sentence that the current utterance began at.
   *  Non-zero after a mid-sentence restart, and boundary charIndex is relative
   *  to it, so every incoming index must be shifted by this. */
  private utteranceOffset = 0;
  private boundaryCount = 0;
  /** Where a cancel-based pause left off, for resume to pick up from. */
  private resumeWordIndex = 0;
  /** Pause landed in the silence between sentences, so resume must advance. */
  private pausedBetweenSentences = false;
  /** Suffix sums of sentence lengths, so time-left is O(1) per emit. */
  private charsRemaining: number[] = [0];
  private sentenceRange: Range | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly estimator = new SpeechRateEstimator();

  /**
   * Bumped on every transport action. Engine callbacks capture the value at
   * dispatch and drop themselves if it has moved on. Without this, a cancelled
   * utterance's late onEnd advances the cursor and the highlight jumps a
   * sentence ahead of the audio.
   */
  private generation = 0;

  constructor(
    private engine: TTSEngine,
    private readonly highlighter: Highlighter,
    private readonly hooks: ControllerHooks = {},
    private settings: PlayerSettings = { ...DEFAULT_SETTINGS },
  ) {}

  // ---------------------------------------------------------------- loading

  load(model: ReaderDocument): void {
    this.hardStop();
    this.model = model;
    this.cursor = 0;
    this.status = 'idle';
    this.error = null;

    // Characters still to be spoken from each sentence onwards, precomputed.
    // getState() runs on every word boundary, so this cannot be an O(n) sum
    // each time -- on a long article that is thousands of adds per second.
    const counts = model.sentences.map((ref) => {
      const block = model.blocks[ref.blockId];
      return block ? ref.span.end - ref.span.start : 0;
    });
    this.charsRemaining = new Array<number>(counts.length + 1);
    this.charsRemaining[counts.length] = 0;
    for (let i = counts.length - 1; i >= 0; i--) {
      this.charsRemaining[i] = this.charsRemaining[i + 1]! + counts[i]!;
    }

    this.emit();
  }

  get document(): ReaderDocument | null {
    return this.model;
  }

  get sentenceIndex(): number {
    return this.cursor;
  }

  // -------------------------------------------------------------- transport

  play(fromIndex?: number): void {
    if (!this.model || this.model.sentences.length === 0) return;

    if (fromIndex !== undefined) {
      this.cursor = clamp(fromIndex, 0, this.model.sentences.length - 1);
    } else if (this.status === 'ended') {
      this.cursor = 0;
    }

    if (this.status === 'paused') {
      this.resume();
      return;
    }

    this.speakFrom(0);
  }

  toggle(): void {
    if (this.status === 'speaking') this.pause();
    else this.play();
  }

  pause(): void {
    if (this.status !== 'speaking') return;
    this.clearPauseTimer();
    this.clock.stop();

    if (this.engine.capabilities.reliablePause) {
      this.handle?.pause();
      this.setStatus('paused');
      return;
    }

    // Web Speech's pause() acknowledges immediately and then keeps talking, so
    // pressing pause appears to do nothing for a second. Cancelling stops the
    // audio at once; `resumeWordIndex` is where we pick the sentence back up.
    //
    // Pausing in the silence *between* sentences is the awkward case: the
    // utterance has finished but the cursor has not advanced yet, so resuming
    // from it would replay the sentence just heard. Remember to step forward
    // instead.
    this.generation++;
    this.pausedBetweenSentences = this.handle === null || this.handle.done;
    this.resumeWordIndex = this.pausedBetweenSentences ? 0 : this.wordIndex;
    this.handle?.stop();
    this.handle = null;
    this.setStatus('paused');
  }

  resume(): void {
    if (this.status !== 'paused') return;

    if (!this.engine.capabilities.reliablePause) {
      // Paused in the gap: the sentence we were on is already finished, so
      // carry on with the next one rather than repeating it.
      if (this.pausedBetweenSentences && this.model) {
        this.pausedBetweenSentences = false;
        if (this.cursor + 1 >= this.model.sentences.length) {
          this.finish();
          return;
        }
        this.cursor += 1;
      }
      // Resuming a word early is far less jarring than resuming late, so we
      // re-speak from the start of the word that was in progress.
      this.speakFrom(this.resumeWordIndex);
      // Report speaking straight away rather than waiting for onStart. The
      // engine takes about 35 ms to actually begin, and in that window the
      // button would still read "paused" and toggle() would pause nothing.
      this.setStatus('speaking');
      return;
    }

    if (!this.handle) return;
    this.handle.resume();
    this.setStatus('speaking');

    // Chrome's resume() can return having quietly discarded the utterance.
    // Rather than trusting it, check whether audio actually restarted and
    // re-speak from the current word if it did not.
    const generation = this.generation;
    const resumeAt = this.wordIndex;
    setTimeout(() => {
      if (generation !== this.generation || this.status !== 'speaking') return;
      if (!this.handle?.speaking && !this.handle?.done) {
        this.speakFrom(resumeAt);
      }
    }, RESUME_VERIFY_MS);
  }

  stop(): void {
    this.hardStop();
    this.cursor = 0;
    this.setStatus('idle');
  }

  /**
   * Move by sentence or by paragraph.
   *
   * Back within the first couple of seconds means "previous"; after that it
   * means "say that again", which is almost always what someone who missed a
   * line actually wants.
   */
  skip(direction: 1 | -1, unit: SkipUnit = 'sentence'): void {
    if (!this.model || this.model.sentences.length === 0) return;
    this.clearPauseTimer();

    let target: number;
    if (unit === 'paragraph') {
      target = blockBoundary(this.model, this.cursor, direction);
    } else if (
      direction === -1 &&
      this.handle !== null &&
      this.handle.elapsedMs > RESTART_WINDOW_MS
    ) {
      target = this.cursor;
    } else {
      target = this.cursor + direction;
    }

    this.jumpTo(target);
  }

  /**
   * Where in the reading does a given DOM position fall?
   *
   * Backs "double-click a word to start there". Returns null when the position
   * is not part of anything we read -- navigation, a hidden element, or the
   * whitespace between blocks.
   */
  locate(
    node: Text,
    nodeOffset: number,
  ): { sentenceIndex: number; wordIndex: number } | null {
    if (!this.model) return null;

    const block = this.model.blocks.find((b) => b.element.contains(node));
    if (!block) return null;

    const spoken = block.map.spokenIndexAt(node, nodeOffset);
    if (spoken === null) return null;

    // A click can land in the gap between two sentences, so snap forward to
    // the first sentence that has not already ended.
    let indexInBlock = block.sentences.findIndex((s) => s.end > spoken);
    if (indexInBlock < 0) indexInBlock = block.sentences.length - 1;
    const span = block.sentences[indexInBlock];
    if (!span) return null;

    const sentenceIndex = this.model.sentences.findIndex(
      (s) => s.blockId === block.id && s.indexInBlock === indexInBlock,
    );
    if (sentenceIndex < 0) return null;

    const sentenceText = block.text.slice(span.start, span.end);
    const words = segmentWords(sentenceText, block.lang);
    const wordIndex = wordIndexAt(
      words,
      Math.max(0, spoken - span.start),
    );

    return { sentenceIndex, wordIndex };
  }

  /** Begin at a specific word inside a specific sentence. */
  playFrom(sentenceIndex: number, wordIndex = 0): void {
    if (!this.model || this.model.sentences.length === 0) return;
    this.cursor = clamp(sentenceIndex, 0, this.model.sentences.length - 1);
    this.speakFrom(wordIndex);
    // speakFrom leaves the status to onStart; report immediately so the play
    // button flips the moment the user clicks.
    this.setStatus('speaking');
  }

  jumpTo(index: number): void {
    if (!this.model || this.model.sentences.length === 0) return;
    this.pausedBetweenSentences = false;

    const wasIdle = this.status === 'idle' || this.status === 'ended';
    this.cursor = clamp(index, 0, this.model.sentences.length - 1);

    if (wasIdle) {
      // Move the highlight without starting playback, so clicking a paragraph
      // to set the start point does not immediately begin reading.
      this.showSentenceOnly();
      this.emit();
      return;
    }
    this.speakFrom(0);
  }

  // -------------------------------------------------------------- modifiers

  setRate(rate: number): void {
    this.settings.rate = clamp(rate, MIN_RATE, MAX_RATE);
    this.applyRate();
  }

  /** Hold-to-boost. Seamless on engines backed by real audio; on Web Speech
   *  it restarts the sentence from the current word, which is audible but
   *  keeps the position exact. */
  setBoost(on: boolean): void {
    if (this.boosted === on) return;
    this.boosted = on;
    this.applyRate();
  }

  setVoice(voice: Voice | null): void {
    this.voice = voice;
    if (this.status === 'speaking') this.speakFrom(this.wordIndex);
    else this.emit();
  }

  setEngine(engine: TTSEngine): void {
    const wasSpeaking = this.status === 'speaking';
    this.hardStop();
    this.engine = engine;
    if (wasSpeaking) this.speakFrom(0);
    else this.emit();
  }

  updateSettings(patch: Partial<PlayerSettings>): void {
    const rateChanged = patch.rate !== undefined && patch.rate !== this.settings.rate;
    this.settings = { ...this.settings, ...patch };
    if (patch.wordHighlight === false) {
      this.clock.stop();
      this.highlighter.show(this.sentenceRange, null);
    }
    if (rateChanged) this.applyRate();
    else this.emit();
  }

  get effectiveRate(): number {
    const requested = Math.min(
      this.settings.rate * (this.boosted ? BOOST_MULTIPLIER : 1),
      MAX_RATE,
    );
    // On a staircase engine, asking for 1.9 and asking for 1.585 produce
    // identical audio. Reporting what the engine will really do keeps the
    // speed label, the time-left estimate and the pause scaling honest, and
    // stops the slider from pretending to move when it cannot.
    return this.settings.rateQuantized ? actualRate(requested) : requested;
  }

  private applyRate(): void {
    if (this.status !== 'speaking' || !this.handle) {
      this.emit();
      return;
    }
    if (this.handle.setRate(this.effectiveRate)) {
      this.emit();
      return;
    }
    this.speakFrom(this.wordIndex);
  }

  // ------------------------------------------------------------------ speak

  private current(): { ref: SentenceRef; block: Block } | null {
    const ref = this.model?.sentences[this.cursor];
    if (!ref || !this.model) return null;
    const block = this.model.blocks[ref.blockId];
    return block ? { ref, block } : null;
  }

  private speakFrom(wordIndex: number): void {
    const generation = ++this.generation;
    this.clearPauseTimer();
    this.clock.stop();
    this.clock = NULL_WORD_CLOCK;
    this.handle?.stop();
    this.handle = null;

    const currentSentence = this.current();
    if (!currentSentence) {
      this.finish();
      return;
    }
    const { ref, block } = currentSentence;

    const sentenceText = block.text.slice(ref.span.start, ref.span.end);
    this.words = segmentWords(sentenceText, block.lang);
    this.wordIndex = clamp(wordIndex, 0, Math.max(0, this.words.length - 1));

    const startWord = this.words[this.wordIndex];
    this.utteranceOffset = wordIndex > 0 && startWord ? startWord.start : 0;
    const text = sentenceText.slice(this.utteranceOffset);
    if (text.trim().length === 0) {
      this.afterSentence();
      return;
    }

    this.boundaryCount = 0;
    // The sentence highlight is applied in onStart rather than here, so it
    // lands when audio actually begins instead of when we asked for it.
    this.resolveSentenceRange();

    const rate = this.effectiveRate;
    const startedAt = performance.now();
    const voiceId = this.voice?.id ?? null;

    this.handle = this.engine.speak(
      {
        text,
        voice: this.voice,
        rate,
        pitch: this.settings.pitch,
        volume: this.settings.volume,
        lang: block.lang,
      },
      {
        onStart: () => {
          if (generation !== this.generation) return;
          this.setStatus('speaking');
          this.highlighter.show(this.sentenceRange, null);
          this.hooks.onSentenceChange?.(this.sentenceRange);
          this.startEstimatedClockIfNeeded(text.length, rate);
        },

        onWord: (charIndex) => {
          if (generation !== this.generation) return;
          this.boundaryCount++;
          // Boundary indices are relative to the text we handed the engine,
          // which may start mid-sentence after a rate change or resume.
          this.showWord(
            wordIndexAt(this.words, this.utteranceOffset + charIndex),
          );
        },

        onEnd: () => {
          if (generation !== this.generation) return;
          this.estimator.observe(
            text.length,
            performance.now() - startedAt,
            rate,
          );
          if (voiceId) this.reportTimingSupport(voiceId, text.length);
          this.afterSentence();
        },

        onError: (error) => {
          if (generation !== this.generation) return;
          if (error.kind === 'interrupted') return;
          this.error = error.message;
          this.clock.stop();
          this.setStatus('error');
        },
      },
    );
  }

  /** Only for voices that genuinely report nothing. A voice we have not
   *  probed yet gets the benefit of the doubt for one sentence. */
  private startEstimatedClockIfNeeded(textLength: number, rate: number): void {
    if (!this.settings.wordHighlight) return;
    if (this.voice?.wordTimings !== 'none') return;

    const remaining = this.words.slice(this.wordIndex);
    if (remaining.length === 0) return;

    const base = this.wordIndex;
    this.clock = new EstimatedWordClock(
      remaining,
      this.estimator.estimateMs(textLength, rate),
      (i) => this.showWord(base + i),
    );
  }

  private reportTimingSupport(voiceId: string, textLength: number): void {
    if (!this.hooks.onVoiceCapability) return;
    if (this.boundaryCount > 0) {
      this.hooks.onVoiceCapability(voiceId, 'native');
    } else if (textLength >= 40) {
      // Long enough that silence is conclusive.
      this.hooks.onVoiceCapability(voiceId, 'none');
    }
  }

  private afterSentence(): void {
    if (!this.model) return;
    const next = this.cursor + 1;
    if (next >= this.model.sentences.length) {
      this.finish();
      return;
    }

    const generation = this.generation;
    this.pauseTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.cursor = next;
      this.speakFrom(0);
    }, this.pauseBefore(next));
  }

  /** Longer silence at paragraph and heading boundaries. Scaled against rate
   *  so a 2x listener is not sitting through 2x-feeling gaps. */
  private pauseBefore(nextIndex: number): number {
    if (!this.model) return 0;
    const from = this.model.sentences[this.cursor];
    const to = this.model.sentences[nextIndex];
    if (!from || !to) return 0;

    let ms = this.settings.sentencePauseMs;
    if (from.blockId !== to.blockId) {
      const nextBlock = this.model.blocks[to.blockId];
      ms =
        nextBlock?.kind === 'heading'
          ? this.settings.headingPauseMs
          : this.settings.paragraphPauseMs;
    }
    return Math.round(ms / pauseDivisorFor(this.effectiveRate));
  }

  // -------------------------------------------------------------- highlight

  /** Compute the current sentence's Range without painting it. */
  private resolveSentenceRange(): void {
    const currentSentence = this.current();
    if (!currentSentence) return;
    const { ref, block } = currentSentence;
    this.sentenceRange = block.map.rangeFor(ref.span.start, ref.span.end);
    this.emit();
  }

  /** Compute *and* paint it, for the cursor-only moves that never speak. */
  private showSentenceOnly(): void {
    this.resolveSentenceRange();
    this.highlighter.show(this.sentenceRange, null);
    this.hooks.onSentenceChange?.(this.sentenceRange);
  }

  private showWord(index: number): void {
    if (!this.settings.wordHighlight) return;
    const word = this.words[index];
    const currentSentence = this.current();
    if (!word || !currentSentence) return;

    this.wordIndex = index;
    const { ref, block } = currentSentence;
    const wordRange = block.map.rangeFor(
      ref.span.start + word.start,
      ref.span.start + word.end,
    );
    this.highlighter.show(this.sentenceRange, wordRange);
  }

  // ------------------------------------------------------------------ state

  private hardStop(): void {
    this.generation++;
    this.pausedBetweenSentences = false;
    this.clearPauseTimer();
    this.clock.stop();
    this.clock = NULL_WORD_CLOCK;
    this.handle?.stop();
    this.handle = null;
    this.sentenceRange = null;
    this.highlighter.clear();
  }

  private finish(): void {
    this.hardStop();
    this.setStatus('ended');
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer !== null) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
  }

  private setStatus(status: PlayerStatus): void {
    if (this.status === status) return;
    this.status = status;
    if (status !== 'error') this.error = null;
    this.emit();
  }

  getState(): PlayerState {
    const total = this.model?.sentences.length ?? 0;
    return {
      status: this.status,
      sentenceIndex: this.cursor,
      totalSentences: total,
      blockId: this.model?.sentences[this.cursor]?.blockId ?? -1,
      progress: total > 0 ? (this.cursor + 1) / total : 0,
      rate: this.settings.rate,
      effectiveRate: this.effectiveRate,
      boosted: this.boosted,
      voiceId: this.voice?.id ?? null,
      voiceName: this.voice?.name ?? null,
      wordTimings: this.voice?.wordTimings ?? 'unknown',
      error: this.error,
      remainingMs: this.estimateRemainingMs(),
    };
  }

  /**
   * How much reading is left, including the silences between sentences.
   *
   * Null once finished, and null while idle on an empty document -- a "0 min
   * left" on a page that never started reads as a bug.
   */
  private estimateRemainingMs(): number | null {
    if (!this.model || this.model.sentences.length === 0) return null;
    if (this.status === 'ended') return 0;

    const chars = this.charsRemaining[this.cursor] ?? 0;
    if (chars === 0) return 0;

    const speech = this.estimator.estimateMs(chars, this.effectiveRate);
    const gaps =
      (this.model.sentences.length - this.cursor) *
      (this.settings.sentencePauseMs / pauseDivisorFor(this.effectiveRate));

    return Math.round(speech + gaps);
  }

  private emit(): void {
    this.hooks.onState?.(this.getState());
  }

  destroy(): void {
    this.hardStop();
    this.model = null;
  }
}
