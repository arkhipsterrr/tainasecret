// One-off: resize extension/icons source PNG to 16/32/48/128 using Chromium canvas.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'D:\\Downloads\\spysync.png';
const OUT_DIR = join(root, 'extension', 'icons');
const SIZES = [16, 32, 48, 128];

const srcB64 = readFileSync(SRC).toString('base64');
const dataUrl = `data:image/png;base64,${srcB64}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const results = await page.evaluate(async ({ dataUrl, sizes }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const out = {};
  for (const s of sizes) {
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(img, 0, 0, s, s);
    out[s] = c.toDataURL('image/png').split(',')[1];
  }
  return out;
}, { dataUrl, sizes: SIZES });

for (const s of SIZES) {
  const buf = Buffer.from(results[s], 'base64');
  writeFileSync(join(OUT_DIR, `icon${s}.png`), buf);
  console.log(`wrote icon${s}.png (${buf.length} bytes)`);
}

await browser.close();
