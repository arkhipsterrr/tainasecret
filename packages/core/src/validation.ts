export function normalizeMercariUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error('invalid_mercari_url');
  }
  if (u.hostname !== 'jp.mercari.com') throw new Error('invalid_mercari_url');
  // Accept an optional locale prefix (e.g. /en/item/..., /ja/item/...) and
  // canonicalize to the locale-less form the purchase page expects.
  const m = u.pathname.match(/^\/(?:[a-z]{2}\/)?item\/([A-Za-z0-9]+)\/?$/);
  if (!m) throw new Error('invalid_mercari_url');
  return `https://jp.mercari.com/item/${m[1]}`;
}
