import { admin, print } from './lib.mjs';
print(await admin('/admin/new-org', { plan: process.argv[2] ?? 'free' }));
