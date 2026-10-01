import {
  BLOCK_TYPE_KEYS,
  blockTypeName,
  type BlockTree,
  type FeishuBlock,
  type TextBlockPayload,
  type TextElement,
} from './blocks.js';

/**
 * 飞书文档块 → Markdown。
 *
 * ## 为什么需要它
 *
 * 飞书的 `convert` 接口是**单向的**（Markdown → 块），官方没有反向接口。
 * 要让「远端 → 本地」成为可能（`fws pull`、以及双向对比），
 * 只能自己把块渲染回 Markdown。lark-cli 的 `docs +fetch --doc-format markdown`
 * 也是它自己在客户端做的转换，并非平台能力。
 *
 * ## 保真子集
 *
 * 只承诺**子集内往返无损**：
 *
 * | 块类型 | Markdown |
 * |---|---|
 * | 文本 | 段落 |
 * | 标题 1~9 | `#` ~ `#########` |
 * | 无序 / 有序列表 | `- ` / `1. ` |
 * | 代码块 | 围栏 + 语言 |
 * | 引用 | `> ` |
 * | 待办 | `- [ ]` / `- [x]` |
 * | 分割线 | `---` |
 * | 表格 | 管道表格 |
 * | 图片 | `![说明](feishu-media:<token>)`（见下） |
 *
 * 子集之外的块（高亮块 Callout、分栏、画板、思维笔记……）**标记成占位注释**
 * 并**递归渲染其子块**——内容不丢，形态丢失。这一点必须让人看得见，
 * 所以渲染结果会把这些块单独列在 `unsupported` 里。
 *
 * ## 关于图片
 *
 * 远端图片块只有素材 token，没有可直接引用的 URL。这里渲染成
 * `![说明](feishu-media:<token>)` —— 一个**稳定的**占位形式：
 * 往返对比不会因为它产生假差异，但本地 Markdown 预览里显示不出来。
 * 要真正落地图片需要 `drive:document.media:download` 权限并下载素材，
 * 那是独立的一步。
 */

export interface UnsupportedBlock {
  blockId: string;
  type: number;
  name: string;
}

export interface RenderResult {
  markdown: string;
  /** 不能用 Markdown 表达的块。调用方应当把它们呈现给人看。 */
  unsupported: UnsupportedBlock[];
  /** 未能落地的图片（远端素材 token） */
  images: Array<{ blockId: string; token: string }>;
}

export interface RenderOptions {
  /** 在每块前插入 `<!-- block:xxx -->` 注释，用于按 block_id 精确对齐 */
  withBlockIds?: boolean;
}

const MAX_HEADING_LEVEL = 9;

export function renderBlocks(tree: BlockTree, options: RenderOptions = {}): RenderResult {
  const unsupported: UnsupportedBlock[] = [];
  const images: Array<{ blockId: string; token: string }> = [];

  const body = tree.topLevel
    .map((id) => renderBlock(id, tree, options, unsupported, images, 0))
    .filter((s) => s !== null);

  // 只裁**尾部**空白，绝不整体 trim()。
  // 整体 trim 会把首块的行首缩进一起吃掉 —— 一篇以缩进列表项开头的文档，
  // 渲染回来就少了缩进，而下一次对比会把这当成「远端变了」，产生幽灵变更。
  const text = body
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');

  return {
    markdown: `${text}\n`,
    unsupported,
    images,
  };
}

function renderBlock(
  blockId: string,
  tree: BlockTree,
  options: RenderOptions,
  unsupported: UnsupportedBlock[],
  images: Array<{ blockId: string; token: string }>,
  depth: number,
): string | null {
  const block = tree.byId.get(blockId);
  if (!block) return null;

  const prefix = options.withBlockIds ? `<!-- block:${blockId} -->\n` : '';
  const withPrefix = (s: string): string => `${prefix}${s}`;

  // 页面块只作为容器，不产出自身内容
  if (block.block_type === 1) return null;

  if (depth > 20) return null;

  switch (block.block_type) {
    case 2: // 文本
      return withPrefix(inlineOf(block));

    case 22: // 分割线
      return withPrefix('---');

    case 27: {
      const token = block.image?.token ?? '';
      const caption = block.image?.caption?.content ?? '';
      if (token) images.push({ blockId, token });
      // 稳定的占位形式：往返对比不会因它产生假差异
      return withPrefix(`![${escapeInline(caption)}](feishu-media:${token})`);
    }

    case 31: // 表格
      return withPrefix(renderTable(block, tree, options, unsupported, images));

    case 14: {
      // 代码块：语言用枚举号表达，无法还原成名字，因此留空围栏
      const lang = codeLanguageName(block);
      const code = textOfBlock(block);
      return withPrefix(`\`\`\`${lang}\n${code}\n\`\`\``);
    }

    default:
      break;
  }

  if (block.block_type >= 3 && block.block_type <= 11) {
    const level = Math.min(block.block_type - 2, MAX_HEADING_LEVEL);
    return withPrefix(`${'#'.repeat(level)} ${inlineOf(block)}`);
  }

  if (block.block_type === 12 || block.block_type === 13 || block.block_type === 17) {
    return withPrefix(renderListItem(block));
  }

  if (block.block_type === 15) {
    // 引用：逐行加 `> `
    return withPrefix(
      inlineOf(block)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n'),
    );
  }

  // ── 到这里都是 Markdown 表达不了的块 ──
  //
  // 策略：标记成占位注释，但**递归渲染子块**，让内容不丢。
  // 用户能看到「这里原本有个高亮块」，内容还在，只是形态没了。
  unsupported.push({ blockId, type: block.block_type, name: blockTypeName(block.block_type) });

  const children = (block.children ?? [])
    .map((cid) => renderBlock(cid, tree, options, unsupported, images, depth + 1))
    .filter((s): s is string => s !== null);

  const marker = options.withBlockIds
    ? `<!-- fws-unsupported:${block.block_type} id=${blockId} -->`
    : `<!-- fws-unsupported:${block.block_type} -->`;

  return children.length > 0 ? `${marker}\n${children.join('\n\n')}` : marker;
}

