// Prototype server: static files, byte-range media and dictionary lookup.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { createLookup } from './server/lookup.mjs';

const root = new URL('.', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 8090);
const yomitanDir = process.env.YOMITAN_DIR ?? join(homedir(), 'src/ref/yomitan');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
};

const lookup = await createLookup({ yomitanDir, dictsDir: join(root, 'dicts') });
console.log(`dictionaries: ${lookup.dictionaries.map((d) => d.title).join(', ')}`);

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);

  if (path === '/api/dictionaries') return json(res, 200, lookup.dictionaries);
  if (path === '/api/lookup') {
    const text = (url.searchParams.get('text') ?? '').slice(0, 64);
    if (!text) return json(res, 400, { error: 'text required' });
    try {
      return json(res, 200, await lookup.lookup(text));
    } catch (e) {
      console.error('lookup failed', e);
      return json(res, 500, { error: String(e) });
    }
  }

  // Yomitan's browser modules (structured-content rendering) are served as-is.
  const [base, rel] = path.startsWith('/yomitan/')
    ? [join(yomitanDir, 'ext'), path.slice('/yomitan'.length)]
    : [root, path === '/' ? '/index.html' : path];
  if (normalize(rel).includes('..')) return res.writeHead(400).end();
  serveFile(req, res, join(base, normalize(rel)));
}).listen(port, '0.0.0.0', () => console.log(`http://0.0.0.0:${port}`));

function serveFile(req, res, file) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return res.writeHead(404).end('not found');
  }
  const headers = {
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!m) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    return createReadStream(file).pipe(res);
  }
  const start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  const end = Math.min(m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1, size - 1);
  if (start > end || start < 0) {
    return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
  }
  res.writeHead(206, {
    ...headers,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  createReadStream(file, { start, end }).pipe(res);
}
