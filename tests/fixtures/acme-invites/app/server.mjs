import http from 'node:http';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, AppError } from './src/store.mjs';
import { accountForToken, accountForCookie, useSignInLink, sessionCookie } from './src/auth.mjs';
import { apiRoute, adminRoute } from './src/routes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const PAGES = { '/signup': 'signup.html', '/signin': 'signin.html', '/team': 'team.html' };

const send = (res, status, json, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(json));
};

function sendFile(res, file) {
  try {
    const data = readFileSync(join(here, 'public', file));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found.' });
  }
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) raw += c;
  if (!raw) return {};
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'Request body must be JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Send a JSON object.');
  return body;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, 'localhost', () => resolve(server.address().port));
  });
}

export async function startServer({ dir, port = 4173, adminPort = 4174, store = createStore() }) {
  const logFile = join(dir, '.acme', 'requests.jsonl');
  mkdirSync(dirname(logFile), { recursive: true });
  let publicPort;

  const web = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    let account = null;
    res.on('finish', () => {
      appendFileSync(logFile, JSON.stringify({ at: store.now().toISOString(), account: account?.key ?? null, method: req.method, path, status: res.statusCode }) + '\n');
    });
    try {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      account = (bearer && accountForToken(store, bearer[1])) || accountForCookie(store, req.headers.cookie);
      let m;
      if (path.startsWith('/api/')) {
        const route = apiRoute(req.method, path);
        if (!route) return send(res, 404, { error: 'Not found.' });
        if (!route.open && !account) throw new AppError(401, 'Sign in first.');
        const body = req.method === 'POST' ? await readBody(req) : {};
        const r = await route.run({ store, account, body, query: Object.fromEntries(url.searchParams), base: '' });
        return send(res, r.status ?? 200, r.json, r.headers);
      }
      if (req.method !== 'GET') return send(res, 404, { error: 'Not found.' });
      if (path === '/team' && !account) {
        res.writeHead(302, { location: '/signin' });
        return res.end();
      }
      if (PAGES[path]) return sendFile(res, PAGES[path]);
      if (/^\/accept\/[^/]+$/.test(path)) return sendFile(res, 'accept.html');
      if ((m = /^\/signin\/link\/([^/]+)$/.exec(path))) {
        const a = useSignInLink(store, m[1]);
        if (!a) return send(res, 404, { error: 'Sign-in link not found.' });
        res.writeHead(302, { 'set-cookie': `${sessionCookie(store, a.key)}; Path=/`, location: '/team' });
        return res.end();
      }
      if (path.startsWith('/static/')) return sendFile(res, normalize(path.slice(8)).replace(/^(\.\.[/\\])+/, ''));
      send(res, 404, { error: 'Not found.' });
    } catch (e) {
      if (!(e instanceof AppError)) console.error(e);
      send(res, e.status ?? 500, { error: e.status ? e.message : 'Something went wrong.' });
    }
  });

  const adm = http.createServer(async (req, res) => {
    try {
      const handler = adminRoute(req.method, new URL(req.url, 'http://x').pathname);
      if (!handler) return send(res, 404, { error: 'Not found.' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const r = handler({ store, body, base: `http://localhost:${publicPort}` });
      send(res, r.status ?? 200, r.json);
    } catch (e) {
      send(res, e.status ?? 500, { error: e.status ? e.message : 'Something went wrong.' });
    }
  });

  publicPort = await listen(web, port);
  store.baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${publicPort}`;
  let adminBound;
  try {
    adminBound = await listen(adm, adminPort);
  } catch (e) {
    web.close();
    e.port = adminPort;
    throw e;
  }
  const close = () => new Promise((r) => {
    web.closeAllConnections?.();
    adm.closeAllConnections?.();
    web.close(() => adm.close(() => r()));
  });
  return { port: publicPort, adminPort: adminBound, store, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  const adminPort = Number(process.env.ADMIN_PORT ?? 4174);
  try {
    const s = await startServer({ dir: here, port, adminPort });
    console.log(`Acme fixture on http://localhost:${s.port} (admin on ${s.adminPort})`);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${e.port ?? port} is in use: stop the other fixture server first.`);
      process.exit(1);
    }
    throw e;
  }
}
