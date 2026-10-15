import { describe, it, expect } from 'vitest';
import { requestEntry, responseEntry, shouldCaptureBody } from '../src/jsub/netlog.ts';

const ts = '2026-09-13T00:00:00.000Z';

function fakeReq(o: { method: string; url: string; resType: string; post?: string | null }) {
  return {
    method: () => o.method,
    url: () => o.url,
    resourceType: () => o.resType,
    postData: () => o.post ?? null,
  };
}

function fakeResp(o: { status: number; statusText: string; url: string; method: string; resType: string }) {
  return {
    status: () => o.status,
    statusText: () => o.statusText,
    url: () => o.url,
    request: () => ({ method: () => o.method, resourceType: () => o.resType }),
  };
}

describe('requestEntry', () => {
  it('captures method, url, resource type and truncated post body', () => {
    const req = fakeReq({ method: 'POST', url: 'https://j-subculture.com/order', resType: 'document', post: 'a'.repeat(5000) });
    const e = requestEntry(ts, req);
    expect(e).toMatchObject({ ts, kind: 'request', method: 'POST', url: 'https://j-subculture.com/order', resType: 'document' });
    expect(e.post).toHaveLength(3000);
  });

  it('records a null post body when the request has none', () => {
    const e = requestEntry(ts, fakeReq({ method: 'GET', url: 'https://j-subculture.com/x', resType: 'xhr' }));
    expect(e.post).toBeNull();
  });
});

describe('shouldCaptureBody', () => {
  it('captures the body of error responses', () => {
    expect(shouldCaptureBody(500, 'GET')).toBe(true);
    expect(shouldCaptureBody(404, 'GET')).toBe(true);
  });
  it('captures the body of any POST (the purchase submit)', () => {
    expect(shouldCaptureBody(200, 'POST')).toBe(true);
    expect(shouldCaptureBody(302, 'post')).toBe(true);
  });
  it('skips ordinary 2xx/3xx GET responses', () => {
    expect(shouldCaptureBody(200, 'GET')).toBe(false);
    expect(shouldCaptureBody(302, 'GET')).toBe(false);
  });
});

describe('responseEntry', () => {
  it('captures status, statusText and the request method/type from the response', () => {
    const resp = fakeResp({ status: 500, statusText: 'Internal Server Error', url: 'https://j-subculture.com/order', method: 'POST', resType: 'document' });
    const e = responseEntry(ts, resp, 'oops');
    expect(e).toMatchObject({
      ts, kind: 'response', method: 'POST', url: 'https://j-subculture.com/order',
      resType: 'document', status: 500, statusText: 'Internal Server Error', respBody: 'oops',
    });
    expect(e.post).toBeNull();
  });

  it('truncates a large response body to 3000 chars', () => {
    const resp = fakeResp({ status: 500, statusText: 'x', url: 'u', method: 'POST', resType: 'document' });
    expect(responseEntry(ts, resp, 'b'.repeat(5000)).respBody).toHaveLength(3000);
  });

  it('records a null body when none was captured', () => {
    const resp = fakeResp({ status: 200, statusText: 'OK', url: 'u', method: 'GET', resType: 'xhr' });
    expect(responseEntry(ts, resp, null).respBody).toBeNull();
  });
});
