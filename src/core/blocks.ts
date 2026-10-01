import { createHash } from 'node:crypto';

/**
 * 飞书文档块的类型、文本抽取、归一化与指纹。
 *
 * ## 为什么需要指纹
 *
 * `convert` 接口吃 Markdown 文本、吐的是**临时 ID** —— 本地 md 没有任何办法
 * 携带远端的 `block_id`。所以「本地第 N 个块对应远端哪个块」只能靠内容指纹对齐。
 * 整个同步算法的正确性都建立在指纹的稳定性上。
 *
 * ## 指纹设计的两条纪律
 *
 * 1. **必须包含样式**。否则「给某个词加粗」会被判成「没变」而静默漏更。
 * 2. **归一化必须保守**。归一化过度会造成「明明变了却判为没变」——
 *    这比误报严重得多，因为误报只是多一次调用，漏更会让远端内容永久落后。
 */

/** block_type → 该块内容所在的字段名。 */
export const BLOCK_TYPE_KEYS: Readonly<Record<number, string>> = {
  1: 'page',
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  9: 'heading7',
  10: 'heading8',
  11: 'heading9',
  12: 'bullet',
  13: 'ordered',
  14: 'code',
  15: 'quote',
  17: 'todo',
  18: 'bitable',
  19: 'callout',
  20: 'chat_card',
  21: 'diagram',
  22: 'divider',
  23: 'file',
  24: 'grid',
  25: 'grid_column',
  26: 'iframe',
  27: 'image',
  28: 'isv',
  29: 'mindnote',
  30: 'sheet',
  31: 'table',
  32: 'table_cell',
  33: 'view',
  34: 'quote_container',
  35: 'task',
  40: 'add_ons',
  41: 'jira_issue',
  42: 'wiki_catalog',
  43: 'board',
  48: 'link_preview',
  49: 'source_synced',
  50: 'reference_synced',
  51: 'sub_page_list',
  52: 'ai_template',
};

/** 块类型的中文名，用于给人看的诊断输出（`fws doctor`）。 */
export function blockTypeName(type: number): string {
  if (type >= 3 && type <= 11) return `标题${type - 2}`;
  switch (type) {
    case 1:
      return '页面';
    case 2:
      return '文本';
    case 12:
      return '无序列表';
    case 13:
      return '有序列表';
    case 14:
      return '代码块';
    case 15:
      return '引用';
    case 17:
      return '待办';
    case 19:
      return '高亮块';
    case 22:
      return '分割线';
    case 27:
      return '图片';
    case 31:
      return '表格';
    case 32:
      return '单元格';
    default:
      return BLOCK_TYPE_KEYS[type] ?? `类型${type}`;
  }
}

/** 自带文本内容的块类型（其余的内容在 children 里）。 */
export const TEXT_BEARING_TYPES: ReadonlySet<number> = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17,
]);

export interface TextElementStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  inline_code?: boolean;
  background_color?: number;
  text_color?: number;
  link?: { url?: string };
}

export interface TextElement {
  text_run?: { content?: string; text_element_style?: TextElementStyle };
  mention_user?: { user_id?: string };
  mention_doc?: { token?: string; title?: string };
  equation?: { content?: string };
  reminder?: unknown;
}

export interface TextBlockPayload {
  style?: {
    align?: number;
    done?: boolean;
    folded?: boolean;
    language?: number;
    wrap?: boolean;
    background_color?: string;
    indentation_level?: number;
    sequence?: string | number;
  };
  elements?: TextElement[];
}

export interface FeishuBlock {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  image?: { token?: string; width?: number; height?: number; align?: number; caption?: { content?: string } };
  table?: { property?: unknown };
  [key: string]: unknown;
}

export interface BlockTree {
  /** 顶层块的 block_id 顺序。 */
  topLevel: string[];
  byId: Map<string, FeishuBlock>;
}

