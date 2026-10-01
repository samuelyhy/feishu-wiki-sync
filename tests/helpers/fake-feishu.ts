import type { FeishuBlock } from '../../src/core/blocks.js';

/**
 * 内存版飞书，用于端到端验证同步逻辑。
 *
 * 刻意实现得「够真但不真」：块是扁平的一维数组（不模拟嵌套），
 * 因为同步算法的核心风险在**顶层块序列的索引与顺序**，把嵌套也模拟进来
 * 只会让测试变复杂而不增加覆盖。嵌套树的行为由 blocks.test.ts 单独覆盖。
 *
 * 它模拟了三条关键的服务端行为：
 * - 每次写操作 revision 自增（漂移检测依赖它）
 * - `deleteChildren` 按索引范围删除
 * - `createDescendant` 按 index 插入
 */
export interface FakeBlock {
  id: string;
  type: number;
  text: string;
  /** 仅 Image 块：上传素材后由 `replace_image` 写回 */
  token?: string;
}

export interface FakeDoc {
  id: string;
  title: string;
  revision: number;
  blocks: FakeBlock[];
}

export interface FakeNode {
  node_token: string;
  obj_token: string;
  obj_type: string;
  title: string;
  parent_node_token?: string;
}

export class FakeFeishu {
  readonly docs = new Map<string, FakeDoc>();
  readonly nodes: FakeNode[] = [];
  /** 所有写类调用的名字，用于断言「重复运行零写请求」 */
  readonly writes: string[] = [];
  /** 素材上传记录：哪张图被上传到了哪个 Image 块 —— 用来验证位置配对没错位 */
  readonly uploadedImages: Array<{ fileName: string; parentNode: string }> = [];
  /** 让指定的写操作失败一次（模拟「写到一半挂了」） */
  private failOnceFor: string | null = null;
  /** 模拟 convert 漏掉图片块（触发图片位置配对的保护性断言） */
  dropImageBlocksInConvert = false;
  private seq = 1;
  /** 下一次 convert 返回的临时块（由 markdown 决定） */
  private lastConverted: Array<{ id: string; type: number; text: string }> = [];

  nextId(prefix = 'b'): string {
    return `${prefix}${this.seq++}`;
  }

  // ── docx ──

