import type { UsersRepo } from '@arhip/db';

export interface HelpDeps {
  users: Pick<UsersRepo, 'get'>;
  adminIds: number[];
}

/** Status-aware help: shows only what the caller can actually do. */
export async function handleHelp(ctx: any, deps: HelpDeps) {
  const u = deps.users.get(ctx.from.id);
  const lines: string[] = [];

  if (!u) {
    lines.push('👋 Отправьте /start, чтобы создать аккаунт.');
  } else if (u.status === 'blocked') {
    lines.push('⛔ Ваш аккаунт заблокирован. Обратитесь к администратору.');
  } else if (u.status === 'pending') {
    lines.push('⏳ Аккаунт ожидает активации администратором.');
    lines.push('Доступно: /balance — баланс, /orders — заказы, /help — помощь.');
  } else {
    lines.push('Пришлите ссылку на товар Mercari — я покажу цену и кнопку покупки.');
    lines.push('Команды: /balance — баланс, /orders — заказы, /help — помощь.');
  }

  if (deps.adminIds.includes(ctx.from.id)) {
    lines.push('');
    lines.push('🔧 Админ:');
    lines.push('/users — список пользователей');
    lines.push('/summary — деньги: балансы, потрачено, возвраты');
    lines.push('/allorders — последние заказы всех пользователей');
    lines.push('/refunds — заявки на возврат (approve/reject)');
    lines.push('/info <id|@user> — карточка пользователя (цены/статус/баланс)');
    lines.push('/activate <id|@user> · /block <id|@user>');
    lines.push('/topup <id|@user> <сумма_руб>');
    lines.push('/pricing · /rate <v> · /markup <v> · /fee <v>');
  }

  return ctx.reply(lines.join('\n'));
}
