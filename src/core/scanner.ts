import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../errors.js';
import { shouldInclude } from '../glob.js';
import { sha256 } from '../hash.js';
import type { Mapping } from './config.js';

export interface ScannedFile {
  /** 相对工程根的路径，作为账本键 */
  relPath: string;
  absPath: string;
  /** 相对于 mapping.source 的路径，mirror 模式下用于建目录层级 */
  sourceRel: string;
  content: string;
  sha256: string;
  /**
   * 正文 + 全部引用图片的合成哈希，用于判断「这个文件整体变了吗」。
   *
   * **变更检测必须用它而不是 `sha256`**：只改图片不改正文时，
   * Markdown 文本一字未动，但文档内容确实变了。只看正文哈希会让这种
   * 情形被快路径判为「无变化」而永远同步不过去 —— 这是一个不会报错的静默失败。
   */
  bundleSha256: string;
  /**
   * Markdown 中出现的**全部**图片引用，严格按出现顺序。
   *
   * 两条不能动摇的约束：
   *
   * 1. **一个都不能滤掉。** `convert` 会把远程 URL 图片也转成 Image 块
   *    （只是 token 为空）。若抽取时把远程图过滤掉，按位置配对就会整体错位 ——
   *    本地图会被挂到远程图的块上，而且**不会报错**。
   * 2. **必须带内容哈希而不只是路径。** 「重新导出的架构图仍叫 `flow.png`」
   *    是常见情形，只按路径做指纹会把它判为「没变」而永远同步不过去。
   */
  images: ImageRef[];
  /** 远端文档标题 */
  title: string;
}

export interface ImageRef {
  /**
   * Markdown 里原始的目标串（远程 URL 或本地路径）。
   *
   * 指纹用它而不是解析后的路径：远程图与本地图各自稳定，
   * 且同一个字符串在本地侧与远端侧能算出同一个键。
   */
  src: string;
  /** 本地文件的工程相对路径；远程图片为 undefined */
  relPath?: string;
  /** 本地文件的绝对路径；远程图片为 undefined */
  absPath?: string;
  /**
   * 内容哈希。远程图片为 `external`，本地文件读不到时为 `missing`
   * —— 两者都是稳定的哨兵值，不会被误当成「内容没变」。
   */
  sha256: string;
  /** 是否需要上传素材 */
  local: boolean;
}

/**
 * 行内图片：`![alt](dest)`、`![alt](dest "title")`、`![alt](<dest with space>)`。
 *
 * 目标串允许被尖括号包裹，否则带空格的路径（`![x](my pic.png)`）会匹配不到 ——
 * 漏掉一个就是一个位置偏移。
 */
const IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/**
 * 扫描一个 mapping 覆盖的本地文件。
 *
 * 排序是刻意为之：结果顺序稳定，才能让 `--dry-run` 的输出可 diff、
 * 让同步顺序可预测。文件系统返回的顺序不保证稳定。
 */
