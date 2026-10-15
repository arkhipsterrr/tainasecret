import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { socksDispatcher } from 'fetch-socks';
// IMPORTANT: use undici's OWN fetch, not Node's global fetch. A socks dispatcher
// built by fetch-socks (against its bundled undici) is rejected by the global
// fetch's separate undici instance → "fetch failed". Same-instance fetch works.
import { fetch as undiciFetch, Agent } from 'undici';
import { RawJsubClient, type RawFetch, type RawRecorder } from './raw-client.ts';

// Keep pooled connections open long enough that the background keep-alive ping
// (below) refreshes them before they idle out — so user ops skip the ~0.7s TLS
// handshake to Japan through the tunnel.
const KEEPALIVE = { keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000, connections: 8, pipelining: 1 };
const KEEPALIVE_PING_MS = 25_000;

interface StorageState {
  cookies?: Array<{ name: string; value: string; domain?: string }>;
}

/** Build a Cookie header from a Playwright storageState, j-subculture cookies only. */
export function cookieHeaderFromState(state: StorageState): string {
  return (state.cookies ?? [])
    .filter((c) => (c.domain ?? '').includes('j-subculture.com'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * A tiny cookie jar (name→value). j-subculture rotates the auth cookie
 * `EtVer8RuyKL5` on EVERY response; undici's fetch keeps no jar, so without this
 * the rotated value is dropped and the next request replays the now-invalidated
 * token → login. Seed from a Cookie header, `apply` each response's Set-Cookie,
 * `header()` for the next request.
 */
export interface CookieJar {
  header(): string;
  apply(setCookie: string[]): void;
}

export function makeCookieJar(seed: string): CookieJar {
  const jar = new Map<string, string>();
  for (const part of seed.split('; ')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    apply: (list: string[]) => {
      for (const sc of list ?? []) {
        const kv = sc.split(';')[0];
        const i = kv.indexOf('=');
        if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
    },
  };
}

/** A single redirect hop's response, as seen from the raw transport. */
export interface JarResponseLike {
  status: number;
  url: string;
  headers: { get(name: string): string | null; getSetCookie?: () => string[] };
  text(): Promise<string>;
  body?: { cancel?: () => Promise<void> } | null;
}
export type JarDoFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<JarResponseLike>;

/**
 * Follow redirects MANUALLY (undici's RedirectHandler has no cookie jar), so the
 * rotated auth cookie from each hop's Set-Cookie is carried onto the next hop —
 * the whole point: a buy POST → 302 `-fin` now reaches `-fin` authenticated
 * (success page + alert) instead of bouncing to login. `doFetch` MUST be called
 * with redirect:'manual'. Downgrades POST→GET on 301/302/303 (no body replay).
 */
export async function fetchWithJar(
  doFetch: JarDoFetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined,
  jar: CookieJar,
  maxRedirects = 10,
): Promise<{ status: number; url: string; text(): Promise<string> }> {
  let curUrl = url;
  let method = (init?.method ?? 'GET').toUpperCase();
  let body = init?.body;
  const baseHeaders = { ...(init?.headers ?? {}) };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const headers = { ...baseHeaders, cookie: jar.header() };
    const r = await doFetch(curUrl, { method, headers, body });
    jar.apply(r.headers.getSetCookie?.() ?? []);
    const loc = r.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
      const next = new URL(loc, curUrl).toString();
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      curUrl = next;
      try { await r.body?.cancel?.(); } catch { /* body may be unconsumable */ }
      continue;
    }
    const text = await r.text();
    return { status: r.status, url: curUrl, text: async () => text };
  }
  throw new Error('too_many_redirects');
}

export interface SocksTarget { type: 4 | 5; host: string; port: number }

/** Parse a socks proxy URL into a fetch-socks target, or null for direct/non-socks. */
export function socksTarget(proxyUrl: string | null): SocksTarget | null {
  if (!proxyUrl) return null;
  let u: URL;
  try { u = new URL(proxyUrl); } catch { return null; }
  const proto = u.protocol.replace(':', '').toLowerCase();
  if (proto === 'socks5' || proto === 'socks5h') return { type: 5, host: u.hostname, port: Number(u.port) };
  if (proto === 'socks4' || proto === 'socks4a') return { type: 4, host: u.hostname, port: Number(u.port) };
  return null;
}

/**
 * Owns the cookie jar for one raw client: seeds from the storageState file, RE-
 * SEEDS when the file changes externally (a fresh `/session/import`), and PERSISTS
 * the rotated auth cookie back so a later op / a bot restart keeps a live session.
 * NB: rotation makes the session single-owner — two clients (api-browser /session
 * vs bot-raw) sharing one storageState will invalidate each other's token.
 */
export interface JarStore {
  ensure(): CookieJar;
  jar(): CookieJar;
  persist(): void;
}
export function makeJarStore(storageStatePath: string): JarStore {
  let jar = makeCookieJar('');
  let knownMtime = -1; // mtime we last seeded FROM or wrote OURSELVES
  let seeded = false;
  const ensure = (): CookieJar => {
    let m = -1;
    try { m = statSync(storageStatePath).mtimeMs; } catch { return jar; }
    if (!seeded || m > knownMtime) {
      try {
        jar = makeCookieJar(cookieHeaderFromState(JSON.parse(readFileSync(storageStatePath, 'utf8'))));
        knownMtime = m;
        seeded = true;
      } catch { /* unreadable → keep whatever we have */ }
    }
    return jar;
  };
  const persist = (): void => {
    try {
      const state = JSON.parse(readFileSync(storageStatePath, 'utf8'));
      const cur = new Map(
        jar.header().split('; ').filter(Boolean).map((p) => {
          const i = p.indexOf('=');
          return [p.slice(0, i), p.slice(i + 1)] as [string, string];
        }),
      );
      let changed = false;
      for (const c of state.cookies ?? []) {
        const v = cur.get(c.name);
        if ((c.domain ?? '').includes('j-subculture.com') && v !== undefined && c.value !== v) {
          c.value = v;
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(storageStatePath, JSON.stringify(state));
        knownMtime = statSync(storageStatePath).mtimeMs; // don't treat our own write as external
      }
    } catch { /* best-effort */ }
  };
  return { ensure, jar: () => jar, persist };
}

/**
 * A RawFetch bound to the SOCKS tunnel when `proxyUrl` is a socks:// URL (so the
 * WAF sees the clean egress IP), else a direct fetch. With a `store`, every hop
 * goes through the cookie jar + MANUAL redirect following (fetchWithJar) so the
 * per-request rotated auth cookie is carried forward (incl. POST→-fin); rotations
 * are persisted after each call. Without a store, a plain redirect-following fetch.
 */
export function makeRawFetch(proxyUrl: string | null, store?: JarStore): RawFetch {
  const target = socksTarget(proxyUrl);
  const dispatcher = target
    ? socksDispatcher({ type: target.type, host: target.host, port: target.port }, KEEPALIVE)
    : new Agent(KEEPALIVE);
  if (!store) {
    return (url, init) =>
      undiciFetch(url, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher }) as unknown as ReturnType<RawFetch>;
  }
  const doFetch: JarDoFetch = (url, init) =>
    undiciFetch(url, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher, redirect: 'manual' }) as unknown as Promise<JarResponseLike>;
  return async (url, init) => {
    const jar = store.ensure();
    const res = await fetchWithJar(doFetch, url, init as { method?: string; headers?: Record<string, string>; body?: string }, jar);
    store.persist();
    return res as Awaited<ReturnType<RawFetch>>;
  };
}

/**
 * Keep a warm pooled connection to the origin by pinging `url` (HEAD) on an
 * interval shorter than keepAliveTimeout, so the TCP+TLS+socks handshake is
 * already done when a real preview/buy arrives. Returns a stop function. The
 * timer is unref'd so it never keeps the process alive; ping errors are ignored.
 */
export function startKeepAlive(fetchFn: RawFetch, url: string, intervalMs: number): () => void {
  const handle = setInterval(() => {
    Promise.resolve(fetchFn(url, { method: 'HEAD' })).catch(() => undefined);
  }, intervalMs);
  (handle as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
}

/** Build a browserless client that reads the session fresh from disk each call. */
export function createRawClient(
  cfg: { baseUrl: string; proxyUrl: string | null; storageStatePath: string },
  recorder?: RawRecorder,
): RawJsubClient {
  const store = makeJarStore(cfg.storageStatePath);
  const fetchFn = makeRawFetch(cfg.proxyUrl, store);
  // NOTE: no background keep-alive ping here — the server rotates the auth cookie
  // on every response, so an out-of-band ping would rotate the token out from
  // under an in-flight preview/buy. The pooled connection (keepAliveTimeout) still
  // avoids a cold TLS handshake within an active window.
  return new RawJsubClient(cfg.baseUrl, () => store.ensure().header(), fetchFn, recorder);
}
