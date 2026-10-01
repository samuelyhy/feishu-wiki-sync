/**
 * 错误分类直接映射到进程退出码（见 spec §3）。
 *
 * 分这么细不是为了好看：`sync` 在 CI 里跑时，调用方需要区分
 * 「代码/配置错了，改完重跑」（2）、「某篇文档失败了，重跑可能好」（1）、
 * 「有人工歧义要处理」（3）、「配额烧完了，今天别跑了」（4）。
 * 混成一个退出码 1 的话，告警无法分级。
 */

/** 退出码契约。调用方（CI、包装脚本）依赖这些数字，改动即破坏性变更。 */
export const ExitCode = {
  OK: 0,
  SYNC_FAILED: 1,
  CONFIG_ERROR: 2,
  AMBIGUOUS: 3,
  QUOTA_EXHAUSTED: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** 配置或使用方式错误 —— 重跑无用，必须先改东西。 */
export class ConfigError extends Error {
  readonly exitCode = ExitCode.CONFIG_ERROR;
  /** 修复指引。人看到错误时最想知道的是「我该改什么」。 */
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

/** 单篇文档同步失败 —— 可能瞬时，重跑常能成功。 */
export class SyncError extends Error {
  readonly exitCode = ExitCode.SYNC_FAILED;
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'SyncError';
    this.path = path;
  }
}

/**
 * 需要人处理的歧义（同名文档多个、认领失败）。
 *
 * 刻意不自动挑一个：选错会静默覆盖别人维护的文档，而且不会报错，
 * 等发现时数据已经丢了。宁可停下来问人。
 */
export class AmbiguousError extends Error {
  readonly exitCode = ExitCode.AMBIGUOUS;
  readonly candidates: readonly string[];

  constructor(message: string, candidates: readonly string[] = []) {
    super(message);
    this.name = 'AmbiguousError';
    this.candidates = candidates;
  }
}

/**
 * 配额耗尽（99991403）。**必须区别于普通限流**：限流退避重试即可，
 * 配额耗尽是**本月**都没得用了，重试只会徒劳地继续敲门。
 */
export class QuotaExhaustedError extends Error {
  readonly exitCode = ExitCode.QUOTA_EXHAUSTED;

  constructor(message: string) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

/**
 * 飞书接口返回的错误。带上 code 与 request_id ——
 * 排查时拿 request_id 可直接找飞书技术支持定位，没有它只能干瞪眼。
 */
export class FeishuApiError extends Error {
  readonly status: number;
  readonly code: number;
  readonly requestId?: string;
  readonly path?: string;

  constructor(params: {
    status: number;
    code: number;
    message: string;
    requestId?: string;
    path?: string;
  }) {
    super(params.message);
    this.name = 'FeishuApiError';
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.path = params.path;
  }
}

/** 错误码 → 人话 + 修复指引。参见 spec 附录 B。 */
const ERROR_HINTS: Record<number, string> = {
  99991400: '请求过于频繁。本工具会自动退避重试；持续出现说明并发度调得太高。',
  99991403: '本月 API 调用量已耗尽。需等待次月刷新，或联系管理员提额。',
  1061045: '上传素材超频（5 QPS / 10000 次每天）。注意日限是硬约束。',
  131006: '应用无知识库权限。需把「包含应用机器人的群」加为知识空间管理员，仅开 scope 不够。',
  131003: '知识库节点数/深度/子节点数超限（≤40 万 / ≤50 层 / ≤2000）。',
  1770004: '文档块数超过上限（20000）。需拆分文档。',
  1770005: '块嵌套层级超过上限。',
  1770006: 'descendant 只应写入第一级子块，不应包含子块的子块。',
  1770007: '单个块的 children 数量超上限。',
  1770013: '图片/文件关联关系错误。通常是先上传素材后插入块导致 —— 必须先 descendant 拿到 Image BlockID 再上传。',
  1770032: '应用对该文档无权限。需把应用加为文档协作者。',
  1770033: '纯文本内容超过 10485760 字符上限。',
  20037: '用户授权已满 365 天，需重新授权。本工具使用 tenant_access_token，不应出现此错。',
};

export function hintForCode(code: number): string | undefined {
  return ERROR_HINTS[code];
}

/** 把任意异常转成可打印的一行消息。 */
export function friendlyMessage(err: unknown): string {
  if (err instanceof FeishuApiError) {
    const hint = hintForCode(err.code);
    const parts = [`飞书接口错误 ${err.code}（HTTP ${err.status}）: ${err.message}`];
    if (err.path) parts.push(`接口: ${err.path}`);
    if (err.requestId) parts.push(`request_id: ${err.requestId}`);
    if (hint) parts.push(`说明: ${hint}`);
    return parts.join(' | ');
  }
  if (err instanceof ConfigError) {
    return err.hint ? `${err.message}\n修复: ${err.hint}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function exitCodeOf(err: unknown): ExitCodeValue {
  if (err && typeof err === 'object' && 'exitCode' in err) {
    const code = (err as { exitCode?: unknown }).exitCode;
    if (typeof code === 'number') return code as ExitCodeValue;
  }
  return ExitCode.SYNC_FAILED;
}
