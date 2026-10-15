import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TokenStore {
  /** The persisted token, or null if none is stored yet. */
  read(): string | null;
  /** Persist the token durably. */
  write(token: string): void;
}

export type TokenSource = 'env' | 'file' | 'generated';

/**
 * Resolve the API bearer token without ever leaving the server unauthenticated.
 * Precedence: an explicit env token wins; otherwise reuse the persisted one;
 * otherwise generate a strong random token and persist it. The generated case
 * is what lets a non-expert operator deploy without inventing a secret — the
 * server still never runs open.
 */
export function resolveApiToken(
  envToken: string | null | undefined,
  store: TokenStore,
  gen: () => string = () => randomBytes(32).toString('base64url'),
): { token: string; source: TokenSource } {
  if (envToken) return { token: envToken, source: 'env' };
  const existing = store.read();
  if (existing) return { token: existing, source: 'file' };
  const token = gen();
  store.write(token);
  return { token, source: 'generated' };
}

/**
 * A file-backed token store. Reads return null when the file is absent (a fresh
 * deploy), never a throw. Writes create the parent dir and restrict the file to
 * owner-only (0600) so the secret isn't world-readable on the host.
 */
export function fileTokenStore(path: string): TokenStore {
  return {
    read() {
      try {
        const raw = readFileSync(path, 'utf8').trim();
        return raw.length > 0 ? raw : null;
      } catch {
        return null; // ENOENT (or unreadable) → treat as "no token yet"
      }
    },
    write(token: string) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${token}\n`, { mode: 0o600 });
    },
  };
}
