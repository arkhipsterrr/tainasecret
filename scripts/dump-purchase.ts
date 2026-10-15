// Discovery helper: dump the authenticated direct-purchase page so the operator
// can confirm the Plan A radio value and the price selector.
//   npx tsx scripts/dump-purchase.ts [mercari_item_url]
import { loadConfig, Session, PATHS } from '@arhip/core';
import { writeFile, mkdir } from 'node:fs/promises';

const cfg = loadConfig();
const url = process.argv[2] ?? 'https://jp.mercari.com/item/m88297815004';

await new Session(cfg).withPage(async (page) => {
  await page.goto(cfg.baseUrl + PATHS.directPurchase(url), { waitUntil: 'domcontentloaded' });
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/purchase-page.html', await page.content());
  await page.screenshot({ path: 'artifacts/purchase-page.png', fullPage: true });
  const plans = await page.$$eval('input[name="Other[plan_type_tmp]"]', (els) =>
    els.map((e) => ({
      value: (e as HTMLInputElement).value,
      label: (e.closest('label') as HTMLElement)?.innerText?.slice(0, 60),
    })));
  console.log('PLANS', plans);
  console.log('Saved artifacts/purchase-page.html + .png');
});
