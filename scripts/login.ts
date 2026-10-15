// One-time manual login. Opens a headed browser; you sign in (and solve
// reCAPTCHA) by hand. The authenticated session is saved to STORAGE_STATE_PATH.
//   npx tsx scripts/login.ts
import { loadConfig, Session } from '@arhip/core';

await new Session(loadConfig()).login();
console.log('saved session');
