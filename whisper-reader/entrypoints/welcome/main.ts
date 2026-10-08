/**
 * First-run setup.
 *
 * Three questions, asked once, on a full page rather than in the popup --
 * because the only way to choose a voice is to hear it, and a popup closes the
 * moment focus moves. Every answer has a working default already selected, so
 * "Skip setup" is a real option and not a trap.
 *
 * It also earns its keep invisibly: while the first question is on screen we
 * silently measure how many distinct speeds this browser's speech engine can
 * actually produce, so the speed control on the last step offers real settings
 * instead of a slider that mostly does nothing. See lib/player/rate.ts.
 */

import { webSpeechEngine } from '../../lib/engines/webspeech';
import { probeRateQuantization } from '../../lib/engines/rate-probe';
import { voiceAdvice } from '../../lib/engines/voice-advice';
import type { SpeakHandle, Voice } from '../../lib/engines/types';
import { formatRate, ladderFor, ladderIndex } from '../../lib/player/rate';
import { matchPreset } from '../../lib/player/presets';
import {
  DEFAULT_SETTINGS,
  loadRateQuantization,
  loadSettings,
  markOnboarded,
  saveRateQuantization,
  saveSettings,
  type Settings,
} from '../../lib/settings';

const SAMPLE =
  'The tide went out slowly, and the harbour settled into its evening quiet.';

const stepHost = document.getElementById('step')!;
const dotsHost = document.getElementById('dots')!;
const skipButton = document.getElementById('skip') as HTMLButtonElement;

const TOTAL_STEPS = 3;

interface Draft {
  step: number;
  lang: string;
  voiceId: string | null;
  rate: number;
}

let settings: Settings = { ...DEFAULT_SETTINGS };
let voices: readonly Voice[] = [];
let quantized = false;
let sample: SpeakHandle | null = null;

const draft: Draft = {
  step: 1,
  lang: '',
  voiceId: null,
  rate: DEFAULT_SETTINGS.rate,
};

// ------------------------------------------------------------------ helpers

function stopSample(): void {
  sample?.stop();
  sample = null;
}

function speak(voice: Voice | null, rate: number): void {
  stopSample();
  sample = webSpeechEngine.speak(
    {
      text: SAMPLE,
      voice,
      rate,
      pitch: settings.pitch,
      volume: settings.volume,
      lang: voice?.lang ?? 'en-US',
    },
    {
      onEnd: () => {
        sample = null;
      },
    },
  );
}

/** "en-US" to "American English", falling back to the raw tag. Intl throws on
 *  malformed tags, and voice lang strings are not always well formed. */
function languageLabel(tag: string): string {
  try {
    const names = new Intl.DisplayNames([navigator.language], {
      type: 'language',
    });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

interface LanguageGroup {
  tag: string;
  label: string;
  voices: Voice[];
  best: number;
}

function baseTag(tag: string): string {
  return tag.toLowerCase().split('-')[0] ?? 'en';
}

function groupByLanguage(all: readonly Voice[]): LanguageGroup[] {
  const groups = new Map<string, LanguageGroup>();
  for (const voice of all) {
    const tag = voice.lang || 'und';
    let group = groups.get(tag);
    if (!group) {
      group = { tag, label: languageLabel(tag), voices: [], best: -1 };
      groups.set(tag, group);
    }
    group.voices.push(voice);
    group.best = Math.max(group.best, voice.calmScore);
  }

  // The language the browser is already in first, then anything sharing its
  // base language, then whichever has the best voice behind it.
  const preferred = navigator.language.toLowerCase();
  const base = baseTag(preferred);
  const rank = (group: LanguageGroup): number => {
    if (group.tag.toLowerCase() === preferred) return 0;
    if (baseTag(group.tag) === base) return 1;
    return 2;
  };

  return [...groups.values()].sort(
    (a, b) => rank(a) - rank(b) || b.best - a.best || a.label.localeCompare(b.label),
  );
}

function voicesFor(tag: string): Voice[] {
  return voices
    .filter((v) => v.lang === tag)
    .sort((a, b) => b.calmScore - a.calmScore || a.name.localeCompare(b.name));
}

function currentVoice(): Voice | null {
  return voices.find((v) => v.id === draft.voiceId) ?? null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A selectable card. Used for both languages and voices so the two questions
 * feel like one flow rather than two different widgets.
 */
function choice(
  name: string,
  meta: string,
  selected: boolean,
  onPick: () => void,
  onSample?: () => void,
): HTMLElement {
  const button = el('button', 'choice');
  button.type = 'button';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(selected));
  button.addEventListener('click', onPick);

  const body = el('div', 'body');
  body.append(el('div', 'name', name), el('div', 'meta', meta));
  button.appendChild(body);

  if (onSample) {
    const play = el('span', 'sample', 'Play');
    play.setAttribute('role', 'button');
    play.tabIndex = 0;
    // The row itself selects; the Play chip must not also re-select, or
    // keyboard users cannot preview a voice without choosing it.
    const fire = (event: Event) => {
      event.stopPropagation();
      onSample();
    };
    play.addEventListener('click', fire);
    play.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') fire(event);
    });
    button.appendChild(play);
  }

  return button;
}

