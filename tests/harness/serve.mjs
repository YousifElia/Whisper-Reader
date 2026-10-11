/**
 * Plain static file server for the harness.
 *
 * Not vite dev: vite's dev server tries to transform ORT's `.mjs` glue when
 * ONNX Runtime dynamically imports it with an `?import` query, and returns a
 * 500. The extension serves these files straight out of its package with no
 * transform step, so a dumb static server is the faithful environment.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 5399);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
};

createServer((req, res) => {
  // Strip the query -- ORT appends ?import when it dynamically loads its glue.
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = normalize(join(root, path));

  // Containment check rather than a traversal regex: resolve first, then
  // refuse anything that escaped the harness directory.
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  try {
    const { size } = statSync(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': 'no-cache',
      // Lets a real site pull the built reader in for debugging, so the exact
      // shipped bundle can be exercised on a live page without pasting it.
      'access-control-allow-origin': '*',
      // Cross-origin isolation, which is what unlocks SharedArrayBuffer and
      // therefore multi-threaded WASM. An MV3 extension gets the same thing
      // from the cross_origin_embedder_policy / cross_origin_opener_policy
      // manifest keys, so this mirrors what the extension can actually have.
      // 'credentialless' rather than 'require-corp' so the cross-origin model
      // download from Hugging Face is not blocked.
      'cross-origin-embedder-policy': 'credentialless',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'cross-origin',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => {
  console.log(`harness on http://localhost:${port}`);
});
