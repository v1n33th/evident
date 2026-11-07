import { admin, print } from './lib.mjs';
print(await admin('/admin/set-plan', { org: process.argv[2], plan: process.argv[3] }));
