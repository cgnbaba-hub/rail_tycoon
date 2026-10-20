// Iron Baron: tiny static file server for the built game (no dependencies).
// Serves the release that BASE/current points to, re-resolved on every request so a new
// release goes live the moment the symlink moves. Listens on HOST:PORT (default
// 127.0.0.1:8085) — put a tunnel or reverse proxy in front of it.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const BASE = process.env.BASE || '/opt/iron-baron';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8085);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const root = await realpath(join(BASE, 'current'));
    let path = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) throw Object.assign(new Error('outside'), { code: 'ENOENT' });
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    // Hashed bundles never change; the page and the version file always revalidate.
    const immutable = path.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  } catch (e) {
    const missing = e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e instanceof URIError);
    res.writeHead(missing ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(missing ? 'Not found\n' : 'Server error\n');
    if (!missing) console.error(e);
  }
});

server.listen(PORT, HOST, () => console.log(`Iron Baron on http://${HOST}:${PORT} (serving ${BASE}/current)`));