export function scanMapping(cwd: string, mapping: Mapping): ScannedFile[] {
  const root = path.join(cwd, mapping.source);
  if (!fs.existsSync(root)) return [];

  const out: ScannedFile[] = [];
  for (const absPath of walk(root)) {
    const relPath = toPosix(path.relative(cwd, absPath));
    if (!shouldInclude(relPath, mapping.include, mapping.exclude)) continue;

    const content = fs.readFileSync(absPath, 'utf8');
    const images = resolveImages(content, path.dirname(absPath), cwd);
    out.push({
      relPath,
      absPath,
      sourceRel: toPosix(path.relative(root, absPath)),
      content,
      sha256: sha256(content),
      bundleSha256: bundleHash(content, images),
      images,
      title: deriveTitle(content, relPath),
    });
  }

  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

/**
 * 找出被**多个 mapping 同时匹配**的文件。
 *
 * 这是替代「禁止 source 嵌套」那条启发式规则的精确判据。
 * 路径嵌套本身无害 —— 有害的是同一个文件被处理两次（会建出两份远端文档，
 * 而且之后每次同步都在两者之间来回覆盖）。
 */
export function findOverlappingFiles(
  cwd: string,
  mappings: readonly Mapping[],
): Array<{ relPath: string; sources: string[] }> {
  const owner = new Map<string, string[]>();

  for (const m of mappings) {
    for (const file of scanMapping(cwd, m)) {
      const list = owner.get(file.relPath);
      if (list) list.push(m.source);
      else owner.set(file.relPath, [m.source]);
    }
  }

  return [...owner.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([relPath, sources]) => ({ relPath, sources }));
}

/**
 * 断言没有任何文件被两个 mapping 匹配。
 *
 * 会真的扫一遍目录。调用方通常紧接着也要扫，代价是重复读一遍文件 ——
 * 对这个量级（百篇文档）可以忽略，换来的是「配置是否安全」这个判断
 * 从猜路径形态变成看实际匹配结果。
 */
export function assertNoOverlap(cwd: string, mappings: readonly Mapping[]): void {
  const overlapping = findOverlappingFiles(cwd, mappings);
  if (overlapping.length === 0) return;

  const sample = overlapping
    .slice(0, 3)
    .map((o) => `${o.relPath}（${o.sources.join(' 与 ')}）`)
    .join('\n  ');
  const more = overlapping.length > 3 ? `\n  ……还有 ${overlapping.length - 3} 个` : '';

  throw new ConfigError(
    `${overlapping.length} 个文件被多个 mapping 同时匹配：\n  ${sample}${more}`,
    '同一文件只能由一个 mapping 处理。若两个 source 是父子目录，' +
      '给上层那个加 include（例如 ["*.md"] 只吃根层文件）让它们的文件集不相交',
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 正文 + 图片清单的合成哈希。图片顺序参与计算，增删图片同样会改变它。 */
export function bundleHash(content: string, images: readonly ImageRef[]): string {
  const parts = [content, ...images.map((i) => `${i.src}\u0000${i.sha256}`)];
  return sha256(parts.join('\u0001'));
}

function resolveImages(markdown: string, mdDir: string, cwd: string): ImageRef[] {
  return extractImageRefs(markdown).map((src) => {
    if (isRemote(src)) {
      // 远程图片：飞书不会替我们抓取外链，所以不上传。
      // 但它仍会占用一个 Image 块的位置，必须留在列表里。
      return { src, sha256: 'external', local: false };
    }

    const decoded = safeDecode(src.split('#')[0]?.split('?')[0] ?? src);
    const abs = path.resolve(mdDir, decoded);
    const relPath = toPosix(path.relative(cwd, abs));

    let hash = 'missing';
    try {
      hash = sha256(fs.readFileSync(abs));
    } catch {
      // 文件不存在或不可读。**不能跳过这一项** —— 跳了就会与后面的图片错位。
      // 用 'missing' 这个稳定哨兵值参与指纹：远端侧算出来必然不同，
      // 于是该 Image 块会被重建、位置留空。这是可接受的降级，
      // 而错位把图片挂到别的块上是不可接受的。
    }
    return { src, relPath, absPath: abs, sha256: hash, local: true };
  });
}

function isRemote(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src);
}

/**
 * 按出现顺序抽取 Markdown 中**全部**图片引用（含远程）。
 *
 * ## 为什么不过滤远程图片
 *
 * `convert` 会把远程 URL 图片也转成 Image 块（只是 token 为空）。
 * 抽取时若把远程图滤掉，按位置配对就会整体错位：远程图之后的每一张本地图
 * 都会被挂到前一个块上 —— 而且全程不报错。所以这里一个都不能少。
 *
 * ## 关于代码围栏
 *
 * 围栏代码块里的 `![](x.png)` 是**代码文本**，`convert` 不会为它生成 Image 块。
 * 若这里把它算作图片，同样会造成错位，因此要跳过围栏内的内容。
 *
 * ## 明确不支持的写法
 *
 * HTML `<img>` 标签、以及 `convert` 自己不认的方言。这类情况下的错位风险
 * 由 syncer 里的一道断言兜住：抽取到的图片数与 convert 产出的 Image 块数
 * 不一致时**直接报错**，而不是猜着配对。
 */
export function extractImageRefs(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence?.[1]) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0]!;
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    IMAGE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMAGE_RE.exec(line)) !== null) {
      const raw = m[1]?.trim();
      if (!raw || raw.startsWith('#')) continue;
      // 尖括号包裹的写法：`![x](<a b.png>)`
      out.push(raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw);
    }
  }

  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 推导远端文档标题。
 *
 * 优先级：front-matter 的 `title` → 第一个一级标题 → 文件名。
 *
 * 这个顺序不是随手定的：文件名往往是 `01-domain` 这种代号，
 * 而文档标题才是人认得出的名字。知识库里按标题匹配同名文档，
 * 因此标题推导必须与团队实际写文档的习惯一致 —— 若你们的文档
 * 靠文件名识别，请把 `01-domain` 当作标题，而不是被 `# 领域模型` 覆盖。
 */
export function deriveTitle(content: string, relPath: string): string {
  const fm = parseFrontMatter(content);
  if (fm.title) return fm.title;

  const heading = content.match(/^#[ \t]+(.+)$/m);
  if (heading?.[1]) {
    const t = heading[1].trim();
    if (t) return t;
  }

  const base = relPath.split('/').pop() ?? relPath;
  return base.replace(/\.(md|markdown|mark)$/i, '');
}

export interface FrontMatter {
  title?: string;
  [key: string]: unknown;
}

/**
 * 标题匹配用的归一化。
 *
 * 全角转半角、折叠空白、忽略大小写 —— 目的是让「团队里两个人写的同一个标题」
 * 能匹配上。`sync` 认领与 `pull` 比对**必须用同一套规则**，
 * 否则会出现「sync 说认领成功、pull 说找不到」这种自相矛盾的状态。
 */
export function normalizeTitle(s: string): string {
  return s
    .trim()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * 极简 front-matter 解析。
 *
 * 只认顶层 `key: value`，不处理嵌套（YAML 子结构对本工具无意义，
 * 真需要时标题也不会藏在嵌套里）。刻意不引 YAML 解析器：
 * 这里的失败模式必须是「忽略」，而不是「抛错导致整个文件同步不了」。
 */
export function parseFrontMatter(content: string): FrontMatter {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end < 0) return {};

  const body = content.slice(3, end);
  const out: FrontMatter = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = (m[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
