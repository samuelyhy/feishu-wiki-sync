import { ConfigError, FeishuApiError, friendlyMessage } from '../errors.js';
import type { ApiRecorder } from '../record.js';

export const DEFAULT_BASE_URL = 'https://open.feishu.cn/open-apis';

/**
 * `tenant_access_token` 的获取与缓存。
 *
 * ## 为什么全程用 tenant_access_token 而不是 user_access_token
 *
 * user token 的 `refresh_token` 是**一次性**的，且用户授权满 365 天后必须
 * 重新走 OAuth 授权（否则刷新报 20037）。对一个无人值守的同步工具来说，
 * 「每年需要有人点一次授权」是不可接受的运维负担。
 *
 * 代价是：知识库里显示的文档作者是应用（机器人），而不是某个真人。
 *
 * ## 关于「提前多久刷新」
 *
 * 官方行为有个反直觉点：剩余有效期 **< 30 分钟**时调用会返回**新** token，
 * 且新旧两个同时有效；剩余 ≥ 30 分钟时返回**原有** token。
 * 所以提前刷新不会踢掉旧 token，是安全的。
 */
export class TenantTokenProvider {
  private token: string | null = null;
  private expiresAtMs = 0;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /**
     * 可选录制器。
     *
     * 鉴权走的是这里自己的 `fetch`，不经过 `FeishuClient` —— 不单独接一次的话，
     * 录制文件里会**缺掉序列的第一步**，看的人容易以为「一上来就调 wiki」，
     * 从而误判问题出在权限而不是凭证。
     */
    private readonly recorder?: ApiRecorder,
  ) {
    if (!appId || !appSecret) {
      throw new ConfigError(
        '缺少飞书应用凭证',
        '请在 .ai-sync.env 中设置 FEISHU_APP_ID 与 FEISHU_APP_SECRET',
      );
    }
  }

  /**
   * 强制走一次鉴权并返回有效期（秒）。
   *
   * `doctor` 用它把「凭证到底能不能用」查成一个是非题：
   * 不复用缓存，因为缓存里的 token 可能是上次成功时留下的，
   * 而这次要回答的是「现在这副凭证还有效吗」。
   */
  async probe(): Promise<number> {
    this.token = null;
    this.expiresAtMs = 0;
    await this.refresh();
    return Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 1000));
  }

  /** 取一个有效 token。缓存命中时不发请求。 */
  async get(): Promise<string> {
    // 留 10 分钟余量：一次同步可能持续数分钟，不能取到「还剩 30 秒」的 token
    const marginMs = 10 * 60 * 1000;
    if (this.token && Date.now() < this.expiresAtMs - marginMs) {
      return this.token;
    }
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    const url = `${this.baseUrl}/auth/v3/tenant_access_token/internal`;
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      });
    } catch (err) {
      throw new ConfigError(
        `无法连接飞书开放平台: ${friendlyMessage(err)}`,
        '检查网络与出网代理设置',
      );
    }

    const text = await response.text();
    let payload: { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new ConfigError(`飞书鉴权返回非 JSON（HTTP ${response.status}）: ${text.slice(0, 200)}`);
    }

    // 请求体含 app_secret、响应体含 token —— 都由录制器的脱敏负责，
    // 这里照常传原始值即可（录制器不会把敏感字段原样落盘）
    this.recorder?.record({
      method: 'POST',
      path: '/auth/v3/tenant_access_token/internal',
      status: response.status,
      durationMs: Date.now() - startedAt,
      requestBody: { app_id: this.appId, app_secret: this.appSecret },
      responseBody: payload,
    });

    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new FeishuApiError({
        status: response.status,
        code: payload.code ?? -1,
        message: `获取 tenant_access_token 失败: ${payload.msg ?? text.slice(0, 200)}`,
        path: '/auth/v3/tenant_access_token/internal',
      });
    }

    this.token = payload.tenant_access_token;
    // 官方未保证 expire 一定返回；缺失时按 2 小时上限保守处理
    this.expiresAtMs = Date.now() + (payload.expire ?? 7200) * 1000;
    return this.token;
  }
}
