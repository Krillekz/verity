'use strict';

/**
 * Serves docs/ over HTTP the way GitHub Pages will, so the site can be looked at
 * before it is published — and so the generated files are exercised over a real
 * origin (which is what the page does in production) instead of file://.
 *
 * Usage: node tools/serve-site.js [--port=4173]
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.split('=')[1] : process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

if (!fs.existsSync(DOCS)) {
  console.error('docs/ does not exist yet — run: node tools/build-site.js');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const full = path.join(DOCS, rel);
  // Never serve outside docs/, whatever the request claims.
  if (!path.resolve(full).startsWith(path.resolve(DOCS))) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(full, (error, body) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not found: ${rel}`);
      console.log(`  404  ${rel}`);
      return;
    }
    const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(body);
    console.log(`  200  ${rel}  (${type.split(';')[0]}, ${(body.length / 1024).toFixed(1)} KiB)`);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Verity site: http://127.0.0.1:${PORT}/  (serving docs/, Ctrl-C to stop)`);
});
