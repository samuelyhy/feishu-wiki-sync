import { FeishuApiError, QuotaExhaustedError } from '../errors.js';
import type { FeishuClient } from './client.js';

/** 「节点确实不存在」的错误码。只有这些才该被翻译成 null。 */
const NOT_FOUND_CODES = new Set([131005, 131006, 131007]);

/**
 * 知识库（Wiki）接口。
 *
 * ## node_token 与 obj_token 的区别（最容易搞混、搞混就写不了内容）
 *
 * - `node_token`：**知识库节点**的 ID，URL `.../wiki/<token>` 里的就是它。
 * - `obj_token`：节点挂载的**真实云文档** token，即 docx 的 `document_id`。
 * - **读写文档内容必须用 `obj_token`，不能用 `node_token`。**
 *
 * 由此可得一条关键推论：**只要 node_token 不变，文档 URL 就稳定。**
 * 所以「原地更新」= 保持节点不动、替换其挂载 docx 的内容。
 */
export interface WikiNode {
  node_token: string;
  obj_token: string;
  obj_type: string;
  title: string;
  parent_node_token?: string;
  has_child?: boolean;
}

interface ListNodesData {
  items?: WikiNode[];
  has_more?: boolean;
  page_token?: string;
}

export class WikiApi {
  constructor(private readonly client: FeishuClient) {}

  /**
   * 列举某父节点下的**直属**子节点，自动翻页。
   *
   * 只列直属子节点是有意的：认领逻辑不该递归整棵子树 ——
   * 那会让两个不同目录下的同名文档互相抢，且遍历成本随知识库增长而失控。
   */
  async listChildren(spaceId: string, parentNodeToken?: string): Promise<WikiNode[]> {
    const out: WikiNode[] = [];
    // 官方明确：因权限过滤，可能返回空列表但 has_more 仍为 true。
    // 因此不能「空列表即停止」，只能靠 has_more + page_token 推进；
    // 同时防住 page_token 原地打转导致的无限翻页。
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;

    do {
      const data = (await this.client.request<ListNodesData>(
        `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
        {
          query: {
            // 不传 parent_node_token 时返回顶级节点（官方示例中「一级节点父 token 为空」），
            // 用于首次挑选父节点
            parent_node_token: parentNodeToken || undefined,
            page_size: 50,
            page_token: pageToken,
          },
        },
      )) as ListNodesData;

      for (const item of data.items ?? []) out.push(item);

      const next = data.has_more ? data.page_token : undefined;
      pageToken = next && !seenTokens.has(next) ? (seenTokens.add(next), next) : undefined;
    } while (pageToken);

    return out;
  }

  /**
   * 按 node_token 或文档 token 反查节点信息；查不到返回 null。
   *
   * 「查不到」与「查不了」必须分开：配额耗尽、权限不足这类错误要原样抛出，
   * 不能被吞成 null —— 否则调用方会把「本月配额用完了」理解成
   * 「这个节点不存在」，然后给出完全错误的修复指引。
   */
  async getNode(token: string, objType?: string): Promise<WikiNode | null> {
    try {
      const data = (await this.client.request<{ node?: WikiNode }>(
        '/wiki/v2/spaces/get_node',
        { query: { token, obj_type: objType } },
      )) as { node?: WikiNode };
      return data.node ?? null;
    } catch (err) {
      if (err instanceof QuotaExhaustedError) throw err;
      if (err instanceof FeishuApiError && NOT_FOUND_CODES.has(err.code)) return null;
      throw err;
    }
  }

  /**
   * 创建节点。
   *
   * 关键行为：**不传 `obj_token` 时，飞书会自动新建一篇对应类型的空文档**，
   * 并把它作为节点的内容。这正是我们要的 —— 一步拿到节点与文档，
   * 不需要走 import_task，也不需要 move_docs_to_wiki。
   */
  async createNode(params: {
    spaceId: string;
    objType: string;
    parentNodeToken?: string;
    title?: string;
  }): Promise<WikiNode> {
    const data = (await this.client.request<{ node?: WikiNode }>(
      `/wiki/v2/spaces/${encodeURIComponent(params.spaceId)}/nodes`,
      {
        method: 'POST',
        body: {
          obj_type: params.objType,
          node_type: 'origin',
          ...(params.parentNodeToken ? { parent_node_token: params.parentNodeToken } : {}),
          ...(params.title ? { title: params.title } : {}),
        },
      },
    )) as { node?: WikiNode };

    if (!data.node?.node_token || !data.node.obj_token) {
      throw new Error('创建知识库节点成功但响应缺少 node_token / obj_token');
    }
    return data.node;
  }

}
