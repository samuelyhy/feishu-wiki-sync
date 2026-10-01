import { FeishuApiError, QuotaExhaustedError, friendlyMessage } from '../errors.js';
import { RateLimiter } from '../rate-limit.js';
import type { ApiRecorder } from '../record.js';
import { TenantTokenProvider, DEFAULT_BASE_URL } from './auth.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 把原始响应体转成可记录的形式：能解析成 JSON 就解析，否则原样存字符串。 */
function parseForRecord(raw: string): unknown {
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw.slice(0, 4096);
  }
}

/** 查询参数转成可序列化的形式（丢掉 undefined）。 */
function stringifyQuery(
  query: RequestOptions['query'] | undefined,
): Record<string, string> | undefined {
  if (!query) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 不可重试的错误码。
 *
 * 这份清单是「重试只会更糟」的集合：
 * - `99991403` 配额是**按月**耗尽的，重试徒劳且会继续烧日志与时间；
 * - `131006` / `1770032` 是权限问题，重试一万次也还是没权限；
 * - `1770033` / `1069909` / `1770004` 是内容超限，输入没变结果就不会变；
 * - `99991672` 是应用没开对应 scope。
 */
const NON_RETRYABLE_CODES = new Set([
  99991403, 131006, 1770032, 1770033, 1069909, 1770004, 1770005, 1770006, 1770007, 99991672,
]);

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 写类请求需要传文档 id，用于单文档并发限流 */
  docId?: string;
  /** 覆盖自动判定的读/写分类 */
  kind?: 'read' | 'write';
}

export interface FeishuClientOptions {
  tokenProvider: TenantTokenProvider;
  limiter: RateLimiter;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  onRetry?: (info: { attempt: number; waitMs: number; reason: string }) => void;
  /** 旁路观测：把每次交互落盘（见 record.ts）。不传则完全不产生额外开销。 */
  recorder?: ApiRecorder;
}

