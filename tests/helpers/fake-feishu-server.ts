import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { FakeFeishu } from './fake-feishu.js';

/**
 * 一个**真实的 HTTP 服务器**，模拟飞书开放平台的接口子集。
 *
 * ## 为什么需要它
 *
 * `fake-feishu.ts` 替换的是 `WikiApi` / `DocxApi` / `MediaApi` 这些**类**，
 * 所以 `FeishuClient` 完全没被覆盖 —— URL 拼接、鉴权头、响应包解析、
 * 请求体字段名这些最容易写错的地方，在单元测试里是盲区。
 *
 * 这个服务器把同一套内存状态暴露成 HTTP 接口，于是 CLI 可以**原封不动地**
 * 跑完整链路（config → auth → client → wiki/docx/media → syncer），
 * 只有在凭证和 base_url 上做替换。这是在没有真实飞书凭证的前提下，
 * 能对真实协议行为做出的最接近的验证。
 *
 * ## 它会主动拒绝的东西
 *
 * - 缺少 `Authorization: Bearer` 头
 * - 用错 HTTP 方法（例如把 descendant 写成 GET）
 * - 请求体缺必填字段（`children_id`、`descendants`、`requests`、`start_index`…）
 * - 生产代码若把只读字段（`merge_info`）传回来，会明确报错
 *
 * 请求体里的字段名一旦写错，这里就会失败 —— 这正是我们要守的东西。
 */
export interface FakeServerHandle {
  /** 形如 `http://127.0.0.1:PORT`（不含 /open-apis，交给被测代码自己补） */
  baseUrl: string;
  fake: FakeFeishu;
  /** 记录所有收到的请求，用于断言 */
  readonly requests: string[];
  close(): Promise<void>;
}

