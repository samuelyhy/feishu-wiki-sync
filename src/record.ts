import fs from 'node:fs';
import path from 'node:path';

/**
 * API 交互录制。
 *
 * ## 为什么需要它
 *
 * 这个工具的全部行为都建立在若干条**无法在本地证伪**的假设上（`convert` 的
 * 真实块结构、`createNode` 是否自动建文档、tenant token 能否写入……）。
 * 假飞书里的测试只能证明「代码自洽」—— 因为假飞书本身就是照这些假设写的。
 *
 * 而真机验证的障碍不是「不能做」，是「**做了之后信息留不下来**」：
 * 跑一次 `fws sync`，得到的是一屏输出，出了分歧还得靠人复述。
 *
 * 录制把一次真机运行变成**可复用、可复查、可当夹具**的证据：
 *
 * ```bash
 * FWS_RECORD=/tmp/fws-run.jsonl fws sync --dry-run
 * ```
 *
 * 之后无论是我还是他们，都能拿这份文件回答「飞书到底返回了什么」。
 *
 * ## 安全约束（这几条不能松）
 *
 * 1. **绝不记录请求头** —— 里面是 `Authorization: Bearer <token>`。
 * 2. **鉴权响应里 token 字段脱敏** —— 那是可以直接冒充应用的凭证。
 * 3. **默认不开启**，且开启时明确提示文件里含**文档正文**。
 *
 * 录制文件应当当作敏感数据处理：不要提交、不要贴到公开渠道。
 */

/** 单次调用的记录。刻意不含请求头。 */
export interface RecordedCall {
  seq: number;
  at: string;
  method: string;
  /** 已剥掉 query 的路径；query 单独存 */
  path: string;
  query?: Record<string, string>;
  status: number;
  durationMs: number;
  /** 已脱敏的请求体 */
  requestBody?: unknown;
  /** 已脱敏、可能截断的响应体 */
  responseBody?: unknown;
  /** 响应体被截断时给出原始长度 */
  responseBytes?: number;
  requestId?: string;
  /** 调用最终抛错时的错误消息（区别于 HTTP 层的失败） */
  thrown?: string;
}

/** 单条记录里响应体的上限。`convert` 的返回可以到几百 KB。 */
const MAX_BODY_CHARS = 2 * 1024 * 1024;

/** 会被脱敏的字段名。命中即替换成 `<redacted>`。 */
const SENSITIVE_KEYS = new Set([
  'tenant_access_token',
  'app_access_token',
  'access_token',
  'refresh_token',
  'app_secret',
  'token',
]);

export class ApiRecorder {
  private seq = 0;
  private readonly startedAt = Date.now();
  written = 0;

  private constructor(
    readonly file: string,
  ) {
    const abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    if (!fs.existsSync(abs)) {
      // 第一行是元信息：让这份文件自带出处，别人拿到也知道它是怎么来的
      fs.appendFileSync(
        abs,
        `${JSON.stringify({
          kind: 'fws-record-header',
          version: 1,
          startedAt: new Date(this.startedAt).toISOString(),
          node: process.version,
          cwd: process.cwd(),
          note:
            '本文件记录了一次真实飞书 API 交互。请求头已全部剔除，鉴权 token 已脱敏。' +
            '内容含文档正文，请按敏感数据处理。',
        })}\n`,
        'utf8',
      );
    }
  }

  /**
   * 从环境变量启用。
   *
   * 用环境变量而不是命令行开关：它是个**旁路观测**能力，不该出现在
   * 每个子命令的开关表里；同时这样任何命令都能录，包括以后新增的。
   */
  static fromEnv(): ApiRecorder | null {
    const file = process.env.FWS_RECORD?.trim();
    if (!file) return null;
    return ApiRecorder.open(file);
  }

  static open(file: string): ApiRecorder {
    return new ApiRecorder(path.resolve(file));
  }

  /**
   * 同步追加一行。
   *
   * 用 `appendFileSync` 而不是写流，是刻意的：**崩溃恰恰是最需要这份记录的时刻**，
   * 而写流会把最后若干条留在缓冲区里随进程一起丢掉。
   * 一次运行的调用量是几百条，同步写的开销可以忽略。
   */
  record(call: Omit<RecordedCall, 'seq' | 'at'>): void {
    this.seq += 1;
    const entry: RecordedCall = {
      seq: this.seq,
      at: new Date().toISOString(),
      ...call,
      ...(call.requestBody !== undefined ? { requestBody: redact(call.requestBody) } : {}),
      ...(call.responseBody !== undefined
        ? { responseBody: truncate(redact(call.responseBody)) }
        : {}),
    };

    try {
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      this.written += 1;
      this.failed = 0;
    } catch (err) {
      // 录制不该让同步本身失败（磁盘满、路径没权限都要能继续）。
      //
      // 但**也不能静默**：用户开着录制跑了一次真机，以为留下了证据、实际没有，
      // 这比不录制更糟 —— 他会据此认为「已经验证过了」。所以第一次失败要出声。
      this.failed += 1;
      if (this.failed === 1) {
        process.stderr.write(
          `⚠ 录制写入失败，本次运行不会留下记录：${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /** 累计写失败的条数（成功一次即清零） */
  private failed = 0;

  get failureCount(): number {
    return this.failed;
  }
}

/**
 * 递归脱敏。
 *
 * 结构照搬、只换掉敏感字段的值 —— 这样录制文件仍然能当夹具用，
 * 而不会把可以直接冒充应用的凭证留在磁盘上。
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 30) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '<redacted>' : redact(v, depth + 1);
  }
  return out;
}

function truncate(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= MAX_BODY_CHARS) return value;
  return {
    __truncated: true,
    originalChars: text.length,
    preview: text.slice(0, MAX_BODY_CHARS),
  };
}
