import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../app/src/store.mjs';
import { signup, accountForToken, useSignInLink, signInLink } from '../app/src/auth.mjs';
import { sendInvite, listInvites, revokeInvite, acceptInvite } from '../app/src/invites.mjs';

const fail = (status, message) => (e) => e.status === status && e.message === message;

test('seed has two orgs and four accounts', () => {
  const s = createStore();
  assert.equal(s.orgs.size, 2);
  assert.equal(s.accounts.size, 4);
  assert.equal(s.orgs.get('qa-free').plan, 'free');
  assert.equal(s.accounts.get('free-member').role, 'member');
});

test('owner sends an invite and it is mailed', () => {
  const s = createStore();
  sendInvite(s, s.accounts.get('free-owner'), 'a@acme.test');
  assert.equal(s.invites.length, 1);
  assert.equal(s.invites[0].status, 'sent');
  assert.equal(s.mail.length, 1);
  assert.equal(s.mail[0].to, 'a@acme.test');
  assert.match(s.mail[0].links[0], /^http:\/\/localhost:4173\/accept\/[\w-]+$/);
  assert.ok(s.mail[0].body.includes(s.mail[0].links[0]));
});

test('refusals throw the exact texts', () => {
  const s = createStore();
  assert.throws(() => sendInvite(s, s.accounts.get('free-member'), 'a@acme.test'),
    fail(403, 'You do not have permission to invite people.'));
  const owner = s.accounts.get('free-owner');
  assert.throws(() => sendInvite(s, owner, 'not-an-email'), fail(400, 'Enter a valid email address.'));
  sendInvite(s, owner, 'a@acme.test');
  assert.throws(() => sendInvite(s, owner, 'a@acme.test'), fail(409, 'This person is already invited.'));
});

test('base has no daily limit', () => {
  const s = createStore();
  const owner = s.accounts.get('free-owner');
  for (let i = 0; i < 25; i++) sendInvite(s, owner, `p${i}@acme.test`);
  assert.equal(s.invites.length, 25);
});

test("listInvites returns only the caller's org", () => {
  const s = createStore();
  sendInvite(s, s.accounts.get('free-owner'), 'a@acme.test');
  sendInvite(s, s.accounts.get('pro-owner'), 'b@acme.test');
  const list = listInvites(s, s.accounts.get('free-owner'), { org: 'qa-pro' });
  assert.deepEqual(list.map((i) => i.email), ['a@acme.test']);
});

test('a revoked invite cannot be accepted', () => {
  const s = createStore();
  const owner = s.accounts.get('free-owner');
  const inv = sendInvite(s, owner, 'a@acme.test');
  revokeInvite(s, owner, inv.id);
  assert.throws(() => acceptInvite(s, inv.code), fail(410, 'This invite was revoked.'));
});

test('signup makes a new Free org and a working token', () => {
  const s = createStore();
  const { account, org, token } = signup(s, { email: 'qa+1@acme.test', password: 'Passw0rd!' });
  assert.equal(accountForToken(s, token).key, account.key);
  assert.equal(org.plan, 'free');
});

test('a sign-in link works once', () => {
  const s = createStore();
  const code = signInLink(s, 'free-owner').split('/').pop();
  assert.equal(useSignInLink(s, code).key, 'free-owner');
  assert.equal(useSignInLink(s, code), null);
});

test('reset restores the seed', () => {
  const s = createStore();
  sendInvite(s, s.accounts.get('free-owner'), 'a@acme.test');
  signup(s, { email: 'qa+2@acme.test', password: 'Passw0rd!' });
  s.reset();
  assert.equal(s.invites.length, 0);
  assert.equal(s.mail.length, 0);
  assert.equal(s.accounts.size, 4);
});
