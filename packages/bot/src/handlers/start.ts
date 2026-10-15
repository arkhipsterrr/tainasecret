import type { UsersRepo, User } from '@arhip/db';
import { InlineKeyboard } from 'grammy';

export interface StartDeps {
  users: Pick<UsersRepo, 'get' | 'upsertOnStart'>;
  adminIds: number[];
}

/** DM every admin about a new signup with inline approve/decline buttons. */
async function notifyAdmins(ctx: any, adminIds: number[], u: User) {
  const kb = new InlineKeyboard()
    .text('✅ Добавить', `approve:${u.telegramId}`)
    .text('🚫 Не добавлять', `decline:${u.telegramId}`);
  const text = `🆕 Новая заявка\nID: ${u.telegramId}\nUser: @${u.username ?? '—'}`;
  for (const adminId of adminIds) {
    try { await ctx.api?.sendMessage(adminId, text, { reply_markup: kb }); } catch { /* ignore */ }
  }
}

export async function handleStart(ctx: any, deps: StartDeps) {
  const isNew = deps.users.get(ctx.from.id) === null;
  const u = deps.users.upsertOnStart(ctx.from.id, ctx.from.username ?? null);
  if (u.status === 'active') return ctx.reply('Готово. Пришлите ссылку на товар Mercari.');
  // Notify admins once, on the first /start (a genuinely new incoming request).
  if (isNew) await notifyAdmins(ctx, deps.adminIds, u);
  return ctx.reply('Аккаунт создан и ждёт активации администратором.');
}
