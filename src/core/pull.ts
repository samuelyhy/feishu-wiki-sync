import type { DocxApi } from '../feishu/docx.js';
import type { WikiApi, WikiNode } from '../feishu/wiki.js';
import type { Logger } from '../logger.js';
import type { Mapping } from './config.js';
import type { LedgerStore } from './ledger.js';
import { renderBlocks, type UnsupportedBlock } from './render.js';
import { normalizeTitle, scanMapping, type ScannedFile } from './scanner.js';
import { treeFromRemote } from './tree.js';

/**
 * 「远端 → 本地」的关系判定，语义对齐 git 的 status。
 *
 * | 状态 | git 类比 | 含义 |
 * |---|---|---|
 * | `local-only` | 新增（未跟踪） | 本地有、远端没有 → 待推送 |
 * | `remote-only` | 远端有新提交 | 远端有、本地没有 → 待拉取 |
 * | `in-sync` | up to date | 两侧内容一致 |
 * | `local-ahead` | 本地有新提交 | 只有本地改过 → 待推送 |
 * | `remote-ahead` | 远端有新提交 | 只有远端改过 → 待拉取 |
 * | `conflict` | 两边都改了 | 都需要人判断 |
 * | `roundtrip-diff` | ——（本工具特有） | 两侧都没改，但渲染回来的内容与本地不同 |
 *
 * 最后一种是这个工具特有的信号：它说明**往返渲染对该文档不保真**
 * （含飞书特有块、或 Markdown 表达不了的样式）。单独列出来而不是混进
 * `conflict`，是因为处理方式完全不同 —— 前者要么改文档要么接受降级，
 * 后者要人来合并内容。
 */
export type PullState =
  | 'local-only'
  | 'remote-only'
  | 'in-sync'
  | 'local-ahead'
  | 'remote-ahead'
  | 'conflict'
  | 'roundtrip-diff';

export interface PullEntry {
  /** 本地相对路径；`remote-only` 时是按标题推导的建议路径 */
  relPath: string;
  /** 是否已存在于本地 */
  existsLocally: boolean;
  title: string;
  state: PullState;
  nodeToken?: string;
  objToken?: string;
  detail?: string;
  /** 仅需要拉取的状态下填充：渲染出的远端内容 */
  remoteMarkdown?: string;
  unsupported?: UnsupportedBlock[];
  images?: Array<{ blockId: string; token: string }>;
}

export interface PullDeps {
  cwd: string;
  spaceId: string;
  wiki: WikiApi;
  docx: DocxApi;
  ledger: LedgerStore;
  logger: Logger;
}

export interface PullPlan {
  entries: PullEntry[];
  counts: Record<PullState, number>;
}

/**
 * 比较两侧内容。
 *
 * 归一化到「行尾空白无关、连续空行无关、末尾换行无关」——
 * 这些差异不该被当成内容变化，否则每次 pull 都会看到一堆假差异。
 */
