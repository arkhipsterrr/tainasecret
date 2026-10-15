import { describe, it, expect } from 'vitest';
import { classifyAlive } from '../packages/core/src/session/alive.ts';

const MYPAGE = 'https://www.j-subculture.com/en/users/mypage/';
const LOGIN = 'https://www.j-subculture.com/en/users/login';

describe('classifyAlive', () => {
  it('authenticated My Page → logged in', () => {
    expect(classifyAlive({
      status: 200,
      finalUrl: MYPAGE,
      bodyText: 'My Page\nYour User Status\nPROXY SHOPPING\nYour Account Rank',
    })).toEqual({ loggedIn: true, reason: 'ok' });
  });

  it('WAF 403 that does NOT redirect → waf_blocked, not logged in (the bug)', () => {
    expect(classifyAlive({
      status: 403,
      finalUrl: MYPAGE,
      bodyText: 'Forbidden access',
    })).toEqual({ loggedIn: false, reason: 'waf_blocked' });
  });

  it('SiteGuard body marker even on a 200 → waf_blocked', () => {
    expect(classifyAlive({
      status: 200,
      finalUrl: MYPAGE,
      bodyText: 'Forbidden access. SiteGuard',
    })).toEqual({ loggedIn: false, reason: 'waf_blocked' });
  });

  it('expired session redirects to login → logged_out', () => {
    expect(classifyAlive({
      status: 200,
      finalUrl: LOGIN,
      bodyText: 'Please log in',
    })).toEqual({ loggedIn: false, reason: 'logged_out' });
  });

  it('reachable page with no authenticated markers → unknown, not logged in', () => {
    expect(classifyAlive({
      status: 200,
      finalUrl: MYPAGE,
      bodyText: 'Some unexpected page',
    })).toEqual({ loggedIn: false, reason: 'unknown' });
  });
});
