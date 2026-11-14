import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.webp': 'image/webp',
};

http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Некорректный URL');
    return;
  }

  const relativePath = pathname.replace(/^\/+/, '');
  const target = path.resolve(root, relativePath || 'index.html');
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Доступ запрещён');
    return;
  }

  let file = target;
  if (!existsSync(file) || !statSync(file).isFile()) {
    // Missing built assets must return 404 rather than HTML with a JavaScript MIME type.
    if (path.extname(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Файл не найден');
      return;
    }
    file = path.join(root, 'index.html');
  }

  res.writeHead(200, {
    'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`VDGO React frontend listening on :${port}`));
