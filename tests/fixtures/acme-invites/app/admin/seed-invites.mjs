import { admin, print } from './lib.mjs';
print(await admin('/admin/seed-invites', { org: process.argv[2], count: Number(process.argv[3]) }));
