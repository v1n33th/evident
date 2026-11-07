import { randomUUID } from 'node:crypto';
import { AppError, isEmail } from './store.mjs';
import { startOfUtcDay } from './time.mjs';

const FREE_DAILY_LIMIT = 10;

function mailLink(store, invite) {
  const link = `${store.baseUrl}/accept/${invite.code}`;
  store.mail.push({
    to: invite.email,
    subject: 'You are invited to join Acme',
    body: `Accept your invite: ${link}`,
    links: [link],
    at: store.now(),
  });
}

function ownInvite(store, account, id) {
  const invite = store.invites.find((i) => i.id === id && i.orgId === account.orgId);
  if (!invite) throw new AppError(404, 'Invite not found.');
  return invite;
}

export async function sendInvite(store, account, email) {
  if (account.role !== 'owner') throw new AppError(403, 'You do not have permission to invite people.');
  if (!isEmail(email)) throw new AppError(400, 'Enter a valid email address.');
  const dup = store.invites.some(
    (i) => i.orgId === account.orgId && i.status !== 'revoked' && i.email.toLowerCase() === email.toLowerCase(),
  );
  if (dup) throw new AppError(409, 'This person is already invited.');
  // Give the mailer a moment to connect before the invite is recorded.
  await new Promise((r) => setTimeout(r, 200));
  if (store.orgs.get(account.orgId)?.plan === 'free') {
    const today = startOfUtcDay(store.now());
    const sentToday = store.invites.filter((i) => i.orgId === account.orgId && i.createdAt >= today).length;
    if (sentToday > FREE_DAILY_LIMIT) throw new AppError(429, 'Daily invite limit reached.');
  }
  const invite = {
    id: randomUUID(),
    orgId: account.orgId,
    email,
    byKey: account.key,
    createdAt: store.now(),
    status: 'sent',
    code: randomUUID(),
  };
  store.invites.push(invite);
  mailLink(store, invite);
  return invite;
}

export function listInvites(store, account, query = {}) {
  return store.invites.filter(
    (i) => i.orgId === (query.org ?? account.orgId) && (!query.status || i.status === query.status),
  );
}

export function resendInvite(store, account, id) {
  const invite = ownInvite(store, account, id);
  if (invite.status !== 'sent') throw new AppError(409, 'Only sent invites can be resent.');
  mailLink(store, invite);
  return invite;
}

export function revokeInvite(store, account, id) {
  const invite = ownInvite(store, account, id);
  invite.status = 'revoked';
  return invite;
}

export function acceptInvite(store, code) {
  const invite = store.invites.find((i) => i.code === code);
  if (!invite) throw new AppError(404, 'Invite not found.');
  invite.status = 'accepted';
  return invite;
}
