import {
  BLOCK_TYPE_KEYS,
  buildTree,
  type BlockTree,
  type FeishuBlock,
  type TextBlockPayload,
  type TextElement,
} from './blocks.js';

/** 用 `convert` 的输出构造块树。 */
export function buildTreeFromConvert(
  blocks: readonly FeishuBlock[],
  firstLevelBlockIds: readonly string[],
): BlockTree {
  const byId = new Map<string, FeishuBlock>();
  for (const b of blocks) byId.set(b.block_id, b);

  // first_level_block_ids 是权威顺序；若它缺失则按 parent_id 兜底
  let topLevel = firstLevelBlockIds.filter((id) => byId.has(id));
  if (topLevel.length === 0) {
    const childIds = new Set<string>();
    for (const b of blocks) for (const c of b.children ?? []) childIds.add(c);
    topLevel = blocks.filter((b) => !childIds.has(b.block_id)).map((b) => b.block_id);
  }
  return { topLevel, byId };
}

/** 按文档顺序列出所有 Image 块（block_type = 27）。 */
export function imageBlockIdsInOrder(tree: BlockTree): string[] {
  const out: string[] = [];
  const visit = (id: string): void => {
    const b = tree.byId.get(id);
    if (!b) return;
    if (b.block_type === 27) out.push(b.block_id);
    for (const c of b.children ?? []) visit(c);
  };
  for (const id of tree.topLevel) visit(id);
  return out;
}

/**
 * 把一组「按出现顺序排列的图片来源」分配给「按文档顺序排列的 Image 块」。
 *
 * 这是**位置配对**而不是 ID 配对。之所以能这么做：Markdown 里图片的出现
 * 顺序与 convert 输出的 Image 块顺序必然一致，而远端块的顺序由上一次同步保证。
 * 于是两侧都能独立算出「第 N 张图对应哪个本地文件」，不需要在账本里存
 * block_id → 路径的映射 —— 那个映射会在块重建时立即失效。
 *
 * 数量不一致时按较短的截断：宁可让多出来的图片指纹退化为「无来源」，
 * 也不要错位配对 —— 错位会把每张图挂到错误的位置上，且不会报错。
 */
export function assignByPosition<T>(tree: BlockTree, items: readonly T[]): Map<string, T> {
  const ids = imageBlockIdsInOrder(tree);
  const map = new Map<string, T>();
  const n = Math.min(ids.length, items.length);
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const item = items[i];
    if (id !== undefined && item !== undefined) map.set(id, item);
  }
  return map;
}

/**
 * 收集一组根块的整棵子树，用于 `descendant` 接口。
 *
 * 官方约束：`children_id` 只列**第一级**子块，`descendants` 则要包含
 * 父块与全部子块。把子块的子块也写进 `children_id` 会报 1770006。
 */
export function collectSubtree(
  byId: Map<string, FeishuBlock>,
  rootIds: readonly string[],
): { childrenId: string[]; descendants: FeishuBlock[] } {
  const descendants: FeishuBlock[] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    if (seen.has(id)) return;
    const block = byId.get(id);
    if (!block) return;
    seen.add(id);
    descendants.push(block);
    for (const child of block.children ?? []) visit(child);
  };

  for (const id of rootIds) visit(id);
  return { childrenId: [...rootIds], descendants };
}

/** 取块的文本元素，用于 `update_text_elements`。 */
export function textElementsOf(block: FeishuBlock | undefined): TextElement[] {
  if (!block) return [];
  const key = BLOCK_TYPE_KEYS[block.block_type];
  if (!key) return [];
  const payload = block[key] as TextBlockPayload | undefined;
  return Array.isArray(payload?.elements) ? payload.elements : [];
}

/** 构造一个「页面」块树，用于把 `GET /blocks` 的结果转成可对齐的形态。 */
export function treeFromRemote(blocks: readonly FeishuBlock[], documentId: string): BlockTree {
  return buildTree(blocks, documentId);
}
