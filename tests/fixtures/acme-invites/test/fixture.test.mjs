import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import net from 'node:net';

const setup = join(dirname(fileURLToPath(import.meta.url)), '..', 'setup.sh');
const ORIGIN = 'https://example.test/acme/acme-invites.git';
const temps = [];
const servers = [];
const git = (repo, ...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'acme-fixture-'));
  temps.push(d);
  return d;
};

function runSetup() {
  const repo = join(tmp(), 'acme-invites');
  const r = spawnSync('bash', [setup, repo], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), repo);
  return repo;
}

async function build(branch) {
  const repo = runSetup();
  assert.equal(git(repo, 'checkout', '-q', branch).status, 0);
  const { startServer } = await import(pathToFileURL(join(repo, 'server.mjs')).href);
  const s = await startServer({ dir: repo, port: 0, adminPort: 0 });
  servers.push(s);
  const url = `http://localhost:${s.port}`;
  const admin = (path, body = {}) =>
    fetch(`http://localhost:${s.adminPort}${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  const call = async (method, path, token, body) => {
    const r = await fetch(url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  const invite = (token, email) => call('POST', '/api/invites', token, { email });
  const mail = () => fetch(`http://localhost:${s.adminPort}/mail`).then((r) => r.json());
  // async spawn: the server lives in this process, so the event loop must stay free
  const cliAt = (at, ...a) => new Promise((resolve) =>
    execFile(process.execPath, [join(repo, 'cli.mjs'), ...a], { env: { ...process.env, ACME_URL: at } }, (err, stdout, stderr) =>
      resolve({ status: err ? err.code : 0, stdout, stderr })));
  const cli = (...a) => cliAt(url, ...a);
  return { repo, url, admin, call, invite, mail, cli, cliAt };
}

const B = {};
before(async () => {
  B.main = await build('main');
  B.next = await build('next');
});
after(async () => {
  for (const s of servers) await s.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// Sends n invites from a new org's owner; returns the statuses.
async function sendMany(b, token, n, prefix = 'p') {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await b.invite(token, `${prefix}${i}@acme.test`)).status);
  return out;
}

test('setup builds main and next on one base', () => {
  const repo = B.main.repo;
  const log = (ref) => git(repo, 'log', '--format=%H %s', ref).stdout.trim().split('\n');
  const main = log('main');
  const next = log('next');
  assert.equal(main.length, 2);
  assert.equal(next.length, 2);
  assert.equal(main[1], next[1]);
  assert.match(main[1], / Invites: send, resend, revoke$/);
  assert.match(main[0], / Daily invite limit for Free orgs$/);
  assert.match(next[0], / Daily invite limit for Free orgs$/);
  assert.notEqual(main[0], next[0]);
  assert.deepEqual(git(repo, 'branch', '--format=%(refname:short)').stdout.trim().split('\n').sort(), ['main', 'next']);
  assert.equal(git(repo, 'remote', 'get-url', 'origin').stdout.trim(), ORIGIN);
  assert.equal(git(repo, 'status', '--porcelain').stdout, '');
  const env = readFileSync(join(repo, '..', 'environment.md'), 'utf8');
  assert.ok(env.includes(repo));
  assert.ok(!env.includes('<repo>'));
});

test('setup makes an empty CLI working folder outside the repo', () => {
  const repo = runSetup();
  const work = join(repo, '..', 'acme-work');
  assert.deepEqual(readdirSync(work), []);
  const env = readFileSync(join(repo, '..', 'environment.md'), 'utf8');
  assert.ok(env.includes(`- CLI: \`node ${repo}/cli.mjs\`, working folder: ${work} (`), env);
  assert.ok(!env.includes('<work>'));
});

test('setup checks out main and copies no request log', () => {
  const repo = runSetup();
  assert.equal(git(repo, 'branch', '--show-current').stdout.trim(), 'main');
  assert.ok(!readdirSync(repo).includes('.acme'));
});

test('setup refuses a non-empty folder', () => {
  const dir = join(tmp(), 'taken');
  mkdirSync(dir);
  writeFileSync(join(dir, 'keep.txt'), 'x');
  const r = spawnSync('bash', [setup, dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.deepEqual(readdirSync(dir), ['keep.txt']);
});

// Portable ERE: this Mac's git grep has no \\b.
const HINT = '(^|[^[:alnum:]])P[1-8]([^[:alnum:]]|$)|planted|bug';
const hints = (repo, ...refs) => git(repo, 'grep', '-niE', HINT, ...refs);

test('the hint grep matches a hint', () => {
  const repo = tmp();
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'x P5 y\nP15 and XP5 and P5x stay quiet\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t.test', 'commit', '-qm', 'one');
  assert.equal(hints(repo, 'HEAD').stdout, 'HEAD:a.txt:1:x P5 y\n');
});

test('no file names a planted bug', () => {
  const r = hints(B.main.repo, 'main', 'next');
  assert.equal(r.stdout, '');
  assert.equal(r.status, 1);
});

test('main: the limit refuses the 11th with the full text', async () => {
  const b = B.main;
  const o = await b.admin('/admin/new-org', { plan: 'free' });
  assert.deepEqual(await sendMany(b, o.token, 10), Array(10).fill(201));
  const r = await b.invite(o.token, 'eleven@acme.test');
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'Daily invite limit reached. Try again tomorrow.');
});

test('main: seeded invites count toward the limit and send no mail', async () => {
  const b = B.main;
  const o = await b.admin('/admin/new-org', { plan: 'free' });
  await b.admin('/admin/seed-invites', { org: o.org, count: 10 });
  const r = await b.invite(o.token, 'one-more@acme.test');
  assert.equal(r.status, 429);
  assert.ok(!(await b.mail()).some((m) => m.to.startsWith('seeded-')));
});

for (const branch of ['main', 'next']) {
  test(`${branch}: paid orgs have no limit`, async () => {
    const b = B[branch];
    const o = await b.admin('/admin/new-org', { plan: 'pro' });
    assert.deepEqual(await sendMany(b, o.token, 15), Array(15).fill(201));
  });

  test(`${branch}: malformed bodies get 400, not 500`, async () => {
    const b = B[branch];
    const o = await b.admin('/admin/new-org', { plan: 'free' });
    const raw = (path, body) => fetch(b.url + path, { method: 'POST', headers: { authorization: `Bearer ${o.token}` }, body })
      .then(async (r) => [r.status, (await r.json()).error]);
    for (const body of ['null', '[]', '5', '"x"']) {
      assert.deepEqual(await raw('/api/invites', body), [400, 'Send a JSON object.'], body);
      assert.deepEqual(await raw('/api/signup', body), [400, 'Send a JSON object.'], body);
    }
    for (const email of [['a@acme.test'], 5, { a: 1 }]) {
      const body = JSON.stringify({ email, password: 'Passw0rd!' });
      assert.deepEqual(await raw('/api/invites', body), [400, 'Enter a valid email address.'], body);
      assert.deepEqual(await raw('/api/signup', body), [400, 'Enter a valid email address.'], body);
    }
    assert.deepEqual(await raw('/api/signup', JSON.stringify({ email: 'not-an-email', password: 'x' })), [400, 'Enter a valid email address.']);
  });

  test(`${branch}: refused invites do not count`, async () => {
    const b = B[branch];
    const o = await b.admin('/admin/new-org', { plan: 'free' });
    const first = await b.invite(o.token, 'dup@acme.test');
    assert.equal(first.status, 201);
    for (const email of ['bad', 'also bad', 'dup@acme.test', 'DUP@acme.test', '']) {
      assert.ok([400, 409].includes((await b.invite(o.token, email)).status), email);
    }
    assert.deepEqual(await sendMany(b, o.token, 9), Array(9).fill(201));
  });
}

test('main: two quick sends of one address create one invite', async () => {
  const b = B.main;
  const o = await b.admin('/admin/new-org', { plan: 'free' });
  const rs = await Promise.all([b.invite(o.token, 'twice@acme.test'), b.invite(o.token, 'twice@acme.test')]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await b.call('GET', '/api/invites', o.token)).json.length, 1);
});

