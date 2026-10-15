import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ImportCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number; // unix seconds; -1 = session cookie
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

// Accepts both Playwright ('Strict'|'Lax'|'None') and Chrome
// ('strict'|'lax'|'no_restriction'|'unspecified') sameSite spellings.
function normSameSite(s?: string): 'Strict' | 'Lax' | 'None' {
  switch ((s ?? '').toLowerCase()) {
    case 'strict': return 'Strict';
    case 'none':
    case 'no_restriction': return 'None';
    case 'lax': return 'Lax';
    default: return 'Lax';
  }
}

/**
 * Convert a captured cookie array into a Playwright storageState file and write
 * it atomically (temp + rename), so a concurrent read never sees a partial file.
 * Returns how many cookies were written and, if present, when the login-status
 * cookie expires (the practical "session valid until").
 */
export async function writeStorageState(
  cookies: unknown,
  path: string,
): Promise<{ importedCookies: number; authValidUntil: string | null }> {
  if (!Array.isArray(cookies) || cookies.length === 0) throw new Error('invalid_cookies');

  const norm = cookies.map((c) => {
    const cc = c as ImportCookie;
    if (!cc || typeof cc.name !== 'string' || typeof cc.value !== 'string' || typeof cc.domain !== 'string') {
      throw new Error('invalid_cookies');
    }
    return {
      name: cc.name,
      value: cc.value,
      domain: cc.domain,
      path: typeof cc.path === 'string' ? cc.path : '/',
      expires: typeof cc.expires === 'number' ? cc.expires : -1,
      httpOnly: !!cc.httpOnly,
      secure: !!cc.secure,
      sameSite: normSameSite(cc.sameSite),
    };
  });

  const state = { cookies: norm, origins: [] as unknown[] };
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);

  // `[lgstatus]` is the stable-named login-status cookie (~30-day life).
  const lg = norm.find((c) => c.name.endsWith('[lgstatus]') && c.expires > 0);
  const authValidUntil = lg ? new Date(lg.expires * 1000).toISOString() : null;

  return { importedCookies: norm.length, authValidUntil };
}