function footer(
  primaryLabel: string,
  onPrimary: () => void,
  onBack?: () => void,
): HTMLElement {
  const row = el('div', 'actions');
  const primary = el('button', 'primary', primaryLabel);
  primary.type = 'button';
  primary.addEventListener('click', onPrimary);
  row.append(primary, el('div', 'spacer'));
  if (onBack) {
    const back = el('button', 'quiet', 'Back');
    back.type = 'button';
    back.addEventListener('click', onBack);
    row.appendChild(back);
  }
  return row;
}

function go(step: number): void {
  stopSample();
  draft.step = step;
  render();
}

// -------------------------------------------------------------------- steps

function renderDots(): void {
  dotsHost.replaceChildren();
  if (draft.step > TOTAL_STEPS) return;
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    dotsHost.appendChild(el('div', i <= draft.step ? 'dot on' : 'dot'));
  }
}

function renderNoVoices(): void {
  stepHost.append(
    el('h2', undefined, 'No voices are installed'),
    el(
      'p',
      'sub',
      'Whisper Reader speaks with the voices your operating system provides, and ' +
        'this browser is not reporting any. Installing one and reopening this ' +
        'page is all it takes.',
    ),
    footer('Close', () => window.close()),
  );
}

function renderLanguage(): void {
  stepHost.append(
    el('h2', undefined, 'Which accent should read to you?'),
    el('p', 'sub', 'Taken from the voices installed on this computer.'),
  );

  const list = el('div', 'choices');
  list.setAttribute('role', 'radiogroup');
  for (const group of groupByLanguage(voices)) {
    const count = group.voices.length;
    list.appendChild(
      choice(
        group.label,
        count === 1 ? '1 voice' : count + ' voices',
        group.tag === draft.lang,
        () => {
          draft.lang = group.tag;
          // The old voice belongs to the old accent, so re-pick the calmest in
          // the new one rather than leaving a mismatched selection behind.
          draft.voiceId = voicesFor(group.tag)[0]?.id ?? null;
          render();
        },
      ),
    );
  }

  stepHost.append(list, footer('Continue', () => go(2)));
}

function renderVoice(): void {
  const options = voicesFor(draft.lang);

  stepHost.append(
    el('h2', undefined, 'Which voice?'),
    el(
      'p',
      'sub',
      'Calmest first. Play a few - they differ more than the names suggest.',
    ),
  );

  const list = el('div', 'choices');
  list.setAttribute('role', 'radiogroup');
  for (const voice of options) {
    const notes: string[] = [];
    // Not 'no word highlighting': the player still highlights each word for
    // these voices, on estimated timing, and says so. The label must agree.
    if (voice.wordTimings === 'none') notes.push('word timing estimated');
    if (!voice.localService) notes.push('needs internet');

    list.appendChild(
      choice(
        voice.name,
        notes.join(' - ') || 'Highlights each word as it reads',
        voice.id === draft.voiceId,
        () => {
          draft.voiceId = voice.id;
          render();
          speak(voice, draft.rate);
        },
        () => speak(voice, draft.rate),
      ),
    );
  }

  stepHost.appendChild(list);

  // After the list, not before it. The advice tells the user to pick a better
  // voice "in the list above", and leading a question with a nag about the
  // machine's voices is the wrong first thing to read.
  const advice = voiceAdvice(options);
  if (advice) {
    const box = el('div', 'advice');
    box.appendChild(el('p', undefined, advice.headline));
    const steps = el('ol');
    for (const line of advice.steps) steps.appendChild(el('li', undefined, line));
    box.appendChild(steps);
    stepHost.appendChild(box);
  }

  stepHost.append(
    footer(
      'Continue',
      () => go(3),
      () => go(1),
    ),
  );
}

