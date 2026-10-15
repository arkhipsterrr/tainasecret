import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { loadConfig, Session, JsubClient, createRawClient, ResearchLog, ResearchReader, writeStorageState } from '@arhip/core';
import { openDb, migrate, UsersRepo, BalancesRepo, PurchasesRepo } from '@arhip/db';
import { buildServer } from './server.ts';
import { resolveApiToken, fileTokenStore } from './token.ts';

// Resolve the frontend relative to THIS module, not the CWD: `pnpm --filter
// start` runs with CWD = the package dir, so a CWD-relative path missed the
// file and served the "frontend missing" fallback.
const PUBLIC_PATH = fileURLToPath(new URL('../public/index.html', import.meta.url));

const cfg = loadConfig();
const db = openDb(process.env.SQLITE_PATH ?? 'data/app.db'); migrate(db);
const iso = () => new Date().toISOString();
const session = new Session(cfg);
const research = new ResearchLog(cfg.researchLogPath, cfg.runsDir);
const researchReader = new ResearchReader(cfg.researchLogPath, cfg.runsDir);
// /session diagnostics stay browser-based; preview/buy use raw HTTP when enabled.
const client = cfg.rawHttp ? createRawClient(cfg, research) : new JsubClient(session, cfg.baseUrl, research);
console.log(`buy engine: ${cfg.rawHttp ? 'raw-http' : 'browser'}`);

// Auto-provision the bearer token so a non-expert deploy never runs open and
// never needs the operator to invent a secret. Precedence: env API_TOKEN >
// persisted file > freshly generated (saved to data/api-token, printed once).
const tokenFile = process.env.API_TOKEN_FILE ?? 'data/api-token';
const { token: apiToken, source: tokenSource } = resolveApiToken(cfg.apiToken, fileTokenStore(tokenFile));
if (tokenSource === 'generated') {
  console.log(
    `\nAPI_TOKEN was not set — generated one and saved it to ${tokenFile}.\n` +
    `Use it to log into the console (keep it secret):\n\n    ${apiToken}\n`,
  );
} else if (tokenSource === 'file') {
  console.log(`API_TOKEN loaded from ${tokenFile} (used for console login).`);
}

const app = buildServer({
  session, client,
  purchases: new PurchasesRepo(db, iso),
  users: new UsersRepo(db, iso),
  balances: new BalancesRepo(db, iso),
  research: researchReader,
  importSession: (cookies) => writeStorageState(cookies, cfg.storageStatePath),
  apiToken,
  publicPath: PUBLIC_PATH,
  rateLimit: {
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
  },
});
app.listen({ port: cfg.port, host: '0.0.0.0' })
  .then(() => console.log(`listening on :${cfg.port}`))
  .catch((e) => { console.error(e); process.exit(1); });
