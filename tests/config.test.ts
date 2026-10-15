import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig } from '@arhip/core';

describe('loadConfig', () => {
  beforeEach(() => {
    process.env.JSUB_USERNAME = 'u';
    process.env.JSUB_PASSWORD = 'p';
  });

  it('reads defaults and credentials', () => {
    const c = loadConfig();
    expect(c.baseUrl).toBe('https://www.j-subculture.com');
    expect(c.port).toBeGreaterThan(0);
    expect(c.credentials).toEqual({ username: 'u', password: 'p' });
  });

  it('throws when credentials are missing', () => {
    delete process.env.JSUB_USERNAME;
    expect(() => loadConfig()).toThrow(/JSUB_USERNAME/);
  });
});
