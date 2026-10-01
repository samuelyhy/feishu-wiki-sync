import fs from 'node:fs';
import path from 'node:path';

import { ExitCode } from '../errors.js';
import type { LedgerImage } from '../core/ledger.js';
import { planPull, type PullDeps, type PullEntry, type PullState } from '../core/pull.js';
import { assertNoOverlap, scanMapping } from '../core/scanner.js';
import { sha256 } from '../hash.js';
import type { AppContext } from '../context.js';
import { color } from '../logger.js';
import { matchesPathFilter } from '../paths.js';

/**
 * `fws pull` —— 把远端文档拉下来、与本地比对，语义对齐 git。
 *
 * ## 退出码为什么这样定
 *
 * **0 = 无需从远端拉取**（一致 / 仅本地改动）
 * **3 = 有远端改动待拉取，或存在冲突/往返差异**
 *
 * 这样 `fws pull && fws sync` 就是一个天然的**提交前先拉取**门禁：
 * pull 发现远端有别人改过就返回非 0，shell 的 `&&` 会挡住后面的推送。
 * 这正是「提交前先同步拉取到本地」的落点。
 */
export interface PullOptions {
  /** 实际写入本地文件（默认只报告） */
  write: boolean;
  json: boolean;
  verbose: boolean;
  paths: string[];
}

const STATE_LABEL: Record<PullState, string> = {
  'local-only': '本地新增，远端没有',
  'remote-only': '远端新增，本地没有',
  'in-sync': '一致',
  'local-ahead': '本地领先（待推送）',
  'remote-ahead': '远端领先（待拉取）',
  conflict: '两侧都改过（冲突）',
  'roundtrip-diff': '往返渲染差异',
};

const STATE_ICON: Record<PullState, string> = {
  'local-only': '+',
  'remote-only': '+',
  'in-sync': '·',
  'local-ahead': '↑',
  'remote-ahead': '↓',
  conflict: '!',
  'roundtrip-diff': '?',
};

/** 需要从远端拉到本地的状态。 */
const PULLABLE: ReadonlySet<PullState> = new Set<PullState>(['remote-ahead', 'remote-only']);

/** 需要人来处理、绝不能被 `--write` 自动覆盖的状态。 */
const NEEDS_HUMAN: ReadonlySet<PullState> = new Set<PullState>(['conflict', 'roundtrip-diff']);

export async function runPull(ctx: AppContext, options: PullOptions): Promise<number> {
  // 同 sync / status：文件被两个 mapping 匹配时先修配置
  assertNoOverlap(ctx.cwd, ctx.config.mappings);

  const deps: PullDeps = {
    cwd: ctx.cwd,
    spaceId: ctx.config.spaceId,
    wiki: ctx.wiki,
    docx: ctx.docx,
    ledger: ctx.ledger,
    logger: ctx.logger,
  };

  const entries: PullEntry[] = [];
  for (const mapping of ctx.config.mappings) {
    const planned = await planPull(deps, mapping);
    for (const entry of planned) {
      // 用 mapping 的 source 拼出完整相对路径，方便按路径过滤与落盘
      const full = entry.existsLocally
        ? entry.relPath
        : `${mapping.source}/${entry.relPath}`;
      entries.push({ ...entry, relPath: full });
    }
  }

  const filtered = entries.filter((e) => matchesPathFilter(e.relPath, options.paths));

  if (options.write) {
    await applyPull(ctx, filtered, options);
  }

  report(ctx, filtered, options);
  return exitCodeFor(filtered, options.write);
}

async function applyPull(
  ctx: AppContext,
  entries: readonly PullEntry[],
  options: PullOptions,
): Promise<void> {
  /** 本次拉取落地的图片素材，稍后写进账本 */
  const pulledImages = new Map<string, Record<string, LedgerImage>>();

  for (const entry of entries) {
    if (!PULLABLE.has(entry.state)) {
      if (options.verbose && NEEDS_HUMAN.has(entry.state)) {
        ctx.logger.warn(`  跳过 ${entry.relPath}：${STATE_LABEL[entry.state]}，需人工处理`);
      }
      continue;
    }
    if (entry.remoteMarkdown === undefined) continue;

    const abs = path.join(ctx.cwd, entry.relPath);

    // 远端新增的文档本该落到一个**不存在**的路径上。
    // 若那里已经有文件，说明它被 exclude 规则排除在扫描之外（或刚被别的程序写入）——
    // 此时覆盖它等于删掉一个我们从未读过、也从未纳入同步的文件。
    if (entry.state === 'remote-only' && fs.existsSync(abs)) {
      ctx.logger.warn(
        `  跳过 ${entry.relPath}：本地已存在同名文件（可能被 exclude 规则排除），不覆盖。` +
          `请手工确认后处理`,
      );
      continue;
    }

    const { markdown, images } = await materializeImages(ctx, entry);
    if (Object.keys(images).length > 0) pulledImages.set(entry.relPath, images);

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, markdown, 'utf8');
    ctx.logger.info(`${color.green('↓')} 已写入 ${entry.relPath}`);
  }

  // 把账本对齐到刚拉下来的内容。
  //
  // 不做这一步的话：拉下来的本地文件与账本里的 local_sha256 不一致，
  // 紧接着执行 `fws sync` 会认为「本地改了」而把刚拉下来的内容再推回去 ——
  // 一轮无意义的往返，而且会在远端留下一条 revision 记录。
  for (const mapping of ctx.config.mappings) {
    for (const file of scanMapping(ctx.cwd, mapping)) {
      const entry = entries.find((e) => e.relPath === file.relPath);
      if (!entry || !PULLABLE.has(entry.state) || !entry.nodeToken || !entry.objToken) continue;

      const info = await ctx.docx.getDocument(entry.objToken);
      const previous = ctx.ledger.get(file.relPath);
      ctx.ledger.set(file.relPath, {
        node_token: entry.nodeToken,
        obj_token: entry.objToken,
        title: file.title,
        claimed_by: previous?.claimed_by ?? 'title',
        local_sha256: file.bundleSha256,
        remote_revision_id: info.revision_id,
        // 把刚下载的素材也记上：这样紧接着的 `sync` 会认出「这张图就是远端那张」，
        // 不会重复上传一遍，也不会因为图片来源串变了而重建图片块。
        images: { ...(previous?.images ?? {}), ...(pulledImages.get(file.relPath) ?? {}) },
        last_synced_at: new Date().toISOString(),
      });
    }
  }
  ctx.ledger.save();
}

