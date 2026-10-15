import type { UsersRepo } from '@arhip/db';
import { normalizeMercariUrl, costKopecks, formatRub, type PricingConfig } from '@arhip/core';
import type { PreviewCache } from '../preview-cache.ts';
import { InlineKeyboard } from 'grammy';

interface LinkDeps {
  users: UsersRepo;
  previews: PreviewCache;
  previewFn: (url: string) => Promise<{ title: string; priceJpy: number; plans: unknown[] }>;
  pricing: PricingConfig;
}

// Human-readable hints for the errors previewFn / JsubClient can throw.
const PREVIEW_ERROR_HINTS: Record<string, string> = {
  price_unavailable: 'не удалось прочитать цену — вероятно, сессия магазина разлогинена (нужно обновить).',
  needs_login: 'сессия магазина истекла — требуется повторный вход.',
  profile_incomplete: 'профиль аккаунта магазина не заполнен.',
};

export async function handleLink(ctx: any, deps: LinkDeps) {
  // Telegram reactions may be unavailable (old API / no rights) — never let a
  // failed reaction break the flow.
  const react = async (emoji: string) => { try { await ctx.react?.(emoji); } catch { /* ignore */ } };

  const u = deps.users.get(ctx.from.id);
  let url: string;
  try {
    url = normalizeMercariUrl(ctx.message.text);
  } catch {
    return ctx.reply('Это не похоже на ссылку Mercari. Пришлите ссылку вида https://jp.mercari.com/item/...');
  }
  // Acknowledge immediately: the preview runs a headless browser and can take
  // tens of seconds, so react 👀 so the user knows we picked it up.
  await react('👀');
  let p;
  try {
    p = await deps.previewFn(url);
  } catch (e) {
    await react('👎');
    const reason = (e as Error)?.message ?? 'unknown';
    const hint = PREVIEW_ERROR_HINTS[reason] ?? `ошибка: ${reason}`;
    return ctx.reply(`Не удалось получить товар: ${hint}`);
  }
  const cost = costKopecks(p.priceJpy, deps.pricing);
  const id = deps.previews.put(ctx.from.id, { url, title: p.title, priceJpy: p.priceJpy });
  const active = u?.status === 'active';
  const kb = active
    ? new InlineKeyboard()
        .text(`✅ Купить за ${formatRub(cost)}`, `buy:${id}`)
        .text('❌ Отмена', `cancel:${id}`)
    : undefined;
  const note = active ? '' : '\n\n⚠️ Аккаунт не активирован — покупка недоступна.';
  await react('👍');
  return ctx.reply(
    `${p.title}\nЦена: ${p.priceJpy} JPY\nИтого: ${formatRub(cost)}${note}`,
    { reply_markup: kb },
  );
}
