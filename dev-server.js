// Servidor só para uso local (sem dependências). Na Vercel, /api/*.js viram funções e /public é estático.
const http = require('http');
const fs = require('fs');
const path = require('path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* sem .env */ }

const routes = {
  '/api/config': require('./api/config'),
  '/api/ai': require('./api/ai'),
  '/api/fal': require('./api/fal'),
};
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const MAX_BODY = 5 * 1024 * 1024; // próximo do limite da Vercel (4,5 MB)

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Corpo muito grande'), { status: 413 })); req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// imita req.body / res.status().json() da Vercel
function vercelRes(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (d) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(d)); };
  return res;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[url.pathname];
  if (handler) {
    try {
      const raw = req.method === 'GET' ? '' : await readBody(req);
      req.body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return vercelRes(res).status(e.status || 400).json({ error: e.message });
    }
    return handler(req, vercelRes(res));
  }
  const file = path.join(PUBLIC, path.normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Não encontrado'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(Number(process.env.PORT) || 3333, '127.0.0.1', function () {
  console.log(`\n  Meus vídeos rodando em http://localhost:${this.address().port}\n`);
});