  readonly docx = {
    getDocument: async (documentId: string): Promise<{ document_id: string; revision_id: number; title: string }> => {
      const doc = this.docs.get(documentId);
      if (!doc) throw new Error(`文档不存在: ${documentId}`);
      return { document_id: doc.id, revision_id: doc.revision, title: doc.title };
    },

    listBlocks: async (documentId: string): Promise<FeishuBlock[]> => {
      const doc = this.docs.get(documentId);
      if (!doc) throw new Error(`文档不存在: ${documentId}`);
      const page: FeishuBlock = {
        block_id: doc.id,
        block_type: 1,
        children: doc.blocks.map((b) => b.id),
      };
      const children = doc.blocks.map((b) => this.toFeishuBlock(b, doc.id));
      return [page, ...children];
    },

    convertMarkdown: async (markdown: string) => {
      const parsed = parseMarkdown(markdown, () => this.nextId('tmp'));
      this.lastConverted = this.dropImageBlocksInConvert
        ? parsed.filter((b) => b.type !== 27)
        : parsed;
      return {
        firstLevelBlockIds: this.lastConverted.map((b) => b.id),
        blocks: this.lastConverted.map((b) => this.toFeishuBlock(b)),
      };
    },

    batchUpdate: async ({ documentId, requests }: { documentId: string; requests: unknown[] }) => {
      this.writes.push('batchUpdate');
      const doc = this.docs.get(documentId);
      if (!doc) throw new Error(`文档不存在: ${documentId}`);
      for (const raw of requests as Array<Record<string, any>>) {
        const block = doc.blocks.find((b) => b.id === raw.block_id);
        if (!block) continue;
        const elements = raw.update_text_elements?.elements;
        if (Array.isArray(elements)) {
          block.text = elements.map((e: any) => e.text_run?.content ?? '').join('');
        }

        // `replace_image`：把素材 token 写回图片块。
        //
        // 早先这里被忽略了，于是假飞书里的图片块永远没有 token ——
        // 「拉取远端图片」这条路径根本没被触发过，测试自然发现不了问题。
        // 测试替身漏掉一个状态变更，就会让依赖那个状态的功能整条成为盲区。
        const token = raw.replace_image?.token;
        if (typeof token === 'string' && block.type === 27) {
          block.token = token;
        }
      }
      doc.revision++;
    },

    deleteChildren: async ({
      documentId,
      startIndex,
      endIndex,
    }: {
      documentId: string;
      parentBlockId: string;
      startIndex: number;
      endIndex: number;
    }) => {
      this.writes.push('deleteChildren');
      const doc = this.docs.get(documentId);
      if (!doc) throw new Error(`文档不存在: ${documentId}`);
      doc.blocks.splice(startIndex, endIndex - startIndex);
      doc.revision++;
    },

    createDescendant: async ({
      documentId,
      childrenId,
      descendants,
      index,
    }: {
      documentId: string;
      parentBlockId: string;
      childrenId: string[];
      descendants: unknown[];
      index?: number;
    }) => {
      this.writes.push('createDescendant');
      if (this.consumeFailure('createDescendant')) {
        // 模拟「写到一半挂了」：此时前面的 batch_update 已经生效，
        // 但 descendant 没做完 —— 远端处于半成品状态。
        throw new Error('模拟的 descendant 写入失败');
      }
      const doc = this.docs.get(documentId);
      if (!doc) throw new Error(`文档不存在: ${documentId}`);

      const source = new Map(
        (descendants as FeishuBlock[]).map((b) => [b.block_id, b]),
      );
      const relations = childrenId.map((tmp) => ({ temporary_block_id: tmp, block_id: this.nextId('real') }));

      const inserted: FakeBlock[] = relations.map((rel) => {
        const block = source.get(rel.temporary_block_id);
        return {
          id: rel.block_id,
          type: block?.block_type ?? 2,
          text: extractText(block),
        };
      });

      const at = index === undefined || index < 0 ? doc.blocks.length : index;
      doc.blocks.splice(at, 0, ...inserted);
      doc.revision++;
      return relations;
    },
  };

  // ── wiki ──

  readonly wiki = {
    listChildren: async (_spaceId: string, parentNodeToken?: string): Promise<FakeNode[]> =>
      this.nodes.filter((n) => (n.parent_node_token ?? undefined) === (parentNodeToken || undefined)),

    getNode: async (token: string): Promise<FakeNode | null> =>
      this.nodes.find((n) => n.node_token === token || n.obj_token === token) ?? null,

    createNode: async (params: {
      spaceId: string;
      parentNodeToken?: string;
      title?: string;
    }): Promise<FakeNode> => {
      this.writes.push('createNode');
      const docId = this.nextId('doc');
      const node: FakeNode = {
        node_token: this.nextId('wik'),
        obj_token: docId,
        obj_type: 'docx',
        title: params.title ?? '未命名',
        ...(params.parentNodeToken ? { parent_node_token: params.parentNodeToken } : {}),
      };
      this.nodes.push(node);
      this.docs.set(docId, { id: docId, title: node.title, revision: 1, blocks: [] });
      return node;
    },

  };

  // ── media ──

  /** 已上传素材的字节，供下载接口回放。key 是 file_token。 */
  readonly mediaStore = new Map<string, Buffer>();

  readonly media = {
    uploadImage: async ({
      fileName,
      parentNode,
    }: {
      fileName: string;
      parentNode: string;
    }): Promise<string> => {
      this.writes.push('uploadImage');
      this.uploadedImages.push({ fileName, parentNode });
      const token = `img_${fileName}_${this.seq++}`;
      this.mediaStore.set(token, Buffer.from(`fake-image-bytes:${fileName}`));
      return token;
    },

    downloadImage: async (token: string): Promise<{ content: Buffer; ext: string }> => {
      this.writes.push('downloadImage');
      const content = this.mediaStore.get(token);
      if (!content) throw new Error(`素材不存在: ${token}`);
      return { content, ext: 'png' };
    },
  };

  /** 模拟「上传过但因为别的原因没有素材」的情形，用于验证下载失败时的降级。 */
  forgetMedia(token: string): void {
    this.mediaStore.delete(token);
  }

