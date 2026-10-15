// Export the live .pw-capture profile's cookies to a storageState JSON so we can
// test the server's orders-confirmation path with a fresh REAL-account session
// WITHOUT touching the bot's production session. No navigation, just serialise.
//   npx tsx scripts/export-session.ts
import { chromium } from '@arhip/core';

const PROFILE = process.env.PROFILE_DIR ?? '.pw-capture';
const OUT = process.env.OUT ?? 'artifacts/fresh-storage.json';

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
await ctx.storageState({ path: OUT });
const state = await ctx.storageState();
const jsub = (state.cookies ?? []).filter((c) => (c.domain ?? '').includes('j-subculture.com'));
await ctx.close();
console.log(`wrote ${OUT} — ${jsub.length} j-subculture cookies:`, jsub.map((c) => c.name).join(', '));
process.exit(0);
