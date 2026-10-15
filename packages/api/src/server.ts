import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Constant-time string compare for the bearer token, so a network attacker can't
// use response timing to recover the token byte-by-byte. Unequal lengths short-
// circuit (timingSafeEqual requires equal-length buffers); the length of a random
// token is not itself a useful secret.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
import { normalizeMercariUrl } from '@arhip/core';
import type { Session } from '@arhip/core';
import type { JsubClient } from '@arhip/core';
import type { ResearchReader } from '@arhip/core';
import type { PurchasesRepo, UsersRepo, BalancesRepo } from '@arhip/db';
import { registerAdmin } from './admin.ts';

interface Deps {
  session: Pick<Session, 'isAlive' | 'login' | 'logout'>;
  client: Pick<JsubClient, 'preview' | 'buy'>;
  purchases: Pick<PurchasesRepo, 'isBought' | 'record'>;
  users?: Pick<UsersRepo, 'list' | 'get' | 'setStatus'>;
  balances?: Pick<BalancesRepo, 'topup' | 'history'>;
  research?: Pick<ResearchReader, 'recent' | 'getRun'>;
  importSession?: (cookies: unknown) => Promise<{ importedCookies: number; authValidUntil: string | null }>;
  apiToken?: string | null;
  // Escape hatch for local dev/tests: allow starting WITHOUT auth. Must be set
  // explicitly — otherwise a missing apiToken is a hard error (fail-closed), so
  // an unauthenticated money/admin surface can never be brought up by accident.
  allowNoAuth?: boolean;
  publicPath?: string;
  // Global rate limit. Omit for sane defaults; pass `false` to disable (used in tests).
  rateLimit?: { max?: number; timeWindow?: number | string } | false;
}

const urlBody = z.object({
  url: z.string(),
  plan: z.string().optional(),
  maxPriceJPY: z.number().optional(),
});

// Paths reachable without the bearer token.
const OPEN_PATHS = new Set(['/health', '/']);

export function buildServer(deps: Deps): FastifyInstance {
  // Fail closed: refuse to build a server that would leave every admin/money/
  // session/research route unauthenticated. Opting out requires an explicit flag.
  if (!deps.apiToken && !deps.allowNoAuth) {
    throw new Error('API_TOKEN is required to start the server (set ALLOW_NO_AUTH=1 to run unauthenticated for local dev only)');
  }

  const app = Fastify({ logger: false });
  const publicPath = deps.publicPath ?? 'packages/api/public/index.html';

  // Throttle abuse. Runs on the onRequest hook, i.e. BEFORE the auth check below,
  // so unauthenticated floods are capped too. Keyed by client IP.
  //
  // Registered on the root instance up front; the routes below live in a child
  // plugin registered AFTER it. Plugins load sequentially, so the limiter's
  // global onRequest hook is in place before the routes bind (a hook registered
  // after a route never runs for that route). Root hooks are inherited by the
  // child context, so every route is covered.
  if (deps.rateLimit !== false) {
    app.register(rateLimit, {
      max: deps.rateLimit?.max ?? 120,
      timeWindow: deps.rateLimit?.timeWindow ?? '1 minute',
      // statusCode is required here or the plugin falls back to a 500.
      errorResponseBuilder: (_req, ctx) => ({ statusCode: ctx.statusCode, error: 'rate_limited' }),
    });
  }

  app.register(async (instance) => {
    if (deps.apiToken) {
      const expected = `Bearer ${deps.apiToken}`;
      instance.addHook('preHandler', async (req, reply) => {
        const path = req.url.split('?')[0];
        if (req.method === 'GET' && OPEN_PATHS.has(path)) return;
        const header = req.headers['authorization'];
        if (typeof header !== 'string' || !safeEqual(header, expected)) {
          return reply.code(401).send({ error: 'unauthorized' });
        }
      });
    }

    instance.get('/', async (_req, reply) => {
      const html = await readFile(publicPath, 'utf8').catch(() => '<h1>frontend missing</h1>');
      return reply.type('text/html').send(html);
    });

    instance.get('/health', async () => ({ ok: true }));

    instance.get('/session', async () => deps.session.isAlive());

    instance.post('/session/login', async () => {
      // login blocks on human interaction; don't await it here
      void deps.session.login();
      return { started: true };
    });

    instance.post('/session/logout', async () => {
      await deps.session.logout();
      return { ok: true };
    });

    // Receive freshly-captured cookies (from the browser extension) and persist
    // them as the active session. Body: { cookies: [...] }.
    instance.post('/session/import', async (req, reply) => {
      if (!deps.importSession) return reply.code(501).send({ error: 'not_supported' });
      const cookies = (req.body as { cookies?: unknown })?.cookies;
      if (!Array.isArray(cookies) || cookies.length === 0) return reply.code(400).send({ error: 'bad_request' });
      try {
        return await deps.importSession(cookies);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    instance.post('/item/preview', async (req, reply) => {
      const parsed = urlBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
      let url: string;
      try { url = normalizeMercariUrl(parsed.data.url); }
      catch { return reply.code(400).send({ error: 'invalid_mercari_url' }); }
      try { return await deps.client.preview(url); }
      catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    });

    instance.post('/item/buy', async (req, reply) => {
      const parsed = urlBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
      let url: string;
      try { url = normalizeMercariUrl(parsed.data.url); }
      catch { return reply.code(400).send({ error: 'invalid_mercari_url' }); }

      if (deps.purchases.isBought(url)) return reply.code(409).send({ error: 'already_bought' });

      try {
        const result = await deps.client.buy(url, { plan: parsed.data.plan, maxPriceJPY: parsed.data.maxPriceJPY });
        if (result.status === 'bought') deps.purchases.record({ telegramId: 0, mercariUrl: url, priceJpy: 0, costRub: 0, status: 'bought' });
        return result;
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    });

    // --- Admin routes (require users + balances deps) ---
    if (deps.users && deps.balances) registerAdmin(instance, { users: deps.users, balances: deps.balances });

    // --- Research logs (read-only) ---
    instance.get('/research/runs', async (req) => {
      if (!deps.research) return [];
      const limit = Number((req.query as { limit?: string })?.limit ?? 50);
      return deps.research.recent(limit);
    });

    instance.get('/research/runs/:runId', async (req, reply) => {
      if (!deps.research) return reply.code(404).send({ error: 'not_found' });
      const { runId } = req.params as { runId: string };
      const run = await deps.research.getRun(runId);
      if (!run) return reply.code(404).send({ error: 'not_found' });
      return run;
    });
  });

  return app;
}
