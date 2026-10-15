import { InlineKeyboard } from 'grammy';
import { formatRub } from '@arhip/core';
import type { PreviewCache } from '../preview-cache.ts';
import type { BuyResult } from '../services/purchase.ts';

interface BuyCbDeps {
  previews: PreviewCache;
  buy: (
    telegramId: number,
    url: string,
    priceJpy: number,
    onValidating?: () => void | Promise<void>,
  ) => Promise<BuyResult>;
  adminIds: number[];
}

/** DM every admin about a pending refund with inline approve/reject buttons. */
async function notifyAdminsRefund(
  ctx: any,
  adminIds: number[],
  info: { requestId: number; userId: number; username?: string | null; title: string; url: string; costKopecks: number; reason: string },
) {
  const kb = new InlineKeyboard()
    .text('✅ Вернуть', `refund_approve:${info.requestId}`)
    .text('🚫 Отклонить', `refund_reject:${info.requestId}`);
  const text =
    `💸 Заявка на возврат #${info.requestId}\n` +
    `Пользователь: ${info.userId} @${info.username ?? '—'}\n` +
    `Товар: ${info.title}\n${info.url}\n` +
    `Сумма: ${formatRub(info.costKopecks)}\nПричина: ${info.reason}`;
  for (const adminId of adminIds) {
    try { await ctx.api?.sendMessage(adminId, text, { reply_markup: kb }); } catch { /* ignore */ }
  }
}

export async function handleBuyCallback(ctx: any, deps: BuyCbDeps) {
  const data: string = ctx.callbackQuery.data;
  const id = data.split(':')[1];
  if (data.startsWith('cancel:')) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText('Отменено.');
  }
  const preview = deps.previews.take(ctx.from.id, id);
  if (!preview) {
    return ctx.answerCallbackQuery({ text: 'Предложение устарело, пришлите ссылку заново.' });
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`${preview.title}\n⏳ Покупка начата…`);
  // On an ambiguous outcome the buy enters a slow orders-list validation (~15s);
  // tell the user the order was placed and is being confirmed, so they aren't
  // left staring at "покупка начата". Ignore edit races (e.g. identical text).
  const onValidating = async () => {
    try {
      await ctx.editMessageText(`${preview.title}\n🕐 Заказ отправлен — проверяю подтверждение покупки, это займёт до ~15 сек…`);
    } catch { /* ignore edit races */ }
  };
  const res = await deps.buy(ctx.from.id, preview.url, preview.priceJpy, onValidating);

  // Ambiguous/failed buy: money is NOT auto-returned. Tell the user a refund
  // request was filed and notify admins so they can approve/reject it.
  if (res.status === 'refund_pending') {
    await notifyAdminsRefund(ctx, deps.adminIds, {
      requestId: res.requestId, userId: ctx.from.id, username: ctx.from.username,
      title: preview.title, url: res.url, costKopecks: res.costKopecks, reason: res.reason,
    });
    return ctx.editMessageText(
      `${preview.title}\n⏳ Покупка не подтвердилась автоматически. ` +
      `Заявка на возврат отправлена администратору — деньги вернутся после проверки.`,
    );
  }

  const msg = {
    bought: '✅ Куплено!',
    insufficient: '❌ Недостаточно средств. Пополните баланс.',
    insufficient_shop: '❌ Магазин временно недоступен — деньги возвращены. Попробуйте позже.',
    not_active: '❌ Аккаунт не активирован.',
    already_bought: 'ℹ️ Этот товар уже куплен.',
  }[res.status] ?? '❌ Неизвестная ошибка.';
  return ctx.editMessageText(`${preview.title}\n${msg}`);
}
