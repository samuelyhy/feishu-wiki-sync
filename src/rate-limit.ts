/**
 * 飞书限流的三层约束，缺一层就会在生产上撞 429：
 *
 * 1. **单应用写类 3 次/秒** —— 创建/嵌套/更新/批量更新/删除块共用。
 * 2. **单篇文档并发编辑 3 次/秒** —— 跨该文档的所有写操作共用。
 * 3. **全局暂停** —— 服务端通过 `x-ogw-ratelimit-reset` 告知的等待时长，
 *    这期间**所有**请求都该停，而不是只停当前这个。
 *
 * 第 2 条最容易被忽略：只做全局限流的话，并行同步多篇文档时每篇都很快，
 * 但同一篇文档内部频繁改写仍会撞 429。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** 需要等待多少毫秒才能取到 n 个令牌（0 表示可立即取）。 */
  waitTimeFor(n = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    const deficit = n - this.tokens;
    return Math.ceil((deficit / this.refillPerSecond) * 1000);
  }

  consume(n = 1): void {
    this.refill();
    this.tokens -= n;
  }
}

export class RateLimiter {
  /** 写类：单应用 3 次/秒 */
  private readonly globalWrite: TokenBucket;
  /** 读类：5 次/秒 */
  private readonly globalRead: TokenBucket;
  /** 每篇文档独立的写桶（并发编辑上限 3 次/秒） */
  private readonly perDoc: Map<string, TokenBucket> = new Map();
  /** 服务端要求的全局暂停截止时间 */
  private pauseUntil = 0;

  constructor(opts: { writePerSecond?: number; readPerSecond?: number } = {}) {
    // 容量取 1：允许突发没有意义，飞书的限制是稳态的
    this.globalWrite = new TokenBucket(1, opts.writePerSecond ?? 3);
    this.globalRead = new TokenBucket(1, opts.readPerSecond ?? 5);
  }

  /** 服务端要求退避时调用，暂停所有后续请求。 */
  pauseFor(ms: number): void {
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + ms);
  }

  private docBucket(docId: string): TokenBucket {
    let b = this.perDoc.get(docId);
    if (!b) {
      b = new TokenBucket(1, 3);
      this.perDoc.set(docId, b);
    }
    return b;
  }

  async acquire(kind: 'read' | 'write', docId?: string): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pauseUntil) {
        await sleep(Math.min(this.pauseUntil - now, 1000));
        continue;
      }

      const bucket = kind === 'write' ? this.globalWrite : this.globalRead;
      const globalWait = bucket.waitTimeFor(1);
      const docWait = kind === 'write' && docId ? this.docBucket(docId).waitTimeFor(1) : 0;
      const wait = Math.max(globalWait, docWait);

      if (wait <= 0) {
        bucket.consume(1);
        if (kind === 'write' && docId) this.docBucket(docId).consume(1);
        return;
      }
      await sleep(Math.min(wait, 1000));
    }
  }
}
