import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UsersRepo, BalancesRepo } from '@arhip/db';

const idSchema = z.preprocess(
  (v) => Number(v),
  z.number().int().finite(),
);

const topupBody = z.object({
  amountRub: z.number().finite().positive(),
  note: z.string().optional(),
});

export function registerAdmin(
  app: FastifyInstance,
  deps: { users: Pick<UsersRepo, 'list' | 'get' | 'setStatus'>; balances: Pick<BalancesRepo, 'topup' | 'history'> },
) {
  app.get('/admin/users', async () => deps.users.list());

  app.post('/admin/users/:id/activate', async (req, reply) => {
    const parsed = idSchema.safeParse((req.params as any).id);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    deps.users.setStatus(parsed.data, 'active');
    return { ok: true };
  });

  app.post('/admin/users/:id/block', async (req, reply) => {
    const parsed = idSchema.safeParse((req.params as any).id);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    deps.users.setStatus(parsed.data, 'blocked');
    return { ok: true };
  });

  app.post('/admin/users/:id/topup', async (req, reply) => {
    const idParsed = idSchema.safeParse((req.params as any).id);
    if (!idParsed.success) return reply.code(400).send({ error: 'bad_request' });
    const id = idParsed.data;

    const bodyParsed = topupBody.safeParse(req.body);
    if (!bodyParsed.success) return reply.code(400).send({ error: 'bad_request' });
    const { amountRub, note } = bodyParsed.data;

    const user = deps.users.get(id);
    if (user === null) return reply.code(404).send({ error: 'not_found' });

    deps.balances.topup(id, Math.round(amountRub * 100), note ?? '');
    return { ok: true, balanceRub: deps.users.get(id)!.balanceRub };
  });

  app.get('/admin/users/:id/txns', async (req, reply) => {
    const parsed = idSchema.safeParse((req.params as any).id);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    return deps.balances.history(parsed.data, 50);
  });
}
