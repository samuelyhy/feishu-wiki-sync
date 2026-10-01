import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RateLimiter, TokenBucket } from '../src/rate-limit.js';

describe('TokenBucket', () => {
  it('容量未耗尽时无需等待', () => {
    const bucket = new TokenBucket(1, 10);
    assert.equal(bucket.waitTimeFor(1), 0);
  });

  it('耗尽后按补充速率给出等待时长', () => {
    const bucket = new TokenBucket(1, 10); // 10 个/秒 => 每 100ms 一个
    bucket.consume(1);
    const wait = bucket.waitTimeFor(1);
    assert.ok(wait > 0 && wait <= 100, `等待应在 100ms 内，实际 ${wait}ms`);
  });

  it('等待后会补充令牌', async () => {
    const bucket = new TokenBucket(1, 50); // 20ms 一个
    bucket.consume(1);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(bucket.waitTimeFor(1), 0);
  });
});

describe('RateLimiter', () => {
  it('写类请求受限流约束', async () => {
    const limiter = new RateLimiter({ writePerSecond: 20 }); // 50ms 一次
    const started = Date.now();
    await limiter.acquire('write');
    await limiter.acquire('write');
    await limiter.acquire('write');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 90, `三次写应耗时约 100ms，实际 ${elapsed}ms`);
  });

  it('读类与写类使用彼此独立的桶', async () => {
    // 写桶设得极慢，读桶设得极快 —— 读请求不该被写限流拖住
    const limiter = new RateLimiter({ writePerSecond: 0.5, readPerSecond: 1000 });
    const started = Date.now();
    await limiter.acquire('read');
    await limiter.acquire('read');
    assert.ok(Date.now() - started < 100, '读请求不该被写桶的速率影响');
  });

  it('同一文档的并发编辑受独立限流 —— 只做全局限流会漏掉这条', async () => {
    const limiter = new RateLimiter({ writePerSecond: 1000 });
    const started = Date.now();
    // 同一文档连续三次写：每文档上限 3 次/秒 => 约 666ms
    await limiter.acquire('write', 'doc1');
    await limiter.acquire('write', 'doc1');
    await limiter.acquire('write', 'doc1');
    assert.ok(Date.now() - started >= 550, '同一文档的写操作必须被单独限速');
  });

  it('不同文档的桶互不影响', async () => {
    const limiter = new RateLimiter({ writePerSecond: 1000 });
    const started = Date.now();
    await limiter.acquire('write', 'docA');
    await limiter.acquire('write', 'docB');
    await limiter.acquire('write', 'docC');
    assert.ok(Date.now() - started < 300, '不同文档之间不该互相阻塞');
  });

  it('pauseFor 会阻塞后续所有请求（服务端要求全局暂停）', async () => {
    const limiter = new RateLimiter({ writePerSecond: 1000, readPerSecond: 1000 });
    limiter.pauseFor(200);

    const started = Date.now();
    await limiter.acquire('read');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 180, `暂停期间连读请求也该等，实际 ${elapsed}ms`);
  });

  it('pauseFor 只延长不缩短已有的暂停', async () => {
    const limiter = new RateLimiter({ writePerSecond: 1000 });
    limiter.pauseFor(300);
    limiter.pauseFor(50); // 更短的请求不该把已经生效的长暂停缩回去

    const started = Date.now();
    await limiter.acquire('write');
    assert.ok(Date.now() - started >= 250, '较短的新暂停请求不该缩短已有的暂停');
  });
});
