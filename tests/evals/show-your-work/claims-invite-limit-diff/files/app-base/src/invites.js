import { UserError } from './errors.js';
import { mailer } from './mailer.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendInvite(db, org, user, email) {
  if (!user.can('invite')) throw new UserError('You do not have permission to invite people.', 403);
  if (!EMAIL.test(email)) throw new UserError('Enter a valid email address.', 400);
  if (await db.invites.exists(org.id, email)) throw new UserError('This person is already invited.', 409);
  const invite = await db.invites.create(org.id, email, user.id);
  await mailer.send(email, 'invite', { org: org.name, link: invite.link });
  return invite;
}
