import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { openDb, migrate, PurchasesRepo, UsersRepo } from '@arhip/db';

const path = process.env.SQLITE_PATH ?? 'data/app.db';
const db = openDb(path);
migrate(db);

const iso = () => new Date().toISOString();
new UsersRepo(db, iso).upsertOnStart(0, 'legacy-operator');

const purchases = new PurchasesRepo(db, iso);

let urls: string[] = [];
try {
  urls = (JSON.parse(readFileSync('data/ledger.json', 'utf8')).bought ?? []);
} catch {
  urls = [];
}

for (const url of urls) {
  try {
    purchases.record({ telegramId: 0, mercariUrl: url, priceJpy: 0, costRub: 0, status: 'bought' });
  } catch {
    // swallow duplicate-bought unique index violations — re-running is idempotent
  }
}

console.log(`imported ${urls.length} legacy purchases`);