/** 把 `GET /blocks` 返回的先序数组整理成父子结构。 */
export function buildTree(blocks: readonly FeishuBlock[], rootBlockId: string): BlockTree {
  const byId = new Map<string, FeishuBlock>();
  for (const b of blocks) byId.set(b.block_id, b);

  const root = byId.get(rootBlockId);
  // 服务端返回先序数组，children 字段已给出顺序；缺失时按 parent_id 兜底重建。
  let topLevel = root?.children?.filter((id) => byId.has(id)) ?? [];
  if (topLevel.length === 0) {
    topLevel = blocks
      .filter((b) => b.parent_id === rootBlockId)
      .map((b) => b.block_id);
  }
  return { topLevel, byId };
}

/**
 * 抽取块的纯文本。用于相似度比较，也用于 code 块的指纹。
 *
 * 刻意不处理 mention/equation 的显示形态 —— 只要**稳定**即可，
 * 不要求与人眼所见一致。
 */
export function textOf(block: FeishuBlock): string {
  const key = BLOCK_TYPE_KEYS[block.block_type];
  if (!key) return '';
  const payload = block[key] as TextBlockPayload | undefined;
  const elements = payload?.elements;
  if (!Array.isArray(elements)) return '';

  let out = '';
  for (const el of elements) {
    if (el.text_run) out += el.text_run.content ?? '';
    else if (el.equation) out += el.equation.content ?? '';
    else if (el.mention_user) out += `@${el.mention_user.user_id ?? ''}`;
    else if (el.mention_doc) out += `@${el.mention_doc.token ?? ''}`;
    else if (el.reminder) out += '<reminder>';
  }
  return out;
}

/**
 * 文本归一化。
 *
 * **代码块不做空白折叠** —— 代码里缩进与换行是有语义的，
 * 折叠后两个不同的代码片段会被判为同一个。
 */
