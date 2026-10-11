/**
 * The wire between the background, the toolbar popup, and the injected reader.
 *
 * Typed as a discriminated union so a message the reader does not handle is a
 * compile error rather than a silent no-op.
 */

import type { PlayerState, SkipUnit } from './player/controller';
import type { Voice } from './engines/types';

export type ReaderCommand =
  | { type: 'ping' }
  | { type: 'start'; from: 'top' | 'selection' }
  | { type: 'toggle' }
  | { type: 'stop' }
  | { type: 'skip'; direction: 1 | -1; unit: SkipUnit }
  | { type: 'boost'; on: boolean }
  | { type: 'setRate'; rate: number }
  | { type: 'setVoice'; voiceId: string }
  | { type: 'setWordHighlight'; on: boolean }
  | { type: 'getStatus' }
  | { type: 'close' };

export interface ReaderStatus {
  readonly present: true;
  readonly state: PlayerState;
  readonly voices: readonly Voice[];
}

/** What the popup gets back when nothing has been injected into the tab yet. */
export interface ReaderAbsent {
  readonly present: false;
}

export type ReaderResponse = ReaderStatus | ReaderAbsent;

export type BackgroundCommand =
  | { type: 'ensureReader' }
  | { type: 'forward'; command: ReaderCommand };

/** Marks messages as ours, so we ignore anything else on the channel. */
export const CHANNEL = 'whisper-reader';

export interface Envelope<T> {
  readonly channel: typeof CHANNEL;
  readonly payload: T;
}

export function wrap<T>(payload: T): Envelope<T> {
  return { channel: CHANNEL, payload };
}

export function unwrap<T>(message: unknown): T | null {
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as Envelope<T>).channel === CHANNEL
  ) {
    return (message as Envelope<T>).payload;
  }
  return null;
}
