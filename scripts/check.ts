// Report whether the saved session is still authenticated.
//   npx tsx scripts/check.ts
import { loadConfig, Session } from '@arhip/core';

console.log(await new Session(loadConfig()).isAlive());
