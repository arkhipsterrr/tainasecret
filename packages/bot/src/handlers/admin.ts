import type { UsersRepo, BalancesRepo, SettingsRepo, PricingValues, PricingKey, RefundRequestsRepo, PurchasesRepo, User } from '@arhip/db';
import { applyRefundDecision } from '@arhip/db';
import { formatRub, costKopecks } from '@arhip/core';
import { InlineKeyboard } from 'grammy';
import type { PendingEdits } from '../admin-edits.ts';

export interface AdminDeps {
  adminIds: number[];
  users: Pick<UsersRepo, 'list' | 'get' | 'setStatus' | 'getByUsername'>;
  balances: Pick<BalancesRepo, 'topup'>;
}

/** Resolve an admin command target: a numeric telegram_id, or a @username. */
function resolveTarget(users: Pick<UsersRepo, 'getByUsername'>, token: string): number | null {
  const s = token.trim();
  if (/^\d+$/.test(s)) return Number(s);
  return users.getByUsername(s)?.telegramId ?? null;
}

export interface PricingAdminDeps {
  adminIds: number[];
  settings: Pick<SettingsRepo, 'get' | 'set' | 'getPricing'>;
  defaultPricing: PricingValues;
}

/** Admin membership is set only via TELEGRAM_ADMIN_IDS (server env + restart). */
function isAdmin(ctx: any, adminIds: number[]): boolean {
  return adminIds.includes(ctx.from?.id);
}

export async function handleUsers(ctx: any, deps: AdminDeps & { purchases?: Pick<PurchasesRepo, 'listByUser'> }) {
  if (!isAdmin(ctx, deps.adminIds)) return; // silent: don't reveal the command
  const users = deps.users.list();
  if (users.length === 0) return ctx.reply('Пользователей нет.');

  const kb = new InlineKeyboard();
  for (const u of users) {
    kb.text(`@${u.username ?? u.telegramId} (${u.status})`, `uinfo_card:${u.telegramId}`).row();
  }

  return ctx.reply('👥 **Список всех пользователей:**\nНажмите на пользователя для управления:', {
    parse_mode: 'Markdown',
    reply_markup: kb,
  });
}

export async function handleActivate(ctx: any, deps: AdminDeps) {
  if (!isAdmin(ctx, deps.adminIds)) return;
  const arg = String(ctx.match ?? '').trim();
  if (!arg) return ctx.reply('Использование: /activate <telegram_id | @username>');
  const id = resolveTarget(deps.users, arg);
  if (id === null || !deps.users.get(id)) return ctx.reply(`Пользователь ${arg} не найден.`);
  deps.users.setStatus(id, 'active');
  return ctx.reply(`✅ Пользователь ${id} активирован.`);
}

export async function handleBlock(ctx: any, deps: AdminDeps) {
  if (!isAdmin(ctx, deps.adminIds)) return;
  const arg = String(ctx.match ?? '').trim();
  if (!arg) return ctx.reply('Использование: /block <telegram_id | @username>');
  const id = resolveTarget(deps.users, arg);
  if (id === null || !deps.users.get(id)) return ctx.reply(`Пользователь ${arg} не найден.`);
  deps.users.setStatus(id, 'blocked');
  return ctx.reply(`⛔ Пользователь ${id} заблокирован.`);
}

