import { ConfigError } from './errors.js';
import { loadConfig, type SyncConfig } from './core/config.js';
import { LedgerStore } from './core/ledger.js';
import { loadEnvFile } from './core/env.js';
import { DEFAULT_BASE_URL, TenantTokenProvider } from './feishu/auth.js';
import { FeishuClient } from './feishu/client.js';
import { DocxApi } from './feishu/docx.js';
import { MediaApi } from './feishu/media.js';
import { WikiApi } from './feishu/wiki.js';
import { color, type Logger } from './logger.js';
import { ApiRecorder } from './record.js';
import { RateLimiter } from './rate-limit.js';

export interface AppContext {
  cwd: string;
  config: SyncConfig;
  ledger: LedgerStore;
  limiter: RateLimiter;
  wiki: WikiApi;
  docx: DocxApi;
  media: MediaApi;
  logger: Logger;
  /** 鉴权句柄。离线模式下不可用 —— `doctor` 用它做凭证检查。 */
  auth?: {
    getToken(): Promise<string>;
    /** 主动刷新并返回有效期（秒），用于把「凭证是否可用」查清楚 */
    probe(): Promise<number>;
  };
}

export interface CreateContextOptions {
  /** 只能读本地、不联网的命令（如 `status`）用它跳过凭证检查 */
  offline?: boolean;
}

export function createContext(
  cwd: string,
  logger: Logger,
  options: CreateContextOptions = {},
): AppContext {
  const env = loadEnvFile(cwd);
  const config = loadConfig(cwd);

  const baseUrl = normalizeBaseUrl(
    config.baseUrl ?? env.FEISHU_BASE_URL ?? process.env.FEISHU_BASE_URL ?? DEFAULT_BASE_URL,
  );

  const limiter = new RateLimiter();
  const ledger = new LedgerStore(cwd, config.spaceId);

  if (options.offline) {
    const noop = (): never => {
      throw new ConfigError('该命令不应发起网络请求');
    };
    const client = { request: noop, upload: noop } as unknown as FeishuClient;
    return {
      cwd,
      config,
      ledger,
      limiter,
      wiki: new WikiApi(client),
      docx: new DocxApi(client),
      media: new MediaApi(client),
      logger,
    };
  }

  const appId = env.FEISHU_APP_ID ?? process.env.FEISHU_APP_ID ?? '';
  const appSecret = env.FEISHU_APP_SECRET ?? process.env.FEISHU_APP_SECRET ?? '';
  if (!appId || !appSecret) {
    throw new ConfigError(
      '缺少飞书应用凭证',
      '执行 `fws init --app-id <id> --app-secret <secret>`，' +
        '或在 .ai-sync.env 中设置 FEISHU_APP_ID / FEISHU_APP_SECRET',
    );
  }

  // 录制是旁路观测：默认关闭，由环境变量 FWS_RECORD 触发。
  // 它不做任何行为改变，因此开着跑与关着跑的 API 交互完全一致。
  const recorder = ApiRecorder.fromEnv();
  if (recorder) {
    logger.warn(
      `FWS_RECORD 已开启，本次 API 交互将写入 ${recorder.file}\n` +
        `  ${color.dim('该文件含文档正文，请按敏感数据处理（请求头已剔除、token 已脱敏）。')}`,
    );
  }

  const tokenProvider = new TenantTokenProvider(
    appId,
    appSecret,
    baseUrl,
    fetch,
    recorder ?? undefined,
  );
  const client = new FeishuClient({
    tokenProvider,
    limiter,
    baseUrl,
    ...(recorder ? { recorder } : {}),
    onRetry: (info) => logger.debug(`  重试 #${info.attempt}（${info.reason}），等待 ${info.waitMs}ms`),
  });

  return {
    cwd,
    config,
    ledger,
    limiter,
    wiki: new WikiApi(client),
    docx: new DocxApi(client),
    media: new MediaApi(client),
    logger,
    auth: {
      getToken: () => tokenProvider.get(),
      probe: () => tokenProvider.probe(),
    },
  };
}

/**
 * 归一化 Base URL。
 *
 * 用户很容易只填域名（`https://open.larksuite.com`）而漏掉 `/open-apis`，
 * 结果所有请求 404 且报错信息毫无提示性。这里自动补全，
 * 并对常见的「多写了 /v1」也做兜底。
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  url = url.replace(/\/v1$/i, '');
  if (!/\/open-apis$/i.test(url)) url = `${url}/open-apis`;
  return url;
}
