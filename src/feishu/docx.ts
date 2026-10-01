import type { FeishuBlock } from '../core/blocks.js';
import type { FeishuClient } from './client.js';

/**
 * 云文档（docx）块接口。
 *
 * 几处官方约束在此显式写明，因为违反它们的报错信息都不够直白：
 * - `batch_update` 的 `requests` 上限 **200**（网上流传的「10」是旧版 Docs 1.0 的接口）。
 * - `descendant` 的 `children_id` 与 `descendants` 各上限 **1000**，
 *   且**只写第一级子块**，写入子块的子块会报 1770006。
 * - 单文档块数上限 **20000**。
 * - 所有写操作都受「单应用 3 次/秒 + 单文档 3 次/秒」双重限流。
 */

export const BATCH_UPDATE_MAX = 200;
export const DESCENDANT_MAX = 1000;
export const MAX_BLOCKS_PER_DOCUMENT = 20_000;

export interface DocumentInfo {
  document_id: string;
  revision_id: number;
  title: string;
}

export interface BlockIdRelation {
  temporary_block_id: string;
  block_id: string;
}

interface ListBlocksData {
  items?: FeishuBlock[];
  has_more?: boolean;
  page_token?: string;
}

export class DocxApi {
  constructor(private readonly client: FeishuClient) {}

  /** 文档基本信息。`revision_id` 是漂移检测的依据。 */
  async getDocument(documentId: string): Promise<DocumentInfo> {
    const data = (await this.client.request<{ document?: DocumentInfo }>(
      `/docx/v1/documents/${encodeURIComponent(documentId)}`,
    )) as { document?: DocumentInfo };

    if (!data.document?.document_id) {
      throw new Error(`获取文档信息失败: ${documentId}`);
    }
    return data.document;
  }

  /** 拉取全部块（自动翻页）。返回先序数组，索引 0 是 Page 块。 */
  async listBlocks(documentId: string): Promise<FeishuBlock[]> {
    const out: FeishuBlock[] = [];
    // 与 wiki 列表同理：靠 has_more 推进，并防住 page_token 原地打转。
    // 一篇 2 万块的文档要翻 40 页，卡住会一直烧配额直到超时。
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;

    do {
      const data = (await this.client.request<ListBlocksData>(
        `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`,
        {
          query: {
            page_size: 500,
            page_token: pageToken,
            document_revision_id: -1,
          },
          docId: documentId,
          kind: 'read',
        },
      )) as ListBlocksData;

      for (const b of data.items ?? []) out.push(b);

      const next = data.has_more ? data.page_token : undefined;
      pageToken = next && !seenTokens.has(next) ? (seenTokens.add(next), next) : undefined;
    } while (pageToken);

    return out;
  }

  /**
   * Markdown/HTML → 文档块。
   *
   * 这是全案最重要的接口：**它让自研 Markdown→块转换器变得毫无必要**。
   * 官方支持转换：文本、1~9 级标题、有序/无序列表、代码块、引用、待办、图片、表格。
   *
   * 返回的块带有**临时 ID**，需要原样传给 `createDescendant` 完成落地。
   *
   * 注意：它**不支持**飞书特有块（高亮块 Callout、分栏、画板等）。
   */
  async convertMarkdown(markdown: string): Promise<{
    firstLevelBlockIds: string[];
    blocks: FeishuBlock[];
  }> {
    const data = (await this.client.request<{
      first_level_block_ids?: string[];
      blocks?: FeishuBlock[];
    }>('/docx/v1/documents/blocks/convert', {
      method: 'POST',
      // ⚠️ 未经真机验证的假设：官方文档未给出 convert 的频控等级。
      // 它不落任何文档、纯计算，因此按读类（5 次/秒）而非块写类（3 次/秒）限流。
      // 若真机上它按写类计，会偶发 99991400 —— 那可由退避重试兜住，不会失败。
      kind: 'read',
      body: { content_type: 'markdown', content: markdown },
    })) as { first_level_block_ids?: string[]; blocks?: FeishuBlock[] };

    return {
      firstLevelBlockIds: data.first_level_block_ids ?? [],
      blocks: data.blocks ?? [],
    };
  }

  /**
   * 批量插入嵌套块。
   *
   * `index` 表示插入到父块子块列表中的位置；**必须放在请求体里**，
   * 作为 URL 查询参数会被忽略（官方 FAQ 明确）。
   * 不传时等价于 -1（追加到末尾）。
   */
  async createDescendant(params: {
    documentId: string;
    parentBlockId: string;
    childrenId: string[];
    descendants: unknown[];
    index?: number;
  }): Promise<BlockIdRelation[]> {
    const data = (await this.client.request<{ block_id_relations?: BlockIdRelation[] }>(
      `/docx/v1/documents/${encodeURIComponent(params.documentId)}/blocks/${encodeURIComponent(
        params.parentBlockId,
      )}/descendant`,
      {
        method: 'POST',
        query: { document_revision_id: -1 },
        docId: params.documentId,
        body: {
          children_id: params.childrenId,
          descendants: params.descendants,
          index: params.index ?? -1,
        },
      },
    )) as { block_id_relations?: BlockIdRelation[] };

    return data.block_id_relations ?? [];
  }

  /**
   * 批量更新块。
   *
   * 上限 200，且**同一 block_id 不得在一次请求里出现两次**。
   * 这是保留评论的关键接口：更新文本时 `block_id` 不变，挂在块上的评论随之保留。
   */
  async batchUpdate(params: {
    documentId: string;
    requests: unknown[];
  }): Promise<void> {
    if (params.requests.length > BATCH_UPDATE_MAX) {
      throw new Error(`batch_update 单次上限 ${BATCH_UPDATE_MAX}，收到 ${params.requests.length}`);
    }
    await this.client.request(
      `/docx/v1/documents/${encodeURIComponent(params.documentId)}/blocks/batch_update`,
      {
        method: 'PATCH',
        query: { document_revision_id: -1 },
        docId: params.documentId,
        body: { requests: params.requests },
      },
    );
  }

  /**
   * 按索引范围删除子块（左闭右开）。
   *
   * 用的是**索引**而不是 block_id 列表 —— 这正是写入顺序必须倒序的根因：
   * 删掉靠前的块会让后面所有索引失效。
   */
  async deleteChildren(params: {
    documentId: string;
    parentBlockId: string;
    startIndex: number;
    endIndex: number;
  }): Promise<void> {
    if (params.endIndex <= params.startIndex) return;
    await this.client.request(
      `/docx/v1/documents/${encodeURIComponent(params.documentId)}/blocks/${encodeURIComponent(
        params.parentBlockId,
      )}/children/batch_delete`,
      {
        method: 'DELETE',
        query: { document_revision_id: -1 },
        docId: params.documentId,
        body: { start_index: params.startIndex, end_index: params.endIndex },
      },
    );
  }
}
