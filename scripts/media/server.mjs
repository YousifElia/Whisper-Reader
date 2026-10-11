/**
 * Static server for the media capture.
 *
 * Serves the repository root, so scripts/media/article.html and its bundle
 * load over http (module scripts and the Custom Highlight API behave the same
 * as on a real site). Extension pages are served from the built Chrome output
 * under /ext/ -- with one rewrite, because Vite emits their script tags as
 * absolute /chunks/... paths.
 *
 *   node scripts/media/server.mjs        (port 5410)
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EXTENSION = join(ROOT, '.output', 'chrome-mv3');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

function resolvePath(urlPath) {
  if (urlPath.startsWith('/chunks/') || urlPath.startsWith('/ext/')) {
    const rest = urlPath.replace(/^\/ext/, '');
    return { base: EXTENSION, file: normalize(join(EXTENSION, rest)) };
  }
  return { base: ROOT, file: normalize(join(ROOT, urlPath)) };
}

export function serve(port = 5410) {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const { base, file } = resolvePath(urlPath);
    // Resolve first, then refuse anything that escaped its root.
    if (!file.startsWith(base)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 5410);
  await serve(port);
  console.log(`media server on http://127.0.0.1:${port}/scripts/media/article.html`);
}
