const ORGS = [
  { id: 'qa-free', name: 'QA Free', plan: 'free' },
  { id: 'qa-pro', name: 'QA Pro', plan: 'pro' },
];
const ACCOUNTS = [
  ['free-owner', 'qa-free', 'owner'],
  ['free-member', 'qa-free', 'member'],
  ['pro-owner', 'qa-pro', 'owner'],
  ['pro-member', 'qa-pro', 'member'],
];

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (email) => typeof email === 'string' && EMAIL.test(email);

export function createStore({ now = () => new Date() } = {}) {
  const store = {
    now,
    baseUrl: 'http://localhost:4173', // links in emails start with this; the server sets its own
    orgs: new Map(),
    accounts: new Map(),
    invites: [],
    mail: [],
    sessions: new Map(), // token or cookie value -> account key
    links: new Map(), // sign-in code -> account key
    reset() {
      store.orgs.clear();
      store.accounts.clear();
      store.sessions.clear();
      store.links.clear();
      store.invites.length = 0;
      store.mail.length = 0;
      for (const o of ORGS) store.orgs.set(o.id, { ...o });
      for (const [key, orgId, role] of ACCOUNTS) {
        store.accounts.set(key, { key, email: `${key}@acme.test`, password: 'Passw0rd!', orgId, role });
      }
    },
  };
  store.reset();
  return store;
}
