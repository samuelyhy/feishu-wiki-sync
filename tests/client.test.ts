import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeishuApiError, QuotaExhaustedError } from '../src/errors.js';
import type { TenantTokenProvider } from '../src/feishu/auth.js';
import { FeishuClient } from '../src/feishu/client.js';
import { RateLimiter } from '../src/rate-limit.js';

/** 用固定 token 绕过真实鉴权。 */
const stubToken = { get: async () => 't-test' } as unknown as TenantTokenProvider;

function makeClient(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: { readPerSecond?: number; writePerSecond?: number } = {},
): FeishuClient {
  return new FeishuClient({
    tokenProvider: stubToken,
    limiter: new RateLimiter({ readPerSecond: 1000, writePerSecond: 1000, ...overrides }),
    baseUrl: 'https://example.test/open-apis',
    fetchImpl: ((url: string, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch,
    maxRetries: 2,
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

describe('FeishuClient.request', () => {
  it('成功时返回 data 字段', async () => {
    const client = makeClient(async () => json({ code: 0, msg: 'ok', data: { value: 42 } }));
    const data = await client.request<{ value: number }>('/x');
    assert.equal(data.value, 42);
  });

  it('HTTP 200 但 code != 0 也要报错 —— 只看 response.ok 会漏掉绝大多数飞书错误', async () => {
    const client = makeClient(async () => json({ code: 131006, msg: 'permission denied' }, 200));
    await assert.rejects(
      () => client.request('/x'),
      (err: unknown) => err instanceof FeishuApiError && err.code === 131006,
    );
  });

  it('携带 Authorization 头', async () => {
    let seen = '';
    const client = makeClient(async (_url, init) => {
      seen = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      return json({ code: 0, msg: '', data: {} });
    });
    await client.request('/x');
    assert.equal(seen, 'Bearer t-test');
  });

  it('把 query 参数拼进 URL，并跳过 undefined', async () => {
    let seen = '';
    const client = makeClient(async (url) => {
      seen = url;
      return json({ code: 0, msg: '', data: {} });
    });
    await client.request('/x', { query: { a: 1, b: undefined, c: 'z' } });
    assert.match(seen, /a=1/);
    assert.match(seen, /c=z/);
    assert.doesNotMatch(seen, /b=/);
  });

  it('99991403（配额耗尽）抛出专门的错误并中止，绝不重试', async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return json({ code: 99991403, msg: 'quota exceeded' }, 429);
    });

    await assert.rejects(() => client.request('/x'), QuotaExhaustedError);
    assert.equal(calls, 1, '配额耗尽重试只会徒劳敲门');
  });

  it('99991400（限流）会重试', async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      if (calls === 1) return json({ code: 99991400, msg: 'too many' }, 400);
      return json({ code: 0, msg: '', data: { ok: true } });
    });

    const data = await client.request<{ ok: boolean }>('/x');
    assert.equal(data.ok, true);
    assert.equal(calls, 2);
  });

  it('尊重服务端给出的 x-ogw-ratelimit-reset', async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      if (calls === 1) {
        return json({ code: 99991400, msg: 'slow down' }, 429, {
          'x-ogw-ratelimit-reset': '0.2',
        });
      }
      return json({ code: 0, msg: '', data: {} });
    });

    const started = Date.now();
    await client.request('/x');
    const elapsed = Date.now() - started;
    // 服务端要求 0.2s + 250ms 余量；不该立刻重试，也不该退避到几秒
    assert.ok(elapsed >= 200, `应至少等待服务端要求的时长，实际 ${elapsed}ms`);
    assert.ok(elapsed < 3000, `不该过度退避，实际 ${elapsed}ms`);
  });

  it('不可重试的错误码立刻失败', async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return json({ code: 1770033, msg: 'content size exceed limit' }, 400);
    });

    await assert.rejects(() => client.request('/x'), FeishuApiError);
    assert.equal(calls, 1, '内容超限重试一万次结果也一样');
  });

  it('重试耗尽后抛出带路径的错误', async () => {
    const client = makeClient(async () => json({ code: 99991400, msg: 'always busy' }, 429));
    await assert.rejects(
      () => client.request('/the/path'),
      (err: unknown) => err instanceof FeishuApiError && err.path === '/the/path',
    );
  });

  it('非 JSON 响应给出可诊断的错误而不是崩溃', async () => {
    const client = makeClient(async () => new Response('<html>502</html>', { status: 502 }));
    await assert.rejects(() => client.request('/x'), FeishuApiError);
  });

  it('错误信息里带上 request_id，便于找飞书技术支持', async () => {
    const client = makeClient(async () =>
      json({ code: 131006, msg: 'denied' }, 400, { 'x-tt-logid': 'LOG-123' }),
    );
    await assert.rejects(
      () => client.request('/x'),
      (err: unknown) => err instanceof FeishuApiError && err.requestId === 'LOG-123',
    );
  });
});
