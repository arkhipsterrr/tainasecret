import type { UsersRepo, BalancesRepo } from '@arhip/db';
import { formatRub } from '@arhip/core';

export async function handleBalance(ctx: any, deps: { users: UsersRepo; balances: BalancesRepo }) {
  const u = deps.users.get(ctx.from.id);
  if (!u) return ctx.reply('Сначала отправьте /start.');
  const hist = deps.balances.history(ctx.from.id, 5)
    .map((t) => `${t.reason}: ${formatRub(t.deltaRub)}`).join('\n');
  return ctx.reply(`Баланс: ${formatRub(u.balanceRub)}\n\n${hist || 'Движений пока нет.'}`);
}