/**
 * 把渲染出的 `feishu-media:<token>` 占位换成真实图片文件。
 *
 * ## 为什么要连账本一起记
 *
 * 图片块的指纹是拿「来源串 + 内容哈希」算的。占位符的串是 `feishu-media:TOKEN`，
 * 下载后本地文件的串是相对路径 —— 两者不同。若不把「这个本地文件就是那个 token」
 * 记进账本，下一次 `sync` 会认为图片换了，把块重建、重新上传一遍。
 *
 * 下载失败**不致命**：多半是缺 `docs:document.media:download` 权限，
 * 或文档权限里「谁可以创建副本、打印和下载」没放行应用。此时保留占位符并提示，
 * 文档内容本身照样能拉到本地。
 */
async function materializeImages(
  ctx: AppContext,
  entry: PullEntry,
): Promise<{ markdown: string; images: Record<string, LedgerImage> }> {
  const markdown = entry.remoteMarkdown ?? '';
  const images: Record<string, LedgerImage> = {};
  if (!entry.images || entry.images.length === 0) return { markdown, images };

  const mdAbs = path.join(ctx.cwd, entry.relPath);
  const mdDir = path.dirname(mdAbs);
  const assetDirName = path.basename(entry.relPath).replace(/\.md$/i, '');
  const assetDir = path.join(mdDir, 'assets', assetDirName);

  let text = markdown;
  let failed = 0;

  // 账本里已有的素材：复用本地文件，不重新下载。
  // 既省下素材接口的配额（10000 次/天 是硬限），也避免把文件挪到另一个路径上。
  const knownByToken = new Map<string, { relPath: string; entry: LedgerImage }>();
  for (const [relPath, stored] of Object.entries(ctx.ledger.get(entry.relPath)?.images ?? {})) {
    knownByToken.set(stored.token, { relPath, entry: stored });
  }

  for (const image of entry.images) {
    const known = knownByToken.get(image.token);
    if (known && fs.existsSync(path.join(ctx.cwd, known.relPath))) {
      const linkRel = toPosix(path.relative(mdDir, path.join(ctx.cwd, known.relPath)));
      text = text.split(`feishu-media:${image.token}`).join(linkRel);
      images[known.relPath] = known.entry;
      continue;
    }

    try {
      const { content, ext } = await ctx.media.downloadImage(image.token);
      const fileName = `${image.token}.${ext}`;
      const assetAbs = path.join(assetDir, fileName);

      fs.mkdirSync(assetDir, { recursive: true });
      fs.writeFileSync(assetAbs, content);

      const linkRel = toPosix(path.relative(mdDir, assetAbs));
      // 占位符里的 token 是唯一的，直接全文替换即可
      text = text.split(`feishu-media:${image.token}`).join(linkRel);

      images[toPosix(path.relative(ctx.cwd, assetAbs))] = {
        sha256: sha256(content),
        token: image.token,
      };
    } catch {
      failed += 1;
    }
  }

  if (failed > 0) {
    ctx.logger.warn(
      `  ${entry.relPath}：${failed}/${entry.images.length} 张图片下载失败，已保留占位符。` +
        `通常是缺少 docs:document.media:download 权限，` +
        `或文档权限面板里「谁可以创建副本、打印和下载」未放行应用`,
    );
  }

  return { markdown: text, images };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function exitCodeFor(entries: readonly PullEntry[], write: boolean): number {
  if (entries.some((e) => NEEDS_HUMAN.has(e.state))) return ExitCode.AMBIGUOUS;
  if (!write && entries.some((e) => PULLABLE.has(e.state))) return ExitCode.AMBIGUOUS;
  return ExitCode.OK;
}

function report(ctx: AppContext, entries: readonly PullEntry[], options: PullOptions): void {
  const logger = ctx.logger;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        entries.map((e) => ({
          relPath: e.relPath,
          title: e.title,
          state: e.state,
          ...(e.detail ? { detail: e.detail } : {}),
          ...(e.unsupported?.length ? { unsupported: e.unsupported } : {}),
          ...(e.images?.length ? { images: e.images } : {}),
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }

  const counts = new Map<PullState, number>();
  for (const e of entries) counts.set(e.state, (counts.get(e.state) ?? 0) + 1);

  const parts: string[] = [];
  const push = (state: PullState, tint: (s: string) => string): void => {
    const n = counts.get(state) ?? 0;
    if (n > 0) parts.push(tint(`${STATE_ICON[state]} ${STATE_LABEL[state]} ${n}`));
  };

  push('in-sync', color.dim);
  push('local-only', color.green);
  push('local-ahead', color.green);
  push('remote-only', color.blue);
  push('remote-ahead', color.blue);
  push('conflict', color.yellow);
  push('roundtrip-diff', color.yellow);

  logger.info(parts.length > 0 ? parts.join('\n') : '无匹配文件');

  // 逐条列出需要动作的项（一致的不列，免得刷屏）
  const actionable = entries.filter((e) => e.state !== 'in-sync');
  if (options.verbose && actionable.length > 0) {
    logger.info('');
    for (const e of actionable) {
      logger.info(`  ${STATE_ICON[e.state]} ${e.relPath}  ${color.dim(STATE_LABEL[e.state])}`);
      if (e.detail) logger.info(`      ${color.dim(e.detail)}`);
    }
  }

  // 账本里有、但本地文件已经不存在 —— 远端文档成了孤儿。
  //
  // 本工具**不处理本地删除**（飞书没有可用的删除节点 API），所以本地删掉文件后
  // 远端会原样留着。这不丢数据，但很容易被误解成「删本地就等于删远端」，
  // 必须显式说出来，否则知识库里会慢慢积一堆没人知道来源的文档。
  const orphaned = ctx.ledger.paths().filter((p) => !fs.existsSync(path.join(ctx.cwd, p)));
  if (orphaned.length > 0) {
    logger.warn(
      `\n${color.yellow('注意')}：${orphaned.length} 篇文档本地文件已不存在，但远端仍然保留：`,
    );
    for (const p of orphaned.slice(0, 10)) logger.warn(`    ${p}`);
    if (orphaned.length > 10) logger.warn(`    ……还有 ${orphaned.length - 10} 篇`);
    logger.warn(
      `  ${color.dim('本工具不删除知识库节点（飞书没有该 API），需要的话请手工处理。')}`,
    );
  }

  // 往返差异与冲突是「这个文档不适合双向同步」的信号，必须显式提示。
  //
  // 光说「有差异」没有用 —— 用户拿到之后不知道该改什么。所以要把
  // **是哪类块**导致的报出来：那才是可行动的信息。
  const roundtrip = entries.filter((e) => e.state === 'roundtrip-diff');
  if (roundtrip.length > 0) {
    const byType = new Map<string, number>();
    for (const e of roundtrip) {
      for (const block of e.unsupported ?? []) {
        byType.set(block.name, (byType.get(block.name) ?? 0) + 1);
      }
    }

    logger.warn(
      `\n${color.yellow('注意')}：${roundtrip.length} 篇文档存在往返渲染差异 —— ` +
        `它们含 Markdown 表达不了的块，用 pull 覆盖本地会把那些块降级掉。`,
    );

    if (byType.size > 0) {
      const detail = [...byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name}×${n}`)
        .join('、');
      logger.warn(`  涉及的块类型：${detail}`);
      logger.warn(
        `  ${color.dim('这些块在飞书里正常，只是 Markdown 没有对应写法。')}`,
      );
    } else {
      logger.warn(
        `  ${color.dim('未能定位到具体的块类型（可能是样式或嵌套结构差异），' +
          '可用 --json 看完整报告。')}`,
      );
    }

    logger.warn(`  建议：对这几篇只做单向推送（fws sync），不要用 pull 覆盖本地。`);
  }

  const images = entries.reduce((n, e) => n + (e.images?.length ?? 0), 0);
  if (images > 0 && !options.write) {
    logger.info(
      `\n${color.dim(`其中 ${images} 张远端图片会在加 --write 时一并下载到本地 assets/ 下。`)}`,
    );
  }

  if (!options.write) {
    const pending = entries.filter((e) => PULLABLE.has(e.state)).length;
    if (pending > 0) {
      logger.info(`\n${color.blue(`有 ${pending} 篇可拉取`)}，加 --write 写入本地`);
    }
    return;
  }

  // `--write` 会直接覆盖本地文件，而本地文件没有版本历史保护 ——
  // 除非它在 git 里。这里提醒一句，成本极低。
  const overwritten = entries.filter((e) => e.state === 'remote-ahead').length;
  if (overwritten > 0) {
    logger.info(
      `\n${color.dim(`已覆盖 ${overwritten} 个本地文件。若该目录在 git 管理下，` +
        `建议提交前先跑一次 \`git diff\` 复核。`)}`,
    );
  }
}