async function twoOrgs(b) {
  const a = await b.admin('/admin/new-org', { plan: 'free' });
  const other = await b.admin('/admin/new-org', { plan: 'free' });
  await b.invite(a.token, 'secret@acme.test');
  return (await b.call('GET', `/api/invites?org=${a.org}`, other.token)).json;
}

test("main: other org's invites stay hidden", async () => {
  assert.deepEqual(await twoOrgs(B.main), []);
});

async function acceptRevoked(b) {
  const o = await b.admin('/admin/new-org', { plan: 'free' });
  const email = `gone-${Date.now()}@acme.test`;
  const { json: inv } = await b.invite(o.token, email);
  const link = (await b.mail()).find((m) => m.to === email).links[0];
  assert.ok(link.startsWith(`${b.url}/accept/`), link);
  assert.equal((await b.call('DELETE', `/api/invites/${inv.id}`, o.token)).status, 200);
  return b.call('POST', `/api${new URL(link).pathname}`);
}

test('main: a revoked link is refused (410)', async () => {
  const r = await acceptRevoked(B.main);
  assert.equal(r.status, 410);
  assert.equal(r.json.error, 'This invite was revoked.');
});

test('main: CLI bad token exits 1', async () => {
  const r = await B.main.cli('invites', 'list', '--token', 'nope');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Sign in first\./);
});

