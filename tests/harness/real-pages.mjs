/**
 * Run the extraction pipeline against real, published HTML and report how much
 * of each page it actually captured.
 *
 * The question this answers is "what did we miss, and which filter ate it" --
 * the thing that is pure guesswork otherwise. Coverage is the headline number;
 * the rejection table underneath says where the rest went.
 *
 *   node tests/harness/real-pages.mjs [url ...]
 *
 * Three caveats when reading the output:
 *
 * 1. jsdom does not run page scripts, so client-rendered sites look emptier
 *    here than in a browser.
 * 2. IGNORE THE PARSE TIME. jsdom's getComputedStyle dominates it. Measured on
 *    the same Wikipedia article: 15,800 ms here, 96 ms in Chrome.
 * 3. Coverage below 100% is not automatically a bug -- navigation, cookie
 *    banners and footers *should* be dropped. Read the reasons, not the score.
 */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let bundle;
try {
  bundle = readFileSync(join(here, 'dist', 'probe.js'), 'utf8');
} catch {
  console.error(
    'Missing probe bundle. Build it first:\n' +
      '  npx vite build -c tests/harness/vite.config.ts',
  );
  process.exit(1);
}

const DEFAULT_URLS = [
  'https://en.wikipedia.org/wiki/Coffee',
  'https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis',
  'https://blog.rust-lang.org/2024/09/05/Rust-1.81.0.html',
  'https://www.gutenberg.org/cache/epub/1342/pg1342-images.html',
  'https://news.ycombinator.com/item?id=1',
  'https://example.com/',
];

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_URLS;

const truncate = (s, n = 68) => {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}...` : clean;
};

async function run(url) {
  process.stdout.write(`\n${'='.repeat(74)}\n${url}\n${'='.repeat(74)}\n`);

  let html;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 WhisperReaderHarness/0.1' },
      redirect: 'follow',
    });
    if (!response.ok) {
      console.log(`  fetch failed: HTTP ${response.status}`);
      return null;
    }
    html = await response.text();
  } catch (error) {
    console.log(`  fetch failed: ${error.message}`);
    return null;
  }

  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  let report;
  try {
    dom.window.eval(bundle);
    report = dom.window.__calmProbe();
  } catch (error) {
    console.log(`  probe failed: ${error.message}`);
    dom.window.close();
    return null;
  }

  const bar = (pct) => {
    const filled = Math.round(Math.min(pct, 100) / 5);
    return `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}]`;
  };

  console.log(`  title       ${truncate(report.title, 58)}`);
  console.log(
    `  root        ${report.rootSelector}` +
      `  (${report.outsideRootChars} chars outside it, not read by design)`,
  );
  console.log(
    `  coverage    ${bar(report.coveragePercent)} ${report.coveragePercent}%` +
      `  (${report.collectedChars} of ${report.pageChars} chars)`,
  );
  console.log(
    `  structure   ${report.blocks} blocks, ${report.sentences} sentences` +
      `, ${report.unresolved} unresolved`,
  );

  if (report.rejections.length > 0) {
    console.log('\n  dropped by filter:');
    for (const r of report.rejections) {
      const pct = ((100 * r.chars) / Math.max(report.pageChars, 1)).toFixed(1);
      console.log(
        `    ${r.reason.padEnd(20)} ${String(r.chars).padStart(7)} chars ` +
          `(${pct.padStart(5)}%)  ${truncate(r.sample, 44)}`,
      );
    }
  }
  if (report.unaccountedChars > 0) {
    const pct = (
      (100 * report.unaccountedChars) / Math.max(report.pageChars, 1)
    ).toFixed(1);
    console.log(
      `\n  UNACCOUNTED  ${report.unaccountedChars} chars (${pct}%) ` +
        '-- passed the filters but never reached a block',
    );
  }

  console.log('\n  first sentences:');
  for (const s of report.firstSentences) console.log(`    - ${truncate(s)}`);

  dom.window.close();
  return report;
}

const results = [];
for (const url of targets) results.push(await run(url));

const ok = results.filter(Boolean);
console.log(`\n${'='.repeat(74)}`);
for (const r of ok) {
  console.log(
    `${String(r.coveragePercent).padStart(6)}%  ${truncate(r.title, 60)}`,
  );
}
const broken = ok.filter((r) => r.unresolved > 0);
console.log(
  `\n${ok.length}/${targets.length} fetched, ${broken.length} with unresolved ranges`,
);
process.exit(broken.length > 0 ? 1 : 0);
