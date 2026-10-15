import { describe, it, expect, vi } from 'vitest';
import { cookieHeaderFromState, socksTarget, startKeepAlive, makeCookieJar, fetchWithJar } from '../src/jsub/raw-transport.ts';

describe('makeCookieJar', () => {
  it('seeds from a Cookie header and renders it back', () => {
    const jar = makeCookieJar('sid=abc; EtVer8RuyKL5=xyz');
    expect(jar.header()).toBe('sid=abc; EtVer8RuyKL5=xyz');
  });

  it('applies a Set-Cookie, overwriting the rotated value (name=newval)', () => {
    const jar = makeCookieJar('EtVer8RuyKL5=old; other=keep');
    jar.apply(['EtVer8RuyKL5=new; expires=Sat, 17-Oct-2026 12:55:06 GMT; Max-Age=2592000; path=/; domain=.j-subculture.com; secure; HttpOnly']);
    expect(jar.header()).toBe('EtVer8RuyKL5=new; other=keep');
  });

  it('adds a brand-new cookie from Set-Cookie', () => {
    const jar = makeCookieJar('a=1');
    jar.apply(['b=2; path=/']);
    expect(jar.header()).toBe('a=1; b=2');
  });
});

// A fake transport whose per-hop responses are scripted, capturing the exact
// Cookie header it was CALLED with so we can assert the jar threaded the rotated
// value onto the next hop.
function scriptedFetch(hops: Array<{ status: number; location?: string; setCookie?: string[]; body?: string }>) {
  const sentCookies: string[] = [];
  let i = 0;
  const fn = vi.fn(async (_url: string, init?: any) => {
    sentCookies.push(init?.headers?.cookie ?? '');
    const h = hops[Math.min(i, hops.length - 1)];
    i++;
    return {
      status: h.status,
      url: _url,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'location' ? h.location ?? null : null),
        getSetCookie: () => h.setCookie ?? [],
      },
      text: async () => h.body ?? '',
      body: { cancel: async () => {} },
    };
  });
  return { fn, sentCookies };
}

describe('fetchWithJar', () => {
  it('threads the rotated cookie from each response onto the next redirect hop', async () => {
    const jar = makeCookieJar('EtVer8RuyKL5=seed');
    const { fn, sentCookies } = scriptedFetch([
      // POST rotates the cookie and 302s to -fin
      { status: 302, location: 'https://x/en/shoppings/mercari-direct-purchase-fin/', setCookie: ['EtVer8RuyKL5=rot1; path=/'] },
      // -fin GET must carry rot1; returns the success page and rotates again
      { status: 200, setCookie: ['EtVer8RuyKL5=rot2; path=/'], body: 'Successfully purchased the item on Mercari.' },
    ]);
    const res = await fetchWithJar(fn, 'https://x/en/shoppings/mercari-direct-purchase', { method: 'POST', headers: {}, body: 'plan=1' }, jar);

    expect(sentCookies[0]).toBe('EtVer8RuyKL5=seed');   // hop 0 uses the seed
    expect(sentCookies[1]).toBe('EtVer8RuyKL5=rot1');   // hop 1 carries the rotated cookie (the fix)
    expect(res.status).toBe(200);
    expect(res.url).toBe('https://x/en/shoppings/mercari-direct-purchase-fin/'); // final landed URL, NOT login
    expect(await res.text()).toContain('Successfully purchased');
    expect(jar.header()).toBe('EtVer8RuyKL5=rot2');      // jar left holding the latest token
  });

  it('downgrades POST to GET on a 302 (no body replay)', async () => {
    const jar = makeCookieJar('a=1');
    const { fn } = scriptedFetch([
      { status: 302, location: 'https://x/next' },
      { status: 200, body: 'ok' },
    ]);
    await fetchWithJar(fn, 'https://x/post', { method: 'POST', headers: {}, body: 'k=v' }, jar);
    // second hop must be a GET with no body
    expect(fn.mock.calls[1][1]).toMatchObject({ method: 'GET' });
    expect(fn.mock.calls[1][1].body).toBeUndefined();
  });

  it('returns the first non-redirect response as-is', async () => {
    const jar = makeCookieJar('a=1');
    const { fn } = scriptedFetch([{ status: 200, body: 'hello' }]);
    const res = await fetchWithJar(fn, 'https://x/', { headers: {} }, jar);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('cookieHeaderFromState', () => {
  const state = {
    cookies: [
      { name: 'sid', value: 'abc', domain: 'www.j-subculture.com' },
      { name: 'EtVer8RuyKL5', value: 'xyz', domain: '.j-subculture.com' },
      { name: 'ga', value: '111', domain: '.google-analytics.com' },
    ],
  };

  it('joins only j-subculture cookies into a Cookie header', () => {
    expect(cookieHeaderFromState(state)).toBe('sid=abc; EtVer8RuyKL5=xyz');
  });

  it('returns an empty string when there are no cookies', () => {
    expect(cookieHeaderFromState({ cookies: [] })).toBe('');
    expect(cookieHeaderFromState({})).toBe('');
  });
});

describe('socksTarget', () => {
  it('parses a socks5 url', () => {
    expect(socksTarget('socks5://127.0.0.1:1080')).toEqual({ type: 5, host: '127.0.0.1', port: 1080 });
  });

  it('treats socks5h as socks5', () => {
    expect(socksTarget('socks5h://10.0.0.2:9050')).toEqual({ type: 5, host: '10.0.0.2', port: 9050 });
  });

  it('parses a socks4 url', () => {
    expect(socksTarget('socks4://127.0.0.1:1080')).toEqual({ type: 4, host: '127.0.0.1', port: 1080 });
  });

  it('returns null for empty or non-socks proxies (use a direct connection)', () => {
    expect(socksTarget(null)).toBeNull();
    expect(socksTarget('')).toBeNull();
    expect(socksTarget('http://proxy:8080')).toBeNull();
  });
});

describe('startKeepAlive', () => {
  it('pings the url with HEAD on each interval and stops when told', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(async (_url: string, _init?: any) => ({ status: 200, url: 'u', text: async () => '' }));
      const stop = startKeepAlive(fetchFn, 'https://x/', 1000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(fetchFn.mock.calls[0][0]).toBe('https://x/');
      expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });

      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchFn).toHaveBeenCalledTimes(3); // no pings after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps pinging even if a ping rejects (never throws out of the timer)', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(async () => { throw new Error('down'); });
      const stop = startKeepAlive(fetchFn, 'https://x/', 1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
