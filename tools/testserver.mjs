// Static server for dist/site with a load-event latch:
//   GET /hang  -> response held open until /done is called
//   GET /done  -> releases all held /hang responses
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = new URL('../dist/site', import.meta.url).pathname;
const held = [];
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/hang') { held.push(res); return; }
  if (url === '/done') {
    for (const h of held.splice(0)) { h.writeHead(200, {'content-type':'image/gif'}); h.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')); }
    res.writeHead(204); res.end(); return;
  }
  const p = join(root, url === '/' ? 'index.html' : url);
  if (!existsSync(p)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(8932, () => console.log('testserver on 8932'));
