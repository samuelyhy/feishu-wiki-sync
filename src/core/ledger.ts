import fs from 'node:fs';
import { ConfigError } from '../errors.js';
import { ensureConfigDir, ledgerPath } from './config.js';

export interface LedgerImage {
  sha256: string;
  token: string;
}

export interface LedgerDoc {
  /** 知识库节点 ID —— 决定 URL，一旦认领就不再改 */
  node_token: string;
  /** 真实 docx document_id —— 读写内容用它 */
  obj_token: string;
  title: string;
  claimed_by: 'title' | 'manual';
  /** 上次同步时本地文件的内容哈希 */
  local_sha256: string;
  /** 上次同步后远端的 revision —— 漂移检测的依据 */
  remote_revision_id: number;
  /** 本地图片相对路径 → 已上传的素材 token，用于跳过重复上传 */
  images: Record<string, LedgerImage>;
  last_synced_at: string;
  /**
   * 上次同步**中途失败**，远端可能只被改了一半。
   *
   * 这个标记存在的唯一理由是解开一个死锁：写入失败时拿不到新的 `revision_id`，
   * 于是下次运行时「远端 revision 与账本不符」为真，会被漂移保护判定成
   * 「有人手工改过」而**拒绝同步** —— 文档就永远停在半成品状态，
   * 必须人工 `--force`。有了这个标记，已知的自身失败就不会被误判成人工修改。
   */
  needs_resync?: boolean;
}

export interface Ledger {
  version: number;
  space_id: string;
  documents: Record<string, LedgerDoc>;
  /** 手工认领登记，处理本地重命名：旧路径 → node_token */
  aliases: Record<string, string>;
}

const EMPTY = (spaceId: string): Ledger => ({
  version: 1,
  space_id: spaceId,
  documents: {},
  aliases: {},
});

/**
 * 账本存储。
 *
 * ## 为什么账本必须外置于 Dify / 服务端
 *
 * 「上次同步时远端长什么样」是双向合并与漂移检测的前提，
 * 而它必须跨进程、跨机器持久化。放在版本控制里还有个额外好处：
 * 账本随代码一起走分支，不同分支的同步状态互不污染。
 *
 * ## 两条写入纪律
 *
 * 1. **原子写**：先写 `.tmp` 再 rename。直接覆写时若进程被杀，
 *    会留下半截 JSON，下次启动直接解析失败、账本全丢。
 * 2. **逐篇落盘**：每篇文档同步成功立刻 `save()`，而不是整批结束再存。
 *    否则中途失败会丢掉已成功部分的记录，下次重跑做重复劳动 ——
 *    而重复劳动在这里意味着真实的 API 配额消耗。
 */
export class LedgerStore {
  private data: Ledger;

  constructor(
    private readonly cwd: string,
    spaceId: string,
  ) {
    this.data = this.load(spaceId);
  }

  private load(spaceId: string): Ledger {
    const file = ledgerPath(this.cwd);
    if (!fs.existsSync(file)) return EMPTY(spaceId);

    let parsed: Ledger;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger;
    } catch (err) {
      throw new ConfigError(
        `账本 ${file} 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        '若确认账本已损坏，可删除该文件后执行 `fws sync --reclaim` 重新认领（已同步过的文档不会重复创建）',
      );
    }

    const ledger: Ledger = {
      version: parsed.version ?? 1,
      space_id: parsed.space_id ?? spaceId,
      documents: parsed.documents ?? {},
      aliases: parsed.aliases ?? {},
    };

    // 一个 node_token 被两个本地路径引用，意味着两份文件会互相覆盖同一个远端文档。
    // 这是静默数据损坏，必须在加载时就拦下。
    const byNode = new Map<string, string>();
    for (const [p, doc] of Object.entries(ledger.documents)) {
      const prev = byNode.get(doc.node_token);
      if (prev && prev !== p) {
        throw new ConfigError(
          `账本损坏: ${prev} 与 ${p} 指向同一个节点 ${doc.node_token}`,
          '同一节点只能对应一个本地文件。删除账本后执行 `fws sync --reclaim`，或手工修正后重试',
        );
      }
      byNode.set(doc.node_token, p);
    }

    return ledger;
  }

  get raw(): Ledger {
    return this.data;
  }

  get(relPath: string): LedgerDoc | undefined {
    return this.data.documents[relPath];
  }

  set(relPath: string, doc: LedgerDoc): void {
    this.data.documents[relPath] = doc;
  }

  remove(relPath: string): void {
    delete this.data.documents[relPath];
  }

  /** 反查：某节点是否已被别的本地文件认领。 */
  pathForNode(nodeToken: string): string | undefined {
    for (const [p, doc] of Object.entries(this.data.documents)) {
      if (doc.node_token === nodeToken) return p;
    }
    return undefined;
  }

  /** 按旧路径找回已认领的节点（处理本地重命名）。 */
  resolveAlias(relPath: string): string | undefined {
    return this.data.aliases[relPath];
  }

  addAlias(fromPath: string, nodeToken: string): void {
    this.data.aliases[fromPath] = nodeToken;
  }

  save(): void {
    ensureConfigDir(this.cwd);
    const file = ledgerPath(this.cwd);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  paths(): string[] {
    return Object.keys(this.data.documents);
  }
}