export function normalizeText(text: string, blockType: number): string {
  if (blockType === 14) {
    // 代码块：仅去首尾空白与行尾空格，保留内部结构
    return text.replace(/[ \t]+$/gm, '').trim();
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** 元素级样式签名。漏掉这里的任何一个字段都会造成「改了却判为没变」。 */
function elementStyleSignature(el: TextElement): string {
  if (el.text_run) {
    const s = el.text_run.text_element_style;
    if (!s) return '';
    const flags: string[] = [];
    if (s.bold) flags.push('b');
    if (s.italic) flags.push('i');
    if (s.strikethrough) flags.push('s');
    if (s.underline) flags.push('u');
    if (s.inline_code) flags.push('c');
    if (s.text_color !== undefined) flags.push(`tc${s.text_color}`);
    if (s.background_color !== undefined) flags.push(`bg${s.background_color}`);
    if (s.link?.url) flags.push(`l:${s.link.url}`);
    return flags.join(',');
  }
  if (el.equation) return 'eq';
  if (el.mention_user) return 'mu';
  if (el.mention_doc) return 'md';
  if (el.reminder) return 'rm';
  return '';
}

/**
 * 块级样式签名（对齐、缩进、代码语言等）。
 *
 * **必须导出**：`batch_update` 的 `update_text_elements` 只改文本元素，
 * 改不了这些块级样式。所以「代码块只换了语言」这种变更**不能**配对成
 * UPDATE —— 配对了会静默无效（文本没变、语言也没变，同步报成功但远端没更新）。
 * 对齐逻辑用这个签名做前置判断，不相等就退化为删+插。
 */
export function blockStyleSignature(block: FeishuBlock): string {
  const key = BLOCK_TYPE_KEYS[block.block_type];
  if (!key) return '';
  const payload = block[key] as TextBlockPayload | undefined;
  const s = payload?.style;
  if (!s) return '';

  const parts: string[] = [];
  if (s.align !== undefined) parts.push(`a${s.align}`);
  if (s.done) parts.push('done');
  if (s.folded) parts.push('folded');
  // 代码语言必须进指纹：改了语言而代码没变，也是需要同步的变更
  if (s.language !== undefined) parts.push(`lang${s.language}`);
  if (s.indentation_level !== undefined) parts.push(`ind${s.indentation_level}`);
  if (s.background_color) parts.push(`bgc${s.background_color}`);
  return parts.join(',');
}

/**
 * 图片块的指纹依据。
 *
 * 这是个**特殊难点**：本地 convert 出来的 Image 块 `token` 为空
 * （飞书不会自动抓取 Markdown 里的图片链接），而远端块有真实 token。
 * 若把 token 计入指纹，本地与远端永远不匹配 → 每张图都会被判成「删+增」。
 *
 * 解法：用**图片来源**（本地相对路径）而不是 token 做指纹。
 * 远端侧的来源路径由账本提供，从而与本地侧对齐。
 */
export type ImageSourceResolver = (blockId: string) => string | undefined;

export interface FingerprintContext {
  /** block_id → 本地图片相对路径。用于让远端图片块与本地对齐。 */
  imageSource?: ImageSourceResolver;
}

/**
 * 计算块的指纹。
 *
 * 该块**整体**的指纹包含其后代（容器块递归），因为容器内容的任何变化
 * 都意味着这个容器需要被替换。
 */
export function fingerprint(
  block: FeishuBlock,
  byId: Map<string, FeishuBlock>,
  ctx: FingerprintContext = {},
  depth = 0,
): string {
  const parts: string[] = [`t${block.block_type}`];

  if (TEXT_BEARING_TYPES.has(block.block_type)) {
    parts.push(normalizeText(textOf(block), block.block_type));
    parts.push(blockStyleSignature(block));
    // 元素级样式：逐元素拼，保证「某一段加粗」能被检出
    const key = BLOCK_TYPE_KEYS[block.block_type];
    const payload = key ? (block[key] as TextBlockPayload | undefined) : undefined;
    for (const el of payload?.elements ?? []) {
      parts.push(elementStyleSignature(el));
    }
  } else if (block.block_type === 27) {
    const src = ctx.imageSource?.(block.block_id);
    const caption = block.image?.caption?.content ?? '';
    parts.push(src ? `src:${src}` : `cap:${normalizeText(caption, 2)}`);
    parts.push(`d${block.image?.width ?? ''}x${block.image?.height ?? ''}`);
  } else if (block.block_type === 22) {
    // divider 无内容
  } else {
    parts.push(JSON.stringify(block[BLOCK_TYPE_KEYS[block.block_type] ?? ''] ?? null));
  }

  // 递归子块。深度设上限防御异常结构（飞书层级上限未公布具体数值）。
  if (depth < 20) {
    for (const childId of block.children ?? []) {
      const child = byId.get(childId);
      if (child) parts.push(fingerprint(child, byId, ctx, depth + 1));
    }
  }

  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

/**
 * 递归剥掉 Table 块的 `merge_info`。
 *
 * 官方明确：`merge_info` 是**只读**属性，把 convert 的输出原样喂给 descendant
 * 会直接报错。这是必须写死的前置处理，漏了含表格的文档会稳定失败。
 */
export function stripMergeInfo(blocks: unknown[]): unknown[] {
  return blocks.map((raw) => {
    if (raw === null || typeof raw !== 'object') return raw;
    const block = { ...(raw as Record<string, unknown>) };
    const table = block.table as Record<string, unknown> | undefined;
    if (table && typeof table === 'object') {
      const property = table.property as Record<string, unknown> | undefined;
      if (property && typeof property === 'object' && 'merge_info' in property) {
        const { merge_info: _drop, ...rest } = property;
        block.table = { ...table, property: rest };
      }
    }
    return block;
  });
}

/** 判断块是否能用 batch_update 原地更新（保住 block_id 与评论）。 */
export function isUpdatableInPlace(block: FeishuBlock | undefined): boolean {
  if (!block) return false;
  if (!TEXT_BEARING_TYPES.has(block.block_type)) return false;
  // page 块不参与内容更新
  return block.block_type !== 1;
}
