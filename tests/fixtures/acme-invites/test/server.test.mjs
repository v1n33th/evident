import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { startServer } from '../app/server.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const dirs = [];
const servers = [];
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'acme-'));
  dirs.push(dir);
  const s = await startServer({ dir, port: 0, adminPort: 0 });
  servers.push(s);
  s.url = `http://localhost:${s.port}`;
  s.admin = (path, body = {}) =>
    fetch(`http://localhost:${s.adminPort}${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  s.dir = dir;
  return s;
}
after(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const auth = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const post = (token, body) => ({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('health answers', async () => {
  const s = await boot();
  const r = await fetch(`${s.url}/api/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('api needs sign-in', async () => {
  const s = await boot();
  const r = await fetch(`${s.url}/api/invites`);
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'Sign in first.' });
});

test('admin login gives a token, a cookie and a one-use link', async () => {
  const s = await boot();
  const { token, cookie, link } = await s.admin('/admin/login', { account: 'free-owner' });
  assert.equal((await fetch(`${s.url}/api/invites`, auth(token))).status, 200);
  assert.equal((await fetch(`${s.url}/api/invites`, { headers: { cookie } })).status, 200);
  const r = await fetch(link, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('set-cookie'), /^acme_session=/);
  assert.equal(r.headers.get('location'), '/team');
  assert.equal((await fetch(link, { redirect: 'manual' })).status, 404);
});

test('new-org gives a fresh Free owner', async () => {
  const s = await boot();
  const a = await s.admin('/admin/new-org', { plan: 'free' });
  const b = await s.admin('/admin/new-org', { plan: 'free' });
  assert.match(a.email, /^qa\+\d+@acme\.test$/);
  assert.notEqual(a.email, b.email);
  const r = await fetch(`${s.url}/api/invites`, post(a.token, { email: 'x@acme.test' }));
  assert.equal(r.status, 201);
});

test('seed-invites creates invites and no mail', async () => {
  const s = await boot();
  await s.admin('/admin/seed-invites', { org: 'qa-free', count: 3 });
  const { token } = await s.admin('/admin/login', { account: 'free-owner' });
  const list = await (await fetch(`${s.url}/api/invites`, auth(token))).json();
  assert.equal(list.length, 3);
  assert.match(list[0].email, /^seeded-\d+@acme\.test$/);
  assert.deepEqual(await (await fetch(`http://localhost:${s.adminPort}/mail`)).json(), []);
});

test('requests are logged per account', async () => {
  const s = await boot();
  const { token } = await s.admin('/admin/login', { account: 'free-owner' });
  await fetch(`${s.url}/api/invites`, auth(token));
  const lines = readFileSync(join(s.dir, '.acme', 'requests.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.account, 'free-owner');
  assert.equal(last.status, 200);
  assert.equal(last.method, 'GET');
});

test('accept endpoint accepts once and refuses a revoked invite', async () => {
  const s = await boot();
  const { token } = await s.admin('/admin/login', { account: 'free-owner' });
  const mk = async (email) => (await fetch(`${s.url}/api/invites`, post(token, { email }))).json();
  const a = await mk('a@acme.test');
  const ok = await fetch(`${s.url}/api/accept/${a.code}`, { method: 'POST' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, 'accepted');
  const b = await mk('b@acme.test');
  await fetch(`${s.url}/api/invites/${b.id}`, { method: 'DELETE', ...auth(token) });
  const gone = await fetch(`${s.url}/api/accept/${b.code}`, { method: 'POST' });
  assert.equal(gone.status, 410);
  assert.deepEqual(await gone.json(), { error: 'This invite was revoked.' });
});

test('server refuses a busy port with a plain message', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, 'localhost', r));
  const port = blocker.address().port;
  const r = spawnSync('node', ['server.mjs'], { cwd: app, env: { ...process.env, PORT: String(port), ADMIN_PORT: '0' }, encoding: 'utf8' });
  blocker.close();
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('is in use: stop the other fixture server first.'));
  assert.ok(!/^\s+at /m.test(r.stderr));
});

test('admin script reports a stopped server', () => {
  const r = spawnSync('node', ['admin/login.mjs', 'free-owner'], { cwd: app, env: { ...process.env, ADMIN_URL: 'http://localhost:9' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.startsWith('Fixture server not running at'));
});

test('pages are served', async () => {
  const s = await boot();
  const { cookie } = await s.admin('/admin/login', { account: 'free-owner' });
  for (const p of ['/signup', '/signin', '/team', '/accept/x']) {
    const r = await fetch(s.url + p, { headers: { cookie } });
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /^text\/html/);
  }
  const team = await fetch(s.url + '/team', { headers: { cookie } }).then((r) => r.text());
  assert.match(team, /id="send"/);
  assert.match(team, /id="invite-list"/);
});

test('static assets are served', async () => {
  const s = await boot();
  const js = await fetch(s.url + '/static/app.js');
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  const css = await fetch(s.url + '/static/style.css');
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.match(await css.text(), /@media \(max-width: 599px\)/);
});

test('signin checks the password and sets the cookie', async () => {
  const s = await boot();
  const o = await s.admin('/admin/new-org', { plan: 'free' });
  const go = (password) => fetch(`${s.url}/api/signin`, { method: 'POST', body: JSON.stringify({ email: o.email, password }) });
  const bad = await go('nope');
  assert.equal(bad.status, 401);
  assert.deepEqual(await bad.json(), { error: 'Sign in first.' });
  const ok = await go(o.password);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /^acme_session=/);
});

test('seeded owner signs in by email and password', async () => {
  const s = await boot();
  const r = await fetch(`${s.url}/api/signin`, { method: 'POST', body: JSON.stringify({ email: 'free-owner@acme.test', password: 'Passw0rd!' }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^acme_session=/);
  const list = await fetch(`${s.url}/api/invites`, { headers: { cookie } });
  assert.equal(list.status, 200);
});

test('team page sends a signed-out visitor to sign in', async () => {
  const s = await boot();
  const r = await fetch(s.url + '/team', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin');
  const { cookie } = await s.admin('/admin/login', { account: 'free-owner' });
  assert.equal((await fetch(s.url + '/team', { headers: { cookie }, redirect: 'manual' })).status, 200);
});

test('invite links point at the running server', async () => {
  const s = await boot();
  const { token } = await s.admin('/admin/login', { account: 'free-owner' });
  const inv = await (await fetch(`${s.url}/api/invites`, post(token, { email: 'link@acme.test' }))).json();
  const [mail] = await (await fetch(`http://localhost:${s.adminPort}/mail`)).json();
  assert.deepEqual(mail.links, [`${s.url}/accept/${inv.code}`]);
});

test('team page shows the toast above the list', async () => {
  const s = await boot();
  const { cookie } = await s.admin('/admin/login', { account: 'free-owner' });
  const team = await fetch(s.url + '/team', { headers: { cookie } }).then((r) => r.text());
  assert.ok(team.indexOf('id="toast"') < team.indexOf('id="invite-list"'));
});