  /** 让下一次名为 `op` 的写操作失败一次。 */
  failOnce(op: string): void {
    this.failOnceFor = op;
  }

  private consumeFailure(op: string): boolean {
    if (this.failOnceFor !== op) return false;
    this.failOnceFor = null;
    return true;
  }

  // ── 测试辅助 ──

  blockTexts(documentId: string): string[] {
    return (this.docs.get(documentId)?.blocks ?? []).map((b) => b.text);
  }

  blockIds(documentId: string): string[] {
    return (this.docs.get(documentId)?.blocks ?? []).map((b) => b.id);
  }

  clearWrites(): void {
    this.writes.length = 0;
  }

  /**
   * 直接往文档里塞内容。
   *
   * 用于构造「远端本来就有内容」的场景 —— 走 convert 的话会依赖假服务器
   * 那个简化过的 Markdown 解析器，测的就不是被测代码了。
   */
  seedDocument(documentId: string, lines: string[]): void {
    const doc = this.docs.get(documentId);
    if (!doc) throw new Error(`文档不存在: ${documentId}`);
    doc.blocks = lines.map((text) => ({ id: this.nextId('seed'), type: 2, text }));
    doc.revision++;
  }

  /**
   * 造一个「远端已有图片」的文档。
   *
   * 用于验证真正的下载路径：本地没有对应文件、账本里也没有记录
   * —— 只有这时才会去调下载接口（否则会走账本复用）。
   */
  seedImageBlock(documentId: string, token: string, bytes = 'remote-image-bytes'): void {
    const doc = this.docs.get(documentId);
    if (!doc) throw new Error(`文档不存在: ${documentId}`);
    doc.blocks.push({ id: this.nextId('seedimg'), type: 27, text: '', token });
    this.mediaStore.set(token, Buffer.from(bytes));
    doc.revision++;
  }

  /** 模拟「有人在知识库里手工编辑」 */
  editRemotely(documentId: string, index: number, text: string): void {
    const doc = this.docs.get(documentId);
    if (!doc) throw new Error(`文档不存在: ${documentId}`);
    const block = doc.blocks[index];
    if (!block) throw new Error(`索引越界: ${index}`);
    block.text = text;
    doc.revision++;
  }

  private toFeishuBlock(
    b: { id: string; type: number; text: string; token?: string },
    parentId?: string,
  ): FeishuBlock {
    if (b.type === 27) {
      return {
        block_id: b.id,
        block_type: 27,
        image: { ...(b.token ? { token: b.token } : {}) },
        ...(parentId ? { parent_id: parentId } : {}),
      };
    }
    return {
      block_id: b.id,
      block_type: b.type,
      ...(parentId ? { parent_id: parentId } : {}),
      ...(b.type === 14 ? { code: { elements: [{ text_run: { content: b.text } }] } } : {}),
      ...(b.type !== 14 ? { text: { elements: [{ text_run: { content: b.text } }] } } : {}),
    };
  }
}

function extractText(block: FeishuBlock | undefined): string {
  if (!block) return '';
  const payload = (block.text ?? block.code) as { elements?: Array<{ text_run?: { content?: string } }> } | undefined;
  return (payload?.elements ?? []).map((e) => e.text_run?.content ?? '').join('');
}

/**
 * 极简 Markdown → 块。每个非空行一个块；`![...](...)` 行生成 Image 块；
 * ``` 围栏内的行生成代码块。
 */
export function parseMarkdown(
  markdown: string,
  nextId: () => string,
): Array<{ id: string; type: number; text: string }> {
  const out: Array<{ id: string; type: number; text: string }> = [];
  let inFence = false;
  let fenceLines: string[] = [];

  for (const raw of markdown.split(/\r?\n/)) {
    if (raw.trimStart().startsWith('```')) {
      if (inFence) {
        out.push({ id: nextId(), type: 14, text: fenceLines.join('\n') });
        fenceLines = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fenceLines.push(raw);
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    if (/^!\[[^\]]*\]\(/.test(line)) {
      out.push({ id: nextId(), type: 27, text: '' });
      continue;
    }
    out.push({ id: nextId(), type: 2, text: line });
  }
  return out;
}
