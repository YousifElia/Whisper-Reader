/**
 * Build twice and prove the output is byte-identical.
 *
 * AMO reviewers rebuild a submitted source archive and compare it against the
 * uploaded package. If two builds of the same source disagree -- an embedded
 * timestamp, a hash of an absolute path, a non-deterministic chunk name -- the
 * review fails and the reason is rarely obvious. Cheaper to know first.
 *
 *   node scripts/check-reproducible.mjs [chrome|firefox]
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

const target = process.argv[2] === 'chrome' ? 'chrome' : 'firefox';
const outDir = join('.output', `${target}-mv3`);

function hashTree(dir, base = dir) {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, hashTree(full, base));
    } else {
      const key = relative(base, full).split('\\').join('/');
      out[key] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  }
  return out;
}

function build() {
  const args = ['wxt', 'build'];
  if (target === 'firefox') args.push('-b', 'firefox');
  execFileSync('npx', args, { stdio: 'ignore', shell: true });
}

console.log(`Building ${target} twice...`);
build();
const first = hashTree(outDir);
build();
const second = hashTree(outDir);

const names = new Set([...Object.keys(first), ...Object.keys(second)]);
const differing = [...names].filter((n) => first[n] !== second[n]);

for (const name of differing) {
  console.log(`  DIFFERS  ${name}`);
  console.log(`    build 1: ${first[name] ?? '(absent)'}`);
  console.log(`    build 2: ${second[name] ?? '(absent)'}`);
}

if (differing.length === 0) {
  console.log(`\nReproducible: all ${names.size} files identical across builds.`);
  process.exit(0);
}
console.log(`\n${differing.length} of ${names.size} files differ between builds.`);
process.exit(1);