export async function handleTopup(ctx: any, deps: AdminDeps) {
  if (!isAdmin(ctx, deps.adminIds)) return;
  const parts = String(ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
  const token = parts[0];
  const amountRub = Number((parts[1] ?? '').replace(',', '.'));
  if (!token || !Number.isFinite(amountRub) || amountRub <= 0)
    return ctx.reply('Использование: /topup <telegram_id | @username> <сумма_руб>');
  const id = resolveTarget(deps.users, token);
  if (id === null || !deps.users.get(id)) return ctx.reply(`Пользователь ${token} не найден.`);
  const kopecks = Math.round(amountRub * 100);
  deps.balances.topup(id, kopecks, 'via bot');
  const nb = deps.users.get(id)!;
  return ctx.reply(`💰 Пополнено ${formatRub(kopecks)}. Баланс ${id}:${formatRub(nb.balanceRub)}`);
}

// ---- Catalog views (moved from the web console into the bot) ----

const ORDER_ICON: Record<string, string> = { bought: '✅', failed: '❌' };

export interface SummaryDeps {
  adminIds: number[];
  users: Pick<UsersRepo, 'totalBalance'>;
  purchases: Pick<PurchasesRepo, 'totalSpent'>;
  refunds: Pick<RefundRequestsRepo, 'totalPending'>;
}

/** /summary — money overview: total balances, total spent, pending refunds. */
export async function handleSummary(ctx: any, deps: SummaryDeps) {
  if (!isAdmin(ctx, deps.adminIds)) return;
  return ctx.reply(
    '📊 Сводка\n' +
    `Балансы пользователей: ${formatRub(deps.users.totalBalance())}\n` +
    `Потрачено (куплено): ${formatRub(deps.purchases.totalSpent())}\n` +
    `Ожидают возврата: ${formatRub(deps.refunds.totalPending())}`,
  );
}

export interface AllOrdersDeps {
  adminIds: number[];
  purchases: Pick<PurchasesRepo, 'listAll'>;
}

/** /allorders — the last 15 orders across ALL users (vs /orders, the caller's own). */
export async function handleAllOrders(ctx: any, deps: AllOrdersDeps) {
  if (!isAdmin(ctx, deps.adminIds)) return;
  const orders = deps.purchases.listAll(15);
  if (orders.length === 0) return ctx.reply('Заказов пока нет.');
  const body = orders
    .map((o) => {
      const icon = ORDER_ICON[o.status] ?? '•';
      const who = o.username ? '@' + o.username : String(o.telegramId);
      return `${icon}${o.createdAt.slice(0, 10)} · ${who} ·${o.priceJpy}¥ / ${formatRub(o.costRub)}\n${o.mercariUrl}`;
    })
    .join('\n\n');
  return ctx.reply(`Последние заказы:\n\n${body}`, { disable_web_page_preview: true });
}

export interface RefundsListDeps {
  adminIds: number[];
  refunds: Pick<RefundRequestsRepo, 'listPending'>;
}

/**
 * /refunds — list pending refund requests, each with its own approve/reject
 * inline buttons (same callbacks as the push notification).
 */
export async function handleRefunds(ctx: any, deps: RefundsListDeps) {
  if (!isAdmin(ctx, deps.adminIds)) return;
  const pending = deps.refunds.listPending();
  if (pending.length === 0) return ctx.reply('Заявок на возврат нет.');
  for (const r of pending) {
    const kb = new InlineKeyboard()
      .text('✅ Вернуть', `refund_approve:${r.id}`)
      .text('🚫 Отклонить', `refund_reject:${r.id}`);
    await ctx.reply(
      `💸 Заявка #${r.id}\n` +
      `Пользователь: ${r.telegramId}\n` +
      `Сумма: ${formatRub(r.kopecks)}\n` +
      `Причина: ${r.reason}\n${r.mercariUrl}`,
      { reply_markup: kb, disable_web_page_preview: true },
    );
  }
}

// ---- Signup approval (inline approve/decline on the admin notification) ----

export interface SignupDecisionDeps {
  adminIds: number[];
  users: Pick<UsersRepo, 'get' | 'setStatus'>;
}

export async function handleSignupDecision(ctx: any, deps: SignupDecisionDeps) {
  if (!isAdmin(ctx, deps.adminIds)) {
    try { await ctx.answerCallbackQuery({ text: 'Недоступно' }); } catch { /* ignore */ }
    return;
  }
  const [action, idStr] = String(ctx.callbackQuery?.data ?? '').split(':');
  const id = Number(idStr);
  const u = deps.users.get(id);
  if (!u) {
    try { await ctx.answerCallbackQuery({ text: 'Пользователь не найден' }); } catch { /* ignore */ }
    return;
  }
  if (action === 'approve') {
    deps.users.setStatus(id, 'active');
    try { await ctx.answerCallbackQuery({ text: 'Добавлен ✅' }); } catch { /* ignore */ }
    try { await ctx.editMessageText(`✅ Добавлен: ${id} @${u.username ?? '—'}`); } catch { /* ignore */ }
    try { await ctx.api?.sendMessage(id, '✅ Ваш аккаунт активирован! Пришлите ссылку на товар Mercari.'); } catch { /* ignore */ }
  } else {
    deps.users.setStatus(id, 'blocked');
    try { await ctx.answerCallbackQuery({ text: 'Отклонён 🚫' }); } catch { /* ignore */ }
    try { await ctx.editMessageText(`🚫 Отклонён: ${id} @${u.username ?? '—'}`); } catch { /* ignore */ }
  }
}

// ---- Refund approval (inline approve/reject on the refund notification) ----

export interface RefundDecisionDeps {
  adminIds: number[];
  refunds: Pick<RefundRequestsRepo, 'get' | 'resolve'>;
  balances: Pick<BalancesRepo, 'refund'>;
}

export async function handleRefundDecision(ctx: any, deps: RefundDecisionDeps) {
  if (!isAdmin(ctx, deps.adminIds)) {
    try { await ctx.answerCallbackQuery({ text: 'Недоступно' }); } catch { /* ignore */ }
    return;
  }
  const [action, idStr] = String(ctx.callbackQuery?.data ?? '').split(':');
  const id = Number(idStr);
  const approve = action === 'refund_approve';
  const { outcome, request: req } = applyRefundDecision(deps.refunds, deps.balances, id, approve);

  if (outcome === 'not_found') {
    try { await ctx.answerCallbackQuery({ text: 'Заявка не найдена' }); } catch { /* ignore */ }
    return;
  }
  if (outcome === 'already') {
    try { await ctx.answerCallbackQuery({ text: 'Уже обработано' }); } catch { /* ignore */ }
    try { await ctx.editMessageText(`☑️ Возврат #${id} уже обработан другим админом.`); } catch { /* ignore */ }
    return;
  }
  if (outcome === 'approved') {
    try { await ctx.answerCallbackQuery({ text: 'Возврат одобрен ✅' }); } catch { /* ignore */ }
    try { await ctx.editMessageText(`✅ Возврат #${id} одобрен — ${formatRub(req!.kopecks)} возвращены пользователю ${req!.telegramId}.`); } catch { /* ignore */ }
    try { await ctx.api?.sendMessage(req!.telegramId, `✅ Возврат одобрен: ${formatRub(req!.kopecks)} возвращены на баланс.`); } catch { /* ignore */ }
  } else {
    try { await ctx.answerCallbackQuery({ text: 'Отклонено 🚫' }); } catch { /* ignore */ }
    try { await ctx.editMessageText(`🚫 Возврат #${id} отклонён — средства оставлены списанными (${formatRub(req!.kopecks)}).`); } catch { /* ignore */ }
    try { await ctx.api?.sendMessage(req!.telegramId, '❌ Заявка на возврат отклонена администратором.'); } catch { /* ignore */ }
  }
}

// ---- Pricing (rate / markup / fee) — live overrides stored in settings ----

function pricingSummary(p: PricingValues): string {
  return (
    `Формула: (цена + ${p.planFeeJpy}) × ${p.rubPerJpy} × (1 +${p.markup})\n` +
    `Пример: 3000 ¥ → ${formatRub(costKopecks(3000, p))}`
  );
}

async function setPricingKey(
  ctx: any,
  deps: PricingAdminDeps,
  key: 'rate' | 'markup' | 'fee',
  label: string,
  hint: string,
  ok: (n: number) => boolean,
) {
  if (!isAdmin(ctx, deps.adminIds)) return;
  const n = Number(String(ctx.match ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || !ok(n)) return ctx.reply(`Использование: /${key} <число ${hint}>`);
  deps.settings.set(key, String(n));
  return ctx.reply(`✅ ${label} = ${n}\n${pricingSummary(deps.settings.getPricing(deps.defaultPricing))}`);
}

export async function handlePricing(ctx: any, deps: PricingAdminDeps) {
  if (!isAdmin(ctx, deps.adminIds)) return;
  return ctx.reply(`Текущие цены:\n${pricingSummary(deps.settings.getPricing(deps.defaultPricing))}`);
}

export const handleRate = (ctx: any, deps: PricingAdminDeps) =>
  setPricingKey(ctx, deps, 'rate', 'Курс (руб/йена)', '> 0', (n) => n > 0);

export const handleMarkup = (ctx: any, deps: PricingAdminDeps) =>
  setPricingKey(ctx, deps, 'markup', 'Наценка (доля, 0.1 = 10%)', '>= 0', (n) => n >= 0);

export const handleFee = (ctx: any, deps: PricingAdminDeps) =>
  setPricingKey(ctx, deps, 'fee', 'Fee (йены)', '>= 0', (n) => n >= 0);

// ---- User card (/info) — a per-user control panel with inline actions ----

const PRICING_META: Record<PricingKey, { label: string; hint: string; ok: (n: number) => boolean }> = {
  rate: { label: 'Курс (руб/йена)', hint: '> 0', ok: (n) => n > 0 },
  markup: { label: 'Наценка (доля, 0.1 = 10%)', hint: '>= 0', ok: (n) => n >= 0 },
  fee: { label: 'Fee (йены)', hint: '>= 0', ok: (n) => n >= 0 },
};

const isResetWord = (s: string) => /^(сброс|reset|глоб|global)/i.test(s.trim());

export interface UserCardDeps {
  adminIds: number[];
  users: Pick<UsersRepo, 'get' | 'getByUsername' | 'setStatus'>;
  balances: Pick<BalancesRepo, 'topup'>;
  settings: Pick<SettingsRepo, 'getUserOverrides' | 'getPricingFor' | 'setUser' | 'clearUser'>;
  purchases?: Pick<PurchasesRepo, 'listByUser'>;
  defaultPricing: PricingValues;
  edits: PendingEdits;
}

/** Render a user's control-panel card: identity, money, effective pricing, actions. */
function renderCard(u: User, deps: UserCardDeps): { text: string; reply_markup: InlineKeyboard } {
  const eff = deps.settings.getPricingFor(u.telegramId, deps.defaultPricing);
  const ov = deps.settings.getUserOverrides(u.telegramId);
  const tag = (personal: boolean) => (personal ? 'личн.' : 'глоб.');
  const text =
    `👤 ${u.telegramId} @${u.username ?? '—'}\n` +
    `Статус: ${u.status}\n` +
    `Баланс: ${formatRub(u.balanceRub)}\n\n` +
    `Цены для этого пользователя:\n` +
    `• Курс: ${eff.rubPerJpy} (${tag(ov.rate != null)})\n` +
    `• Наценка: ${eff.markup} (${tag(ov.markup != null)})\n` +
    `• Fee: ${eff.planFeeJpy} (${tag(ov.fee != null)})\n` +
    `Пример: 3000 ¥ → ${formatRub(costKopecks(3000, eff))}`;

  const id = u.telegramId;
  const kb = new InlineKeyboard()
    .text('✏️ Курс', `uedit:rate:${id}`)
    .text('✏️ Наценка', `uedit:markup:${id}`)
    .text('✏️ Fee', `uedit:fee:${id}`)
    .row();
  if (u.status === 'active') kb.text('⛔ Заблокировать', `ustatus:blocked:${id}`);
  else kb.text('✅ Активировать', `ustatus:active:${id}`);
  kb.row()
    .text('💰 Пополнить', `utopup:${id}`)
    .text('📜 Заказы юзера', `uorders:${id}`)
    .row()
    .text('🔙 К списку', 'uusers_list');
  return { text, reply_markup: kb };
}

/** /info <telegram_id | @username> — open a user's control-panel card. */
export async function handleInfo(ctx: any, deps: UserCardDeps) {
  if (!isAdmin(ctx, deps.adminIds)) return; // silent: don't reveal the command
  const arg = String(ctx.match ?? '').trim();
  if (!arg) return ctx.reply('Использование: /info <telegram_id | @username>');
  const id = resolveTarget(deps.users, arg);
  const u = id === null ? null : deps.users.get(id);
  if (!u) return ctx.reply(`Пользователь ${arg} не найден.`);
  const card = renderCard(u, deps);
  return ctx.reply(card.text, { reply_markup: card.reply_markup });
}

/**
 * Inline-button actions on a user card
 */
export async function handleUserCallback(ctx: any, deps: UserCardDeps & { purchases?: Pick<PurchasesRepo, 'listByUser'>; usersList?: Pick<UsersRepo, 'list'> }) {
  if (!isAdmin(ctx, deps.adminIds)) {
    try { await ctx.answerCallbackQuery({ text: 'Недоступно' }); } catch { /* ignore */ }
    return;
  }
  const data = String(ctx.callbackQuery?.data ?? '');

  if (data === 'uusers_list') {
    const users = deps.usersList ? deps.usersList.list() : [];
    const kb = new InlineKeyboard();
    for (const u of users) {
      kb.text(`@${u.username ?? u.telegramId} (${u.status})`, `uinfo_card:${u.telegramId}`).row();
    }
    try { await ctx.answerCallbackQuery(); } catch {}
    try {
      return ctx.editMessageText('👥 **Список всех пользователей:**', { parse_mode: 'Markdown', reply_markup: kb });
    } catch { return; }
  }

  if (data.startsWith('uinfo_card:')) {
    const id = Number(data.split(':')[1]);
    const u = deps.users.get(id);
    if (!u) { try { await ctx.answerCallbackQuery({ text: 'Не найден' }); } catch {} return; }
    const card = renderCard(u, deps);
    try { await ctx.answerCallbackQuery(); } catch {}
    try {
      return ctx.editMessageText(card.text, { reply_markup: card.reply_markup });
    } catch { return; }
  }

  if (data.startsWith('uorders:')) {
    const id = Number(data.split(':')[1]);
    const u = deps.users.get(id);
    if (!u) { try { await ctx.answerCallbackQuery({ text: 'Не найден' }); } catch {} return; }

    const orders = deps.purchases ? deps.purchases.listByUser(id, 10) : [];
    let text = `📜 **Заказы пользователя @${u.username ?? id}:**\n\n`;
    if (orders.length === 0) {
      text += 'У пользователя нет заказов.';
    } else {
      orders.forEach((o, idx) => {
        const costRub = formatRub(o.costRub);
        text += `${idx + 1}. ¥${o.priceJpy} -> **${costRub}** [${o.status}] (${o.createdAt.slice(0, 10)})\n`;
      });
    }

    const kb = new InlineKeyboard().text('🔙 Назад в карточку', `uinfo_card:${id}`);
    try { await ctx.answerCallbackQuery(); } catch {}
    try {
      return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb });
    } catch { return; }
  }

  const parts = data.split(':');
  const kind = parts[0];

  if (kind === 'ustatus') {
    const status = parts[1] as 'active' | 'blocked';
    const id = Number(parts[2]);
    const u = deps.users.get(id);
    if (!u) { try { await ctx.answerCallbackQuery({ text: 'Пользователь не найден' }); } catch { /* ignore */ } return; }
    deps.users.setStatus(id, status);
    try { await ctx.answerCallbackQuery({ text: status === 'active' ? 'Активирован ✅' : 'Заблокирован ⛔' }); } catch { /* ignore */ }
    const card = renderCard(deps.users.get(id)!, deps);
    try { await ctx.editMessageText(card.text, { reply_markup: card.reply_markup }); } catch { /* ignore edit races */ }
    return;
  }

  if (kind === 'uedit') {
    const key = parts[1] as PricingKey;
    const id = Number(parts[2]);
    const u = deps.users.get(id);
    if (!u || !PRICING_META[key]) { try { await ctx.answerCallbackQuery({ text: 'Недоступно' }); } catch { /* ignore */ } return; }
    deps.edits.set(ctx.from.id, { action: 'pricing', targetId: id, key });
    try { await ctx.answerCallbackQuery(); } catch { /* ignore */ }
    const m = PRICING_META[key];
    return ctx.reply(
      `Введите ${m.label} для @${u.username ?? id} (${m.hint}), или «сброс» — вернуть глобальное.`,
      { reply_markup: { force_reply: true } },
    );
  }

  if (kind === 'utopup') {
    const id = Number(parts[1]);
    const u = deps.users.get(id);
    if (!u) { try { await ctx.answerCallbackQuery({ text: 'Пользователь не найден' }); } catch { /* ignore */ } return; }
    deps.edits.set(ctx.from.id, { action: 'topup', targetId: id });
    try { await ctx.answerCallbackQuery(); } catch { /* ignore */ }
    return ctx.reply(`Введите сумму пополнения в рублях для @${u.username ?? id}.`, { reply_markup: { force_reply: true } });
  }
}

/**
 * Consume an admin's force-reply answer to a card edit.
 */
export async function handleAdminReply(ctx: any, deps: UserCardDeps): Promise<boolean> {
  if (!isAdmin(ctx, deps.adminIds)) return false;
  const pending = deps.edits.take(ctx.from.id);
  if (!pending) return false;

  const text = String(ctx.message?.text ?? '').trim();
  const u = deps.users.get(pending.targetId);
  if (!u) { await ctx.reply('Пользователь не найден.'); return true; }

  if (pending.action === 'topup') {
    const amountRub = Number(text.replace(',', '.'));
    if (!Number.isFinite(amountRub) || amountRub <= 0) {
      await ctx.reply('Неверная сумма. Введите число рублей > 0. Нажмите «Пополнить» ещё раз.');
      return true;
    }
    deps.balances.topup(u.telegramId, Math.round(amountRub * 100), 'via card');
  } else {
    const key = pending.key!;
    const m = PRICING_META[key];
    if (isResetWord(text)) {
      deps.settings.clearUser(u.telegramId, key);
    } else {
      const n = Number(text.replace(',', '.'));
      if (!Number.isFinite(n) || !m.ok(n)) {
        await ctx.reply(`Неверное значение. ${m.label}: нужно число ${m.hint}.