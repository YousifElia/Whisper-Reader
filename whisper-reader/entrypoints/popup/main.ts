/**
 * The toolbar popup is a launcher, not the player.
 *
 * It cannot be the player: a browser action popup closes the moment it loses
 * focus and cannot be resized by the user. Its job is to start a read, expose
 * the two or three controls worth having without leaving the keyboard, and
 * hand off to the in-page panel for everything else.
 */
import { browser } from 'wxt/browser';
import { loadSettings } from '../../lib/settings';
import {
  unwrap,
  wrap,
  type BackgroundCommand,
  type ReaderCommand,
  type ReaderResponse,
} from '../../lib/messaging';

const app = document.getElementById('app')!;

async function ask(command: BackgroundCommand): Promise<ReaderResponse> {
  try {
    const reply = await browser.runtime.sendMessage(wrap(command));
    return unwrap<ReaderResponse>(reply) ?? { present: false };
  } catch {
    return { present: false };
  }
}

const forward = (command: ReaderCommand) => ask({ type: 'forward', command });

function render(status: ReaderResponse): void {
  app.replaceChildren();

  if (!status.present) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent =
      'Whisper Reader cannot run on this page. Try an article or a normal web page.';
    app.append(note, setupLink());
    return;
  }

  const { state } = status;
  const speaking = state.status === 'speaking';
  const empty = state.totalSentences === 0;

  const primary = document.createElement('button');
  primary.className = 'primary';
  primary.disabled = empty;
  primary.textContent = empty
    ? 'No readable text found'
    : speaking
      ? 'Pause'
      : 'Read this page';
  primary.addEventListener('click', async () => {
    render(await forward(speaking ? { type: 'toggle' } : { type: 'start', from: 'top' }));
  });

  const row = document.createElement('div');
  row.className = 'row';
  for (const [label, command] of [
    ['Back', { type: 'skip', direction: -1, unit: 'sentence' }],
    ['Forward', { type: 'skip', direction: 1, unit: 'sentence' }],
    ['Stop', { type: 'stop' }],
  ] as const) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', async () => {
      render(await forward(command as ReaderCommand));
    });
    row.appendChild(button);
  }

  const meta = document.createElement('p');
  meta.className = 'note';
  // "Cannot run here" and "ran fine but found nothing" are different problems
  // and need different advice, so they get different messages.
  meta.textContent = empty
    ? 'Select any text on the page and it will be read aloud from there.'
    : state.voiceName
      ? `${state.voiceName} - ${state.effectiveRate.toFixed(1)}x`
      : 'Loading voices...';

  const hint = document.createElement('p');
  hint.className = 'note';
  hint.textContent =
    'The full player, with drag-to-resize and compact mode, opens on the page itself.';

  app.append(primary, row, meta, hint, setupLink());
}

/** Setup is not a one-shot: voices come and go as the user installs them, and
 *  the speed question is worth revisiting. */
function setupLink(): HTMLElement {
  const link = document.createElement('button');
  link.className = 'link';
  link.textContent = 'Choose voice and speed';
  link.addEventListener('click', () => {
    void browser.tabs.create({ url: browser.runtime.getURL('/welcome.html') });
    window.close();
  });
  return link;
}

void (async () => {
  // Apply the stored appearance before the first paint so the popup does not
  // flash the wrong theme on open. 'system' leaves the attribute off, which
  // hands the decision to prefers-color-scheme in the stylesheet.
  try {
    const { theme } = await loadSettings();
    if (theme && theme !== 'system') {
      document.documentElement.dataset.theme = theme;
    }
  } catch {
    // Defaults are fine; never block the popup on a preference read.
  }

  render(await ask({ type: 'ensureReader' }));
})();
