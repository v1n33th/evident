#!/usr/bin/env node
// Acme invites CLI: node cli.mjs invite <email> | invites list [--json] | invites revoke <id>, all with --token <t>.
const base = process.env.ACME_URL ?? 'http://localhost:4173';

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const json = args.includes('--json') && args.splice(args.indexOf('--json'), 1);
const token = take('--token');

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
  } catch {
    fail(`Could not reach ${base}.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error ?? `Request failed (${res.status}).`);
  return data;
}

const [cmd, sub, arg] = args;
if (cmd === 'invite' && sub || cmd === 'invites' && ['list', 'revoke'].includes(sub)) {
  if (!token) fail('Pass --token <token>.');
  if (cmd === 'invite') {
    const i = await api('POST', '/api/invites', { email: sub });
    console.log(`Invite sent to ${i.email} (id ${i.id})`);
  } else if (sub === 'list') {
    let res;
    try {
      res = await fetch(`${base}/api/invites`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      fail(`Could not reach ${base}.`);
    }
    const list = await res.json().catch(() => ({}));
    if (!Array.isArray(list)) console.log(list.error);
    else if (json) console.log(JSON.stringify(list));
    else for (const i of list) console.log(`${i.id}  ${i.email}  ${i.status}`);
  } else {
    if (!arg) fail('Usage: invites revoke <id> --token <token>');
    await api('DELETE', `/api/invites/${encodeURIComponent(arg)}`);
    console.log(`Revoked ${arg}`);
  }
} else {
  fail('Usage: cli.mjs invite <email> | invites list [--json] | invites revoke <id>  (--token <token>)');
}