test('next: P1 lets the 11th through', async () => {
  const b = B.next;
  const o = await b.admin('/admin/new-org', { plan: 'free' });
  assert.deepEqual(await sendMany(b, o.token, 11), Array(11).fill(201));
  assert.equal((await b.invite(o.token, 'twelve@acme.test')).status, 429);
});

test('next: P3 text lacks "Try again tomorrow."', async () => {
  const b = B.next;
  const o = await b.admin('/admin/new-org', { plan: 'free' });
  await b.admin('/admin/seed-invites', { org: o.org, count: 11 });
  const r = await b.invite(o.token, 'late@acme.test');
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'Daily invite limit reached.');
});

test('next: P2 two quick sends create two invites', async () => {
  const b = B.next;
  const o = await b.admin('/admin/new-org', { plan: 'free' });
  const rs = await Promise.all([b.invite(o.token, 'twice@acme.test'), b.invite(o.token, 'twice@acme.test')]);
  assert.deepEqual(rs.map((r) => r.status), [201, 201]);
  assert.equal((await b.call('GET', '/api/invites', o.token)).json.length, 2);
  // The web page no longer disables Send while a request is in flight.
  const js = readFileSync(join(b.repo, 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(js, /busy\(\$\('send'\)/);
  assert.match(readFileSync(join(B.main.repo, 'public', 'app.js'), 'utf8'), /busy\(\$\('send'\)/);
});

test('next: parallel sends at the limit still stop at 11', async () => {
  const b = B.next;
  const o = await b.admin('/admin/new-org', { plan: 'free' });
  await b.admin('/admin/seed-invites', { org: o.org, count: 10 });
  const rs = await Promise.all([b.invite(o.token, 'race-a@acme.test'), b.invite(o.token, 'race-b@acme.test')]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 429]);
  assert.equal((await b.call('GET', '/api/invites', o.token)).json.length, 11);
});

test('next: CLI with the server down still says Could not reach', async () => {
  const down = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, 'localhost', () => {
      const { port } = srv.address();
      srv.close(() => resolve(`http://localhost:${port}`));
    });
  });
  const r = await B.next.cliAt(down, 'invites', 'list', '--token', 'nope');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim(), `Could not reach ${down}.`);
});

test('next: P5 ?org= shows the other org', async () => {
  const list = await twoOrgs(B.next);
  assert.deepEqual(list.map((i) => i.email), ['secret@acme.test']);
});

test('next: P6 a revoked link is accepted', async () => {
  const r = await acceptRevoked(B.next);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'accepted');
});

test('next: P7 CLI bad token exits 0 with the error on stdout', async () => {
  const r = await B.next.cli('invites', 'list', '--token', 'nope');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Sign in first\./);
  assert.equal(r.stderr, '');
});

test('next: P4 and P8 are in the assets', () => {
  const read = (b, f) => readFileSync(join(B[b].repo, 'public', f), 'utf8');
  const narrow = /@media \(max-width: 399px\) \{[^@]*min-width: 420px/;
  assert.match(read('next', 'style.css'), narrow);
  assert.doesNotMatch(read('main', 'style.css'), /min-width: 420px/);
  const js = read('next', 'app.js');
  assert.match(js, /renderBadge\(/);
  assert.doesNotMatch(js, /function renderBadge|renderBadge\s*=/);
  assert.doesNotMatch(read('main', 'app.js'), /renderBadge/);
});
