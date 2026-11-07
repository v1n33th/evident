import { admin, print } from './lib.mjs';
print(await admin('/admin/reset'));
