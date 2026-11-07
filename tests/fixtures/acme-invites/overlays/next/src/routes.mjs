import { AppError } from './store.mjs';
import { signup, issueToken, sessionCookie, signInLink, useSignInLink } from './auth.mjs';
import { sendInvite, listInvites, resendInvite, revokeInvite, acceptInvite } from './invites.mjs';

let seq = 0;
const PLANS = ['free', 'pro'];
const plan = (p) => {
  if (!PLANS.includes(p)) throw new AppError(400, 'Plan must be free or pro.');
  return p;
};
const need = (v, msg) => {
  if (!v) throw new AppError(400, msg);
  return v;
};
const orgOf = (store, id) => store.orgs.get(id) ?? (() => { throw new AppError(404, 'Org not found.'); })();

// Each handler: ({ store, account, body, query, params, base }) -> { status?, json?, headers? }
// Returns null when no route matches.
export function apiRoute(method, path) {
  let m;
  if (method === 'GET' && path === '/api/health') return { open: true, run: () => ({ json: { ok: true } }) };
  if (method === 'POST' && path === '/api/signup') {
    return {
      open: true,
      run: ({ store, body }) => {
        const email = need(body.email, 'Enter a valid email address.');
        const r = signup(store, { email, password: need(body.password, 'Enter a password.') });
        return { status: 201, json: { key: r.account.key, org: r.org, token: r.token }, headers: { 'set-cookie': `acme_session=${r.token}; Path=/` } };
      },
    };
  }
  if (method === 'POST' && path === '/api/signin') {
    return {
      open: true,
      run: ({ store, body }) => {
        const a = [...store.accounts.values()].find((x) => x.email.toLowerCase() === String(body.email).toLowerCase());
        if (!a || a.password !== body.password) throw new AppError(401, 'Sign in first.');
        return { json: { ok: true }, headers: { 'set-cookie': sessionCookie(store, a.key) + '; Path=/' } };
      },
    };
  }
  if ((m = /^\/api\/accept\/([^/]+)$/.exec(path)) && method === 'POST') {
    return { open: true, run: ({ store }) => ({ json: acceptInvite(store, m[1]) }) };
  }
  if (path === '/api/invites') {
    if (method === 'POST') return { run: async ({ store, account, body }) => ({ status: 201, json: await sendInvite(store, account, body.email) }) };
    if (method === 'GET') return { run: ({ store, account, query }) => ({ json: listInvites(store, account, { status: query.status, org: query.org }) }) };
  }
  if ((m = /^\/api\/invites\/([^/]+)(\/resend)?$/.exec(path))) {
    if (method === 'POST' && m[2]) return { run: ({ store, account }) => ({ json: resendInvite(store, account, m[1]) }) };
    if (method === 'DELETE' && !m[2]) return { run: ({ store, account }) => ({ json: revokeInvite(store, account, m[1]) }) };
  }
  return null;
}

export function adminRoute(method, path) {
  if (method === 'GET' && path === '/mail') return ({ store }) => ({ json: [...store.mail].reverse() });
  if (method !== 'POST') return null;
  switch (path) {
    case '/admin/login':
      return ({ store, body, base }) => {
        const key = body.account;
        if (!store.accounts.has(key)) throw new AppError(404, 'Account not found.');
        return { json: { token: issueToken(store, key), cookie: sessionCookie(store, key), link: base + signInLink(store, key) } };
      };
    case '/admin/new-org':
      return ({ store, body, base }) => {
        const email = `qa+${Math.floor(Date.now() / 1000)}${String(seq++).padStart(3, '0')}@acme.test`;
        const password = 'Passw0rd!';
        const { account, org, token } = signup(store, { email, password });
        org.plan = plan(body.plan ?? 'free');
        return { json: { key: account.key, email, password, org: org.id, token, cookie: sessionCookie(store, account.key), link: base + signInLink(store, account.key) } };
      };
    case '/admin/set-plan':
      return ({ store, body }) => {
        const org = orgOf(store, body.org);
        org.plan = plan(body.plan);
        return { json: org };
      };
    case '/admin/seed-invites':
      return ({ store, body }) => {
        const org = orgOf(store, body.org);
        const owner = [...store.accounts.values()].find((a) => a.orgId === org.id && a.role === 'owner');
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 0) throw new AppError(400, 'count must be a whole number.');
        const start = store.invites.length;
        for (let i = 0; i < count; i++) {
          store.invites.push({
            id: `seed-${org.id}-${start + i}`, orgId: org.id, email: `seeded-${start + i + 1}@acme.test`,
            byKey: owner?.key ?? null, createdAt: store.now(), status: 'sent', code: `seed-code-${org.id}-${start + i}`,
          });
        }
        return { json: { created: count } };
      };
    case '/admin/reset':
      return ({ store }) => (store.reset(), { json: { ok: true } });
  }
  return null;
}

export { useSignInLink, AppError };
