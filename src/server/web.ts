import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { skeletonizeTypeScript } from '../skeleton/typescript';
import { skeletonizePython } from '../skeleton/python';

const PORT = process.env.PORT || 3000;
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Healthcheck endpoint
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'siftrcode', version: '0.1.0' }));
    return;
  }

  // Live AST Skeleton API
  if (pathname === '/api/skeleton' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { // 5MB limit
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const code = payload.code || '';
        const lang = (payload.language || 'typescript').toLowerCase();
        const filename = payload.filename || (lang === 'python' ? 'app.py' : 'app.ts');

        let result;
        if (lang === 'python' || filename.endsWith('.py')) {
          result = skeletonizePython(code, filename);
        } else {
          result = skeletonizeTypeScript(code, filename);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Invalid request' }));
      }
    });
    return;
  }

  // Serve static files from web/
  let filePath = path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
  
  // Security check: prevent directory traversal
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Fallback to index.html for SPA routing
  const fallbackPath = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(fallbackPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(fallbackPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`🌐 [SiftrCode Web Server] Running on http://localhost:${PORT}`);
});
