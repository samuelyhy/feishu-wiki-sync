import fs from 'node:fs';
import path from 'node:path';

import { ExitCode } from '../errors.js';
import { assertNoOverlap, scanMapping } from '../core/scanner.js';
import type { AppContext } from '../context.js';
import { color, type Logger } from '../logger.js';
import { matchesPathFilter } from '../paths.js';

export interface StatusOptions {
  /** 额外做远端漂移检查（每篇文档 1 次读请求） */
  remote?: boolean;
  json?: boolean;
  paths?: string[];
  verbose?: boolean;
}

export interface StatusReport {
  file: string;
  relPath: string;
  state: 'unclaimed' | 'unchanged' | 'modified' | 'drift' | 'unknown';
  nodeToken?: string;
  detail?: string;
}

export async function runStatus(
  ctx: AppContext,
  options: StatusOptions,
): Promise<{ code: number; report: StatusReport[] }> {
  const { logger } = ctx;
  const report: StatusReport[] = [];

  // 与 sync / pull 用同一道检查：文件被两个 mapping 匹配时，
  // 必须先修配置再看状态，否则报出来的数字本身就是错的
  assertNoOverlap(ctx.cwd, ctx.config.mappings);

  for (const mapping of ctx.config.mappings) {
    // 分开记「扫描结果」与「过滤结果」：
    // 被命令行的路径参数过滤掉是正常操作，不该触发「匹配不到文件」的告警。
    // 混在一起的话，`fws status <某个产品>` 会为其余 14 个 mapping 各刷一条假警报，
    // 而假警报多了，真警报就没人看了。
    const scanned = scanMapping(ctx.cwd, mapping);
    const files = scanned.filter((f) => matchesPathFilter(f.relPath, options.paths ?? []));

    if (files.length === 0) {
      // 扫描本身有结果、只是被路径参数滤掉了 —— 正常，静默跳过
      if (scanned.length > 0) continue;

      // 「匹配不到任何文件」是最危险的失败模式：它不报错，只是安静地什么都不做，
      // 而用户会以为配置生效了。所以这里必须区分「目录不存在」与「目录在、
      // 但模式没匹配上」—— 后者的成因几乎总是把 include 写成了 source 相对路径。
      if (fs.existsSync(path.join(ctx.cwd, mapping.source))) {
        logger.warn(
          `${color.yellow('!')} ${mapping.source}: 目录存在，但没有任何文件匹配 include/exclude\n` +
            `    include: ${JSON.stringify(mapping.include)}\n` +
            `    ${color.dim(
              '注意：include 匹配的是【工程根相对路径】，不是 source 相对路径。' +
                `例如 source 为 products 时要写 "products/*.md"，写成 "*.md" 会一个都匹配不到。`,
            )}`,
        );
      } else {
        logger.warn(`${color.yellow('!')} ${mapping.source}: 目录不存在`);
      }
      continue;
    }

    let unclaimed = 0;
    let unchanged = 0;
    let modified = 0;

    for (const file of files) {
      const led = ctx.ledger.get(file.relPath);
      if (!led) {
        unclaimed++;
        report.push({ file: mapping.source, relPath: file.relPath, state: 'unclaimed' });
        continue;
      }
      // 必须比 bundleSha256：账本里存的就是它（正文 + 全部引用图片的合成哈希）。
      // 拿它去比纯正文哈希的话，凡是引用了图片的文档都会被永远显示成「已改」，
      // 而且与 sync 的快路径结论直接矛盾 —— sync 会说「无变化」，status 说「已改」。
      if (led.local_sha256 === file.bundleSha256) {
        unchanged++;
        report.push({
          file: mapping.source,
          relPath: file.relPath,
          state: 'unchanged',
          nodeToken: led.node_token,
        });
        continue;
      }
      modified++;
      report.push({
        file: mapping.source,
        relPath: file.relPath,
        state: 'modified',
        nodeToken: led.node_token,
      });
    }

    logger.info(
      `${color.bold(mapping.source)}  ${files.length} 篇  ` +
        `${color.green(`未变 ${unchanged}`)}  ` +
        `${color.yellow(`已改 ${modified}`)}  ` +
        `${color.blue(`未认领 ${unclaimed}`)}`,
    );

    if (options.verbose) {
      for (const r of report.filter((x) => x.file === mapping.source)) {
        if (r.state === 'unchanged') continue;
        logger.info(`   ${stateIcon(r.state)} ${r.relPath}`);
      }
    }

    if (options.remote) {
      await checkDrift(ctx, files, logger, report);
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  // 检测到漂移时返回 3（需人工处理），与 sync 的退出码契约一致。
  // 永远返回 0 的话，CI 里就没法用 status 做「知识库是否被人改过」的巡检 ——
  // 只能去解析 stdout 文本或 JSON，那是脆的。
  const hasDrift = report.some((r) => r.state === 'drift');
  return { code: hasDrift ? ExitCode.AMBIGUOUS : ExitCode.OK, report };
}

/**
 * 远端漂移检查。
 *
 * 只比对 revision 而不拉块：`revision` 一次读就能拿到，
 * 拉块在长文档上要翻好几页。漂移检测只需要知道「有没有变」，
 * 不需要知道「变了什么」——后者是真正同步时才需要的信息。
 */
async function checkDrift(
  ctx: AppContext,
  files: ReturnType<typeof scanMapping>,
  logger: Logger,
  report: StatusReport[],
): Promise<void> {
  let driftCount = 0;

  for (const file of files) {
    const led = ctx.ledger.get(file.relPath);
    if (!led) continue;
    try {
      const info = await ctx.docx.getDocument(led.obj_token);
      if (info.revision_id !== led.remote_revision_id) {
        driftCount++;
        const entry = report.find((r) => r.relPath === file.relPath && r.file);
        if (entry) {
          entry.state = 'drift';
          entry.detail = `远端 revision ${info.revision_id} ≠ 账本 ${led.remote_revision_id}`;
        }
        logger.warn(
          `   ${color.yellow('!')} ${file.relPath} 远端被人工修改过，同步时会跳过（需 --force 覆盖）`,
        );
      }
    } catch (err) {
      const entry = report.find((r) => r.relPath === file.relPath);
      if (entry) {
        entry.state = 'unknown';
        entry.detail = err instanceof Error ? err.message : String(err);
      }
      logger.warn(`   ${color.red('x')} ${file.relPath} 无法读取远端状态: ${entry?.detail ?? ''}`);
    }
  }

  if (driftCount === 0) logger.info(`   ${color.green('远端无漂移')}`);
}

function stateIcon(state: StatusReport['state']): string {
  switch (state) {
    case 'unclaimed':
      return color.blue('○');
    case 'modified':
      return color.yellow('~');
    case 'drift':
      return color.red('!');
    case 'unknown':
      return color.red('?');
    default:
      return color.dim('·');
  }
}
