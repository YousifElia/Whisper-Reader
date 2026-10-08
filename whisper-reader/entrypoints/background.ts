/**
 * Coordinator only. It never speaks: speechSynthesis is a window API and does
 * not exist in an MV3 service worker, so all audio lives in the injected
 * reader. This file's job is to get that reader into the right tab and to
 * route commands to it.
 */

import { browser } from 'wxt/browser';
import {
  unwrap,
  wrap,
  type BackgroundCommand,
  type ReaderCommand,
  type ReaderResponse,
} from '../lib/messaging';

const READER_FILE = '/reader.js';
const WELCOME_PAGE = '/welcome.html';

async function activeTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function send(
  tabId: number,
  command: ReaderCommand,
): Promise<ReaderResponse | null> {
  try {
    const reply = await browser.tabs.sendMessage(tabId, wrap(command));
    return unwrap<ReaderResponse>(reply);
  } catch {
    // No listener in that tab yet, or the tab is a page we cannot touch.
    return null;
  }
}

/**
 * Inject the reader if it is not already there.
 *
 * The activeTab grant that makes this legal arrives when the user clicks the
 * toolbar icon or presses a command hotkey, so this must only ever be called
 * on those paths -- never speculatively.
 */
async function ensureReader(tabId: number): Promise<boolean> {
  if (await send(tabId, { type: 'ping' })) return true;

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [READER_FILE],
    });
    return true;
  } catch {
    // Browser-internal pages, the extension stores, PDFs and the like.
    return false;
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender) => {
    const command = unwrap<BackgroundCommand>(message);
    if (!command) return undefined;

    return (async () => {
      const tabId = sender.tab?.id ?? (await activeTabId());
      if (tabId === null) return wrap<ReaderResponse>({ present: false });

      if (command.type === 'ensureReader') {
        const ok = await ensureReader(tabId);
        if (!ok) return wrap<ReaderResponse>({ present: false });
        return wrap(
          (await send(tabId, { type: 'getStatus' })) ?? { present: false },
        );
      }

      const reply = await send(tabId, command.command);
      return wrap<ReaderResponse>(reply ?? { present: false });
    })();
  });

  browser.commands.onCommand.addListener(async (name) => {
    const tabId = await activeTabId();
    if (tabId === null) return;
    if (!(await ensureReader(tabId))) return;

    if (name === 'toggle-play') {
      await send(tabId, { type: 'toggle' });
    } else if (name === 'read-selection') {
      await send(tabId, { type: 'start', from: 'selection' });
    }
  });

  browser.runtime.onInstalled.addListener((details) => {
    // Only on a genuine first install. Reopening this on every update would
    // be a tab the user did not ask for, and setup is reachable from the
    // popup whenever they want it again.
    if (details.reason === 'install') {
      void browser.tabs.create({ url: browser.runtime.getURL(WELCOME_PAGE) });
    }

    browser.contextMenus.create({
      id: 'read-selection',
      title: 'Read selection aloud',
      contexts: ['selection'],
    });
    browser.contextMenus.create({
      id: 'read-page',
      title: 'Read this page aloud',
      contexts: ['page'],
    });
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    const tabId = tab?.id;
    if (tabId === undefined) return;
    if (!(await ensureReader(tabId))) return;

    await send(tabId, {
      type: 'start',
      from: info.menuItemId === 'read-selection' ? 'selection' : 'top',
    });
  });
});