export class FeishuClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(private readonly opts: FeishuClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 5;
  }

  get limiter(): RateLimiter {
    return this.opts.limiter;
  }

  /**
   * 发起一次 JSON 请求，返回 `data` 字段的内容。
   *
   * 飞书的错误有两种形态：HTTP 非 2xx，以及 **HTTP 200 但 `code != 0`**。
   * 只判 `response.ok` 会漏掉后者 —— 这是接入飞书最常见的坑之一。
   */
  async request<T = Record<string, unknown>>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase();
    const kind = options.kind ?? (method === 'GET' || method === 'HEAD' ? 'read' : 'write');

    // 鉴权放在重试循环**之外**。
    //
    // 取 token 失败（凭证错、配额耗尽、连不上鉴权端点）与「本次请求失败」
    // 是两回事：前者重试多少次结果都一样，把它放进循环里会被当成网络错误
    // 退避重试 5 次 —— 先白等 30 多秒，最后还报一个指向网络的误导性错误，
    // 让人去查根本不存在的网络问题。
    const headers = await this.headers(options.body !== undefined);

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.opts.limiter.acquire(kind, options.docId);

      let response: Response;
      const startedAt = Date.now();
      try {
        response = await this.fetchImpl(this.buildUrl(path, options.query), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (err) {
        lastError = err;
        if (attempt === this.maxRetries) {
          throw new FeishuApiError({
            status: 0,
            code: -1,
            message: `网络请求失败: ${friendlyMessage(err)}`,
            path,
          });
        }
        await this.backoff(attempt, `网络错误: ${friendlyMessage(err)}`);
        continue;
      }

      const raw = await response.text();

      // 录制放在解析之前：解析失败（返回非 JSON）时，原始响应正是最该被看到的东西
      this.opts.recorder?.record({
        method,
        path,
        ...(options.query ? { query: stringifyQuery(options.query) } : {}),
        status: response.status,
        durationMs: Date.now() - startedAt,
        ...(options.body !== undefined ? { requestBody: options.body } : {}),
        ...(parseForRecord(raw) !== undefined
          ? { responseBody: parseForRecord(raw), responseBytes: raw.length }
          : {}),
        ...(response.headers.get('x-tt-logid')
          ? { requestId: response.headers.get('x-tt-logid')! }
          : {}),
      });

      const payload = this.parseEnvelope(raw, response.status, path);

      // 先处理配额耗尽 —— 它必须冒泡成 QuotaExhaustedError（退出码 4），
      // 不能被下面的通用重试逻辑吞掉。
      if (payload.code === 99991403) {
        throw new QuotaExhaustedError(
          '飞书 API 本月调用量已耗尽（99991403）。本次同步中止；请等待次月刷新或申请提额。',
        );
      }

      const retryable =
        // 先排除不可重试的业务错误：某些内容类错误（如块数超限）可能带上 5xx
        // 状态码，只按状态码判断会把「输入没变、结果永远不会变」的错误反复重试。
        !NON_RETRYABLE_CODES.has(payload.code) &&
        (response.status === 429 || response.status >= 500 || payload.code === 99991400);

      if (retryable) {
        const wait = this.serverRequestedWait(response) ?? this.backoffMs(attempt);
        // 服务端明确要求暂停时，暂停**所有**请求而不只是当前这个：
        // 单应用限流是全局限额，只退避当前请求毫无意义。
        this.opts.limiter.pauseFor(wait);
        if (attempt === this.maxRetries) {
          throw new FeishuApiError({
            status: response.status,
            code: payload.code,
            message: `持续限流，已重试 ${this.maxRetries} 次仍失败: ${payload.msg}`,
            requestId: response.headers.get('x-tt-logid') ?? undefined,
            path,
          });
        }
        this.opts.onRetry?.({
          attempt: attempt + 1,
          waitMs: wait,
          reason: `HTTP ${response.status} / code ${payload.code}`,
        });
        await sleep(wait);
        continue;
      }

      if (!response.ok || payload.code !== 0) {
        // 响应体为空时 `parseEnvelope` 会给出 code 0 —— 直接用它会让
        // 「HTTP 502 且无响应体」变成一个 code=0、message 为空的错误，
        // 打印出来只有「飞书接口错误 0（HTTP 502）: 」，毫无信息。
        const emptyBody = raw.trim() === '';
        throw new FeishuApiError({
          status: response.status,
          code: emptyBody ? response.status : (payload.code ?? -1),
          message: emptyBody
            ? `飞书返回空响应体（HTTP ${response.status}）`
            : (payload.msg ?? raw.slice(0, 300)),
          requestId: response.headers.get('x-tt-logid') ?? undefined,
          path,
        });
      }

      return (payload.data ?? {}) as T;
    }

    throw new FeishuApiError({
      status: 0,
      code: -1,
      message: `重试耗尽: ${friendlyMessage(lastError)}`,
      path,
    });
  }

  /**
   * 下载二进制内容（素材/文件）。
   *
   * 不能复用 `request()`：那条路会把响应体当 JSON 解析，而这里成功时返回的是
   * 图片字节。错误时飞书**仍然返回 JSON**（`{code,msg}`），所以要先看
   * Content-Type 再决定怎么读 —— 否则失败了只会得到一段「非 JSON」的
   * 二进制乱码，看不出真正原因。
   */
  async download(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ content: Buffer; contentType: string }> {
    const kind = options.kind ?? 'read';
    const headers = await this.headers(false);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.opts.limiter.acquire(kind, options.docId);

      let response: Response;
      const startedAt = Date.now();
      try {
        response = await this.fetchImpl(this.buildUrl(path, options.query), {
          method: 'GET',
          headers,
        });
      } catch (err) {
        if (attempt === this.maxRetries) {
          throw new FeishuApiError({
            status: 0,
            code: -1,
            message: `下载失败: ${friendlyMessage(err)}`,
            path,
          });
        }
        await this.backoff(attempt, `网络错误: ${friendlyMessage(err)}`);
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      const buffer = Buffer.from(await response.arrayBuffer());

      // 二进制内容只记元信息：字节本身对排查没有价值，且会把文件撑爆
      this.opts.recorder?.record({
        method: 'GET',
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        responseBody: {
          contentType,
          bytes: buffer.byteLength,
          ...(contentType.includes('application/json')
            ? { json: parseForRecord(buffer.toString('utf8')) }
            : {}),
        },
      });

      // 错误路径：飞书用 JSON 表达失败
      if (!response.ok || contentType.includes('application/json')) {
        const payload = this.tryParseJson(buffer.toString('utf8'));

        if (payload?.code === 99991403) {
          throw new QuotaExhaustedError('飞书 API 本月调用量已耗尽（99991403）。');
        }

        const retryable =
          !NON_RETRYABLE_CODES.has(payload?.code ?? -1) &&
          (response.status === 429 || response.status >= 500 || payload?.code === 99991400);

        if (retryable && attempt < this.maxRetries) {
          const wait = this.serverRequestedWait(response) ?? this.backoffMs(attempt);
          this.opts.limiter.pauseFor(wait);
          await sleep(wait);
          continue;
        }

        throw new FeishuApiError({
          status: response.status,
          code: payload?.code ?? -1,
          message: payload?.msg ?? `下载失败（HTTP ${response.status}）`,
          requestId: response.headers.get('x-tt-logid') ?? undefined,
          path,
        });
      }

      return { content: buffer, contentType };
    }

    throw new FeishuApiError({ status: 0, code: -1, message: '下载重试耗尽', path });
  }

  private tryParseJson(raw: string): { code?: number; msg?: string } | null {
    try {
      return JSON.parse(raw) as { code?: number; msg?: string };
    } catch {
      return null;
    }
  }

  /** 素材上传：multipart/form-data。返回 data 字段。 */
  async upload<T = Record<string, unknown>>(
    path: string,
    form: FormData,
    options: RequestOptions = {},
  ): Promise<T> {
    const kind = options.kind ?? 'write';

    // 同 request()：鉴权失败不该被当成请求失败重试。
    // 注意：绝不能手动设置 Content-Type —— multipart 的 boundary 由
    // FormData/undici 生成，手写会导致服务端无法解析。
    const headers = { Authorization: `Bearer ${await this.token()}` };

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.opts.limiter.acquire(kind, options.docId);

      let response: Response;
      const startedAt = Date.now();
      try {
        response = await this.fetchImpl(this.buildUrl(path, options.query), {
          method: 'POST',
          headers,
          body: form,
        });
      } catch (err) {
        lastError = err;
        if (attempt === this.maxRetries) {
          throw new FeishuApiError({
            status: 0,
            code: -1,
            message: `上传失败: ${friendlyMessage(err)}`,
            path,
          });
        }
        await this.backoff(attempt, `网络错误: ${friendlyMessage(err)}`);
        continue;
      }

      const raw = await response.text();

      // multipart 的请求体不记录：它是二进制、体积大，且没有复用价值
      this.opts.recorder?.record({
        method: 'POST',
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        ...(parseForRecord(raw) !== undefined
          ? { responseBody: parseForRecord(raw), responseBytes: raw.length }
          : {}),
        ...(response.headers.get('x-tt-logid')
          ? { requestId: response.headers.get('x-tt-logid')! }
          : {}),
      });

      const payload = this.parseEnvelope(raw, response.status, path);

      if (payload.code === 99991403) {
        throw new QuotaExhaustedError('飞书 API 本月调用量已耗尽（99991403）。');
      }

      // 1061045 = 上传超频（5 QPS / 10000 次每天）；
      // 99991400 = 通用限流 —— 部分接口以 HTTP 400 + 该错误码的形式限流，
      // 素材上传属「特殊频控」，两种形态都要能退避重试。
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        payload.code === 1061045 ||
        payload.code === 99991400;
      if (retryable && attempt < this.maxRetries) {
        const wait = this.serverRequestedWait(response) ?? this.backoffMs(attempt);
        this.opts.limiter.pauseFor(wait);
        await sleep(wait);
        continue;
      }

      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError({
          status: response.status,
          code: payload.code ?? -1,
          message: payload.msg ?? raw.slice(0, 300),
          requestId: response.headers.get('x-tt-logid') ?? undefined,
          path,
        });
      }

      return (payload.data ?? {}) as T;
    }

    throw new FeishuApiError({
      status: 0,
      code: -1,
      message: `上传重试耗尽: ${friendlyMessage(lastError)}`,
      path,
    });
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async headers(hasBody: boolean): Promise<Record<string, string>> {
    const h: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
    if (hasBody) h['Content-Type'] = 'application/json; charset=utf-8';
    return h;
  }

  private async token(): Promise<string> {
    return this.opts.tokenProvider.get();
  }

  private parseEnvelope(
    raw: string,
    status: number,
    path: string,
  ): { code: number; msg: string; data?: unknown } {
    if (raw.trim() === '') return { code: 0, msg: '' };
    try {
      return JSON.parse(raw) as { code: number; msg: string; data?: unknown };
    } catch {
      throw new FeishuApiError({
        status,
        code: -1,
        message: `飞书返回非 JSON（HTTP ${status}）: ${raw.slice(0, 200)}`,
        path,
      });
    }
  }

  /**
   * 读服务端的限流重置提示。
   *
   * 官方在 429 响应里给 `x-ogw-ratelimit-reset`（恢复周期，**秒**）。
   * 有这个值就必须用它 —— 自己拍脑袋的指数退避要么退得不够仍然撞墙，
   * 要么退得过久白白拖慢同步。
   */
  private serverRequestedWait(response: Response): number | null {
    const raw = response.headers.get('x-ogw-ratelimit-reset');
    if (!raw) return null;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    // 加 250ms 余量，避免贴着边界重试立刻再撞
    return Math.min(seconds * 1000 + 250, 120_000);
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(1000 * 2 ** attempt, 30_000);
    // 抖动：多个并发同步任务同时退避时避免形成共振
    return Math.round(base * (0.7 + Math.random() * 0.6));
  }

  private async backoff(attempt: number, reason: string): Promise<void> {
    const wait = this.backoffMs(attempt);
    this.opts.onRetry?.({ attempt: attempt + 1, waitMs: wait, reason });
    await sleep(wait);
  }
}
