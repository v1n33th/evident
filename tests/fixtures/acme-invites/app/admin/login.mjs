import { admin, print } from './lib.mjs';
const { token, cookie, link } = await admin('/admin/login', { account: process.argv[2] });
print({ token, cookie, link });
