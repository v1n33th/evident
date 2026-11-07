import { randomUUID } from 'node:crypto';
import { AppError, isEmail } from './store.mjs';

export function issueToken(store, key) {
  const token = randomUUID();
  store.sessions.set(token, key);
  return token;
}

export function accountForToken(store, token) {
  return store.accounts.get(store.sessions.get(token)) ?? null;
}

export function sessionCookie(store, key) {
  return `acme_session=${issueToken(store, key)}`;
}

export function accountForCookie(store, cookieHeader = '') {
  const m = /(?:^|;\s*)acme_session=([^;]+)/.exec(cookieHeader);
  return m ? accountForToken(store, m[1]) : null;
}

export function signInLink(store, key) {
  const code = randomUUID();
  store.links.set(code, key);
  return `/signin/link/${code}`;
}

export function useSignInLink(store, code) {
  const key = store.links.get(code);
  store.links.delete(code);
  return store.accounts.get(key) ?? null;
}

export function signup(store, { email, password }) {
  if (!isEmail(email)) throw new AppError(400, 'Enter a valid email address.');
  const key = email;
  if (store.accounts.has(key)) throw new AppError(409, 'That email is already registered.');
  const org = { id: `org-${randomUUID()}`, name: `QA ${email.split('@')[0]}`, plan: 'free' };
  const account = { key, email, password, orgId: org.id, role: 'owner' };
  store.orgs.set(org.id, org);
  store.accounts.set(key, account);
  return { account, org, token: issueToken(store, key) };
}