function renderListItem(block: FeishuBlock): string {
  const payload = payloadOf(block);
  const indent = '  '.repeat(Math.min(payload?.style?.indentation_level ?? 0, 10));
  const text = inlineOf(block);

  const marker =
    block.block_type === 12 ? '-' : block.block_type === 13 ? '1.' : payload?.style?.done ? '- [x]' : '- [ ]';

  return `${indent}${marker} ${text}`;
}

function renderTable(
  block: FeishuBlock,
  tree: BlockTree,
  options: RenderOptions,
  unsupported: UnsupportedBlock[],
  images: Array<{ blockId: string; token: string }>,
): string {
  const rows = (block.children ?? [])
    .map((id) => tree.byId.get(id))
    .filter((b): b is FeishuBlock => b !== undefined && b.block_type === 32);

  const cells = rows.map((row) =>
    (row.children ?? []).map((cellId) => {
      const cell = tree.byId.get(cellId);
      if (!cell) return '';
      return (cell.children ?? [])
        .map((cid) => renderBlock(cid, tree, options, unsupported, images, 0))
        .filter((s): s is string => s !== null)
        .join('<br>')
        .replace(/\|/g, '\\|')
        .replace(/\n+/g, '<br>');
    }),
  );

  if (cells.length === 0) return '<!-- 空表格 -->';

  const width = Math.max(...cells.map((r) => r.length));
  const pad = (row: string[]): string[] =>
    Array.from({ length: width }, (_, i) => row[i] ?? '');

  const [header, ...rest] = cells.map(pad);
  const lines = [
    `| ${header!.join(' | ')} |`,
    `| ${header!.map(() => '---').join(' | ')} |`,
    ...rest.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

// ─────────────────────────── 行内内容 ───────────────────────────

function inlineOf(block: FeishuBlock): string {
  const payload = payloadOf(block);
  if (!Array.isArray(payload?.elements)) return '';
  return payload.elements.map(renderElement).join('');
}

function renderElement(el: TextElement): string {
  if (el.text_run) {
    const raw = el.text_run.content ?? '';
    const style = el.text_run.text_element_style ?? {};

    // 行内代码里的内容是字面量，绝不能转义或加样式标记
    if (style.inline_code) {
      return `\`${raw.replace(/`/g, '\\`')}\``;
    }

    let text = escapeInline(raw);
    // 由内向外包裹：先强调，再链接
    if (style.strikethrough) text = `~~${text}~~`;
    if (style.italic) text = `*${text}*`;
    if (style.bold) text = `**${text}**`;
    if (style.link?.url) text = `[${text}](${style.link.url})`;
    return text;
  }

  if (el.equation) return `$${el.equation.content ?? ''}$`;
  if (el.mention_user) return `@${el.mention_user.user_id ?? ''}`;
  if (el.mention_doc) return `@${el.mention_doc.title ?? el.mention_doc.token ?? ''}`;
  return '';
}

/**
 * 行内转义。
 *
 * 刻意**只转义会改变语义的字符**，不多转：
 * 多转会在往返对比时造出假差异 —— 本地写 `2*3`，渲染成 `2\*3`，
 * 下次对比就认为「远端变了」。宁可偶尔少转，也不要制造噪音。
 */
function escapeInline(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]])/g, '\\$1')
    .replace(/^(\s*)([#>|-])/m, '$1\\$2');
}

function textOfBlock(block: FeishuBlock): string {
  const payload = payloadOf(block);
  if (!Array.isArray(payload?.elements)) return '';
  return payload.elements
    .map((el) => el.text_run?.content ?? el.equation?.content ?? '')
    .join('');
}

function payloadOf(block: FeishuBlock): TextBlockPayload | undefined {
  const key = BLOCK_TYPE_KEYS[block.block_type];
  return key ? (block[key] as TextBlockPayload | undefined) : undefined;
}

/**
 * 代码块语言。
 *
 * 飞书用 1~75 的枚举号表示语言，而 Markdown 围栏要的是名字。
 * 只映射最常用的几个；其余留空 —— **留空是安全的**（代码内容不受影响），
 * 而猜错语言会让下次同步把语言改掉，那才是真问题。
 */
function codeLanguageName(block: FeishuBlock): string {
  const lang = payloadOf(block)?.style?.language;
  if (typeof lang !== 'number') return '';
  return CODE_LANGUAGES[lang] ?? '';
}

const CODE_LANGUAGES: Record<number, string> = {
  7: 'bash',
  22: 'go',
  28: 'json',
  29: 'java',
  30: 'javascript',
  39: 'markdown',
  49: 'python',
  56: 'sql',
  60: 'shell',
  63: 'typescript',
  66: 'xml',
  67: 'yaml',
  75: 'toml',
};