export async function startFakeFeishuServer(): Promise<FakeServerHandle> {
  const fake = new FakeFeishu();
  const requests: string[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    requests.push(`${req.method} ${path}`);

    void (async () => {
      try {
        const body = await readBody(req, res);

        if (!path.startsWith('/open-apis/')) {
          return send(res, 404, { code: 404, msg: `未知路径 ${path}` });
        }

        // 鉴权：除取 token 外都必须带 Bearer
        const auth = req.headers.authorization ?? '';
        if (!path.endsWith('/auth/v3/tenant_access_token/internal')) {
          if (!auth.startsWith('Bearer ')) {
            return send(res, 401, { code: 99991661, msg: '缺少或非法的 Authorization 头' });
          }
        }

        const result = await route(fake, req.method ?? 'GET', path, url, body, res);
        if (result !== undefined) send(res, 200, { code: 0, msg: 'success', data: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(res, 200, { code: 400, msg: message });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    fake,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}

/** 返回 undefined 表示已自行响应（例如 multipart 上传）。 */
async function route(
  fake: FakeFeishu,
  method: string,
  path: string,
  url: URL,
  body: Record<string, any>,
  res: http.ServerResponse,
): Promise<unknown> {
  const m = (re: RegExp): RegExpMatchArray | null => path.match(re);

  // ── 鉴权 ──
  //
  // ⚠️ 这个接口的响应结构与其它接口不同：`tenant_access_token` 与 `expire`
  // 在**顶层**，不包在 `data` 里（官方响应示例可直接印证）。
  // 最初这里按统一格式包了 data，结果被测代码正确地拒绝了 —— 是测试脚手架错了，
  // 不是被测代码错了。保留这条注释免得以后又被「统一」掉。
  if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
    if (method !== 'POST') throw new Error('取 token 必须用 POST');
    if (!body.app_id || !body.app_secret) throw new Error('缺少 app_id / app_secret');
    send(res, 200, { code: 0, msg: 'ok', tenant_access_token: 'fake-tenant-token', expire: 7200 });
    return undefined;
  }

  // ── 知识库 ──
  if (path === '/open-apis/wiki/v2/spaces/get_node') {
    const token = url.searchParams.get('token');
    if (!token) throw new Error('get_node 缺少 token 参数');
    const node = (await fake.wiki.getNode(token)) ?? undefined;
    return { node };
  }

  let hit = m(/^\/open-apis\/wiki\/v2\/spaces\/([^/]+)\/nodes$/);
  if (hit) {
    const spaceId = hit[1]!;
    if (method === 'GET') {
      const parent = url.searchParams.get('parent_node_token') ?? undefined;
      return {
        items: await fake.wiki.listChildren(spaceId, parent),
        has_more: false,
      };
    }
    if (method === 'POST') {
      if (!body.obj_type) throw new Error('创建节点缺少 obj_type');
      if (body.node_type !== 'origin') throw new Error('node_type 应为 origin');
      // 父节点必须真实存在 —— 真实飞书会拒绝不存在的 parent_node_token，
      // 假服务器不校验的话，「配置里写了编造的 token」这类错误会被静默放过。
      if (body.parent_node_token && !(await fake.wiki.getNode(body.parent_node_token))) {
        throw new Error(`parent_node_token ${body.parent_node_token} 不存在`);
      }
      const node = await fake.wiki.createNode({
        spaceId,
        ...(body.parent_node_token ? { parentNodeToken: body.parent_node_token } : {}),
        ...(body.title ? { title: body.title } : {}),
      });
      return { node };
    }
    throw new Error(`nodes 不支持方法 ${method}`);
  }

  // ── 文档 ──
  hit = m(/^\/open-apis\/docx\/v1\/documents\/([^/]+)$/);
  if (hit) {
    const doc = await fake.docx.getDocument(hit[1]!);
    return { document: doc };
  }

  hit = m(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks$/);
  if (hit) {
    return { items: await fake.docx.listBlocks(hit[1]!), has_more: false };
  }

  if (path === '/open-apis/docx/v1/documents/blocks/convert') {
    if (method !== 'POST') throw new Error('convert 必须用 POST');
    if (body.content_type !== 'markdown') throw new Error('content_type 应为 markdown');
    if (typeof body.content !== 'string') throw new Error('convert 缺少 content');
    const out = await fake.docx.convertMarkdown(body.content);
    return { first_level_block_ids: out.firstLevelBlockIds, blocks: out.blocks };
  }

  hit = m(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)\/descendant$/);
  if (hit) {
    if (method !== 'POST') throw new Error('descendant 必须用 POST');
    if (!Array.isArray(body.children_id) || body.children_id.length === 0) {
      throw new Error('descendant 缺少 children_id');
    }
    if (!Array.isArray(body.descendants) || body.descendants.length === 0) {
      throw new Error('descendant 缺少 descendants');
    }
    if (body.children_id.length > 1000 || body.descendants.length > 1000) {
      throw new Error('descendant 单次不得超过 1000 个块');
    }
    // 官方明确 merge_info 只读，传回来会报错 —— 这里如实模拟
    for (const d of body.descendants as Array<Record<string, any>>) {
      if (d?.table?.property && 'merge_info' in d.table.property) {
        throw new Error('table.property.merge_info 是只读字段，不应在请求中出现');
      }
    }
    const relations = await fake.docx.createDescendant({
      documentId: hit[1]!,
      parentBlockId: hit[2]!,
      childrenId: body.children_id,
      descendants: body.descendants,
      index: typeof body.index === 'number' ? body.index : undefined,
    });
    return { block_id_relations: relations };
  }

  hit = m(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/batch_update$/);
  if (hit) {
    if (method !== 'PATCH') throw new Error('batch_update 必须用 PATCH');
    if (!Array.isArray(body.requests)) throw new Error('batch_update 缺少 requests');
    if (body.requests.length > 200) throw new Error('batch_update 单次不得超过 200 条');
    await fake.docx.batchUpdate({ documentId: hit[1]!, requests: body.requests });
    return {};
  }

  hit = m(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)\/children\/batch_delete$/);
  if (hit) {
    if (method !== 'DELETE') throw new Error('batch_delete 必须用 DELETE');
    if (typeof body.start_index !== 'number' || typeof body.end_index !== 'number') {
      throw new Error('batch_delete 缺少 start_index / end_index');
    }
    await fake.docx.deleteChildren({
      documentId: hit[1]!,
      parentBlockId: hit[2]!,
      startIndex: body.start_index,
      endIndex: body.end_index,
    });
    return {};
  }

  // ── 素材下载（二进制，自行响应）──
  //
  // 注意：成功时返回的是**字节流**，不是 JSON。客户端必须靠 Content-Type
  // 区分成功与失败，否则失败时只会得到一段二进制乱码。
  hit = m(/^\/open-apis\/drive\/v1\/medias\/([^/]+)\/download$/);
  if (hit) {
    if (method !== 'GET') throw new Error('下载素材必须用 GET');
    const content = fake.mediaStore.get(hit[1]!);
    if (!content) {
      // 失败时飞书照常返回 JSON
      send(res, 404, { code: 1061002, msg: '素材不存在或应用无下载权限' });
      return undefined;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': String(content.length),
    });
    res.end(content);
    return undefined;
  }

  // ── 素材上传（multipart，自行响应）──
  if (path === '/open-apis/drive/v1/medias/upload_all') {
    // 上面的 readBody 已把 multipart 原样读成字符串；这里只校验关键字段存在
    const raw = String((body as { __raw?: string }).__raw ?? '');
    for (const field of ['file_name', 'parent_type', 'parent_node', 'size', 'file']) {
      if (!raw.includes(`name="${field}"`)) {
        throw new Error(`素材上传缺少表单字段 ${field}`);
      }
    }
    if (!raw.includes('docx_image')) throw new Error('parent_type 应为 docx_image');
    // 从 multipart 原文里取出 parent_node，供「素材挂到了哪个块」这类断言使用
    const parentNode = /name="parent_node"\r?\n\r?\n([^\r\n]*)/.exec(raw)?.[1] ?? '';
    const token = await fake.media.uploadImage({ fileName: 'x.png', parentNode });
    send(res, 200, { code: 0, msg: 'success', data: { file_token: token } });
    return undefined;
  }

  throw new Error(`未实现的接口: ${method} ${path}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const type = req.headers['content-type'] ?? '';
      if (type.includes('multipart/form-data')) {
        // 保留原始字节用于字段校验（见 upload_all 分支）
        resolve({ __raw: buf.toString('binary') });
        return;
      }
      const text = buf.toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text) as Record<string, any>);
      } catch {
        res.statusCode = 200;
        reject(new Error(`请求体不是合法 JSON: ${text.slice(0, 120)}`));
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export { sleep };