function renderSpeed(): void {
  const ladder = ladderFor(quantized);

  stepHost.append(
    el('h2', undefined, 'How fast do you like to listen?'),
    el('p', 'sub', 'You can change this any time from the player.'),
  );

  const card = el('div', 'speed');
  const readout = el('div', 'readout');
  const big = el('div', 'big', formatRate(draft.rate));
  const hear = el('button', 'sample', 'Hear it');
  hear.type = 'button';
  hear.addEventListener('click', () => speak(currentVoice(), draft.rate));
  readout.append(big, hear);

  const slider = el('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(ladder.length - 1);
  slider.step = '1';
  slider.value = String(ladderIndex(draft.rate, ladder));
  slider.setAttribute('aria-label', 'Listening speed');
  slider.setAttribute('aria-valuetext', formatRate(draft.rate));
  slider.addEventListener('input', () => {
    draft.rate = ladder[Number(slider.value)] ?? 1;
    big.textContent = formatRate(draft.rate);
    slider.setAttribute('aria-valuetext', formatRate(draft.rate));
  });
  // Preview on release rather than on every step of the drag, which would
  // restart the sample a dozen times across a single gesture.
  slider.addEventListener('change', () => speak(currentVoice(), draft.rate));

  const scale = el('div', 'scale');
  scale.append(el('span', undefined, 'Slower'), el('span', undefined, 'Faster'));

  card.append(readout, slider, scale);
  stepHost.appendChild(card);

  if (quantized) {
    const slowest = formatRate(ladder[0] ?? 0.5);
    const fastest = formatRate(ladder[ladder.length - 1] ?? 2);
    stepHost.appendChild(
      el(
        'p',
        'note',
        'This browser has ' +
          ladder.length +
          ' real speeds between ' +
          slowest +
          ' and ' +
          fastest +
          ', so the slider steps between them. Anything in between would ' +
          'sound identical to one of these.',
      ),
    );
  }

  stepHost.append(
    footer(
      'Finish',
      () => void finish(),
      () => go(2),
    ),
  );
}

function renderDone(): void {
  stepHost.append(
    el('h2', undefined, 'You are set.'),
    el('p', 'sub', 'Three ways to start reading a page:'),
  );

  const list = el('ul', 'start');

  const toolbar = el('li');
  toolbar.append(
    el('strong', undefined, 'Click the Whisper Reader icon'),
    document.createTextNode(' in the toolbar.'),
  );

  const hotkey = el('li');
  hotkey.append(
    document.createTextNode('Press '),
    el('kbd', undefined, 'Alt+Shift+R'),
    document.createTextNode(' anywhere.'),
  );

  const menu = el('li');
  menu.append(
    el('strong', undefined, 'Right-click'),
    document.createTextNode(
      ' the page, or a passage you have selected, and choose Read aloud.',
    ),
  );

  list.append(toolbar, hotkey, menu);

  stepHost.append(
    list,
    el(
      'p',
      'note',
      'The player appears on the page itself, where you can drag it, resize ' +
        'it, and switch to compact mode. Double-click any word to start ' +
        'reading from there.',
    ),
    footer('Close', () => window.close()),
  );
}

function render(): void {
  stepHost.replaceChildren();
  renderDots();
  skipButton.style.display = draft.step > TOTAL_STEPS ? 'none' : '';

  if (voices.length === 0) {
    renderNoVoices();
    return;
  }
  if (draft.step === 1) renderLanguage();
  else if (draft.step === 2) renderVoice();
  else if (draft.step === 3) renderSpeed();
  else renderDone();
}

// ------------------------------------------------------------------- saving

async function finish(): Promise<void> {
  stopSample();
  await saveSettings({
    voiceId: draft.voiceId,
    rate: draft.rate,
    // Keep the pacing preset label truthful: if the chosen speed no longer
    // matches the preset's, it is a custom setting and should say so.
    preset: matchPreset({
      rate: draft.rate,
      sentencePauseMs: settings.sentencePauseMs,
    }),
  });
  await markOnboarded();
  go(TOTAL_STEPS + 1);
}

skipButton.addEventListener('click', () => {
  stopSample();
  void markOnboarded();
  window.close();
});

// -------------------------------------------------------------------- start

void (async () => {
  settings = await loadSettings();
  draft.rate = settings.rate;
  if (settings.theme && settings.theme !== 'system') {
    document.documentElement.dataset.theme = settings.theme;
  }

  voices = await webSpeechEngine.listVoices();

  // Start from what is already configured, so re-running setup shows the
  // current choices rather than resetting them.
  const saved = voices.find((v) => v.id === settings.voiceId);
  const preferred = navigator.language.toLowerCase();
  const fallback =
    voices.find((v) => v.lang.toLowerCase() === preferred) ??
    voices.find((v) => baseTag(v.lang) === baseTag(preferred)) ??
    voices[0];
  const start = saved ?? fallback;
  draft.lang = start?.lang ?? '';
  draft.voiceId = start?.id ?? null;

  render();

  // Measure the engine's real speeds behind the first question. Four silent
  // seconds, finished long before anyone reaches step three. The guard keeps
  // the probe from cancelling a voice sample the user is listening to.
  const cached = await loadRateQuantization();
  if (cached !== null) {
    quantized = cached;
  } else {
    const probe = await probeRateQuantization(null, () => sample === null);
    if (probe) {
      quantized = probe.quantized;
      void saveRateQuantization(quantized);
    }
  }
  if (draft.step === 3) render();
})();