export function normalizeForCompare(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function planPull(deps: PullDeps, mapping: Mapping): Promise<PullEntry[]> {
  const files = scanMapping(deps.cwd, mapping);

  // 子节点列表只拉一次。远端文档多时，逐文件各拉一次会让这件事变得很慢，
  // 而且会白白吃掉读配额（5 次/秒）。
  const children = await deps.wiki
    .listChildren(deps.spaceId, mapping.parentNodeToken)
    .catch((err: unknown) => {
      deps.logger.warn(
        `无法列举 ${mapping.source} 的远端节点：${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as WikiNode[];
    });

  const entries: PullEntry[] = [];
  const matchedNodes = new Set<string>();

  for (const file of files) {
    const entry = await classifyLocalFile(deps, file, children);
    if (entry.nodeToken) matchedNodes.add(entry.nodeToken);
    entries.push(entry);
  }

  // 远端有、本地没有 → 待拉取。
  //
  // 但**已被账本认领**的节点不算 —— 它已经有主了，只是这次运行没扫到对应文件
  // （例如用 `fws pull docs/specs` 只看了部分目录）。把它当成「远端新增」
  // 会诱导用户拉一份重复的本地文件。
  for (const node of children) {
    if (matchedNodes.has(node.node_token)) continue;
    if (deps.ledger.pathForNode(node.node_token)) continue;
    entries.push(await describeRemoteOnly(deps, node));
  }

  const counts = emptyCounts();
  for (const e of entries) counts[e.state] += 1;

  return entries;
}

async function classifyLocalFile(
  deps: PullDeps,
  file: ScannedFile,
  children: readonly WikiNode[],
): Promise<PullEntry> {
  const led = deps.ledger.get(file.relPath);

  // 账本优先；没有账本记录时按标题找同名节点（与 sync 的认领规则一致，
  // 两处必须用同一个 normalizeTitle，否则会出现「sync 认领成功、pull 找不到」）
  let node: WikiNode | undefined;
  if (led) {
    node = {
      node_token: led.node_token,
      obj_token: led.obj_token,
      obj_type: 'docx',
      title: led.title,
    };
  } else {
    const want = normalizeTitle(file.title);
    const hits = children.filter((n) => normalizeTitle(n.title) === want);
    if (hits.length === 1) node = hits[0];
  }

  if (!node) {
    return {
      relPath: file.relPath,
      existsLocally: true,
      title: file.title,
      state: 'local-only',
    };
  }

  const rendered = await fetchAndRender(deps, node.obj_token);
  const base: PullEntry = {
    relPath: file.relPath,
    existsLocally: true,
    title: file.title,
    nodeToken: node.node_token,
    objToken: node.obj_token,
    state: 'in-sync',
    unsupported: rendered.unsupported,
    images: rendered.images,
  };

  if (normalizeForCompare(rendered.markdown) === normalizeForCompare(file.content)) {
    return base;
  }

  // 内容确实不同 —— 用账本里存的两个锚点判断是谁改的。
  // 这比「逐块对比」便宜得多，而且账本就是天然的 merge base。
  if (!led) {
    return {
      ...base,
      state: 'local-only',
      detail: '远端有同名文档但内容不同，且尚未建立账本记录',
    };
  }

  const localChanged = led.local_sha256 !== file.bundleSha256;
  const remoteChanged = rendered.revisionId !== led.remote_revision_id;

  if (localChanged && remoteChanged) {
    return { ...base, state: 'conflict', remoteMarkdown: rendered.markdown, detail: '两侧都改过' };
  }
  if (localChanged) return { ...base, state: 'local-ahead', detail: '只有本地改过' };
  if (remoteChanged) {
    return { ...base, state: 'remote-ahead', remoteMarkdown: rendered.markdown, detail: '只有远端改过' };
  }

  // 两个锚点都没动，内容却不同 —— 这就是往返渲染的损耗
  return {
    ...base,
    state: 'roundtrip-diff',
    remoteMarkdown: rendered.markdown,
    detail:
      '两侧都未改动，但渲染回来的内容与本地不同 —— 该文档含 Markdown 无法表达的块。' +
      '这类文档不适合双向同步',
  };
}

async function describeRemoteOnly(deps: PullDeps, node: WikiNode): Promise<PullEntry> {
  const rendered = await fetchAndRender(deps, node.obj_token).catch(() => null);
  return {
    relPath: `${suggestFileName(node.title)}.md`,
    existsLocally: false,
    title: node.title,
    state: 'remote-only',
    nodeToken: node.node_token,
    objToken: node.obj_token,
    ...(rendered
      ? {
          remoteMarkdown: rendered.markdown,
          unsupported: rendered.unsupported,
          images: rendered.images,
        }
      : {}),
  };
}

async function fetchAndRender(
  deps: PullDeps,
  documentId: string,
): Promise<{
  markdown: string;
  unsupported: UnsupportedBlock[];
  images: Array<{ blockId: string; token: string }>;
  revisionId: number;
}> {
  const [blocks, info] = await Promise.all([
    deps.docx.listBlocks(documentId),
    deps.docx.getDocument(documentId),
  ]);
  const rendered = renderBlocks(treeFromRemote(blocks, documentId));
  return { ...rendered, revisionId: info.revision_id };
}

/** 按标题推导本地文件名；去掉文件系统不允许的字符。 */
export function suggestFileName(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, '_').trim() || 'untitled';
}

function emptyCounts(): Record<PullState, number> {
  return {
    'local-only': 0,
    'remote-only': 0,
    'in-sync': 0,
    'local-ahead': 0,
    'remote-ahead': 0,
    conflict: 0,
    'roundtrip-diff': 0,
  };
}
