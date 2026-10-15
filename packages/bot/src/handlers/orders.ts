import type { UsersRepo, PurchasesRepo, Order } from '@arhip/db';
import { formatRub } from '@arhip/core';

const STATUS_ICON: Record<string, string> = { bought: '✅', failed: '❌' };

function formatOrder(o: Order): string {
  const icon = STATUS_ICON[o.status] ?? '•';
  const date = o.createdAt.slice(0, 10);
  return `${icon} ${date} — ${o.priceJpy} ¥ / ${formatRub(o.costRub)}\n${o.mercariUrl}`;
}

export async function handleOrders(
  ctx: any,
  deps: { users: UsersRepo; purchases: PurchasesRepo },
) {
  const u = deps.users.get(ctx.from.id);
  if (!u) return ctx.reply('Сначала отправьте /start.');
  const orders = deps.purchases.listByUser(ctx.from.id, 10);
  if (orders.length === 0) return ctx.reply('Заказов пока нет.');
  const body = orders.map(formatOrder).join('\n\n');
  return ctx.reply(`Ваши последние заказы:\n\n${body}`, { disable_web_page_preview: true });
}
