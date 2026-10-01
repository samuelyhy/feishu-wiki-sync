import { ExitCode } from '../errors.js';
import { Syncer, type FileResult } from '../core/syncer.js';
import type { AppContext } from '../context.js';
import { color } from '../logger.js';

export interface SyncOptions {
  dryRun?: boolean;
  force?: boolean;
  reclaim?: boolean;
  /** 显式授权破坏性变更（清空远端、大规模删除、首次纳管非空文档） */
  allowDestructive?: boolean;
  json?: boolean;
  paths?: string[];
}

export async function runSync(ctx: AppContext, options: SyncOptions): Promise<number> {
  const { logger } = ctx;

  if (options.dryRun) {
    logger.info(color.dim('dry-run：只做本地扫描与远端比对，不写入任何内容'));
  }
  if (options.force) {
    logger.warn(color.yellow('--force：远端被人工修改过的文档也会被覆盖'));
  }
  if (options.reclaim) {
    logger.warn(color.yellow('--reclaim：忽略账本，重新按标题认领（可能产生重复文档）'));
  }

  const syncer = new Syncer({
    cwd: ctx.cwd,
    config: ctx.config,
    ledger: ctx.ledger,
    wiki: ctx.wiki,
    docx: ctx.docx,
    media: ctx.media,
    logger,
  });

  const results = await syncer.run({
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
    reclaim: options.reclaim ?? false,
    allowDestructive: options.allowDestructive ?? false,
    ...(options.paths?.length ? { paths: options.paths } : {}),
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    printSummary(results, logger.info.bind(logger));
  }

  return exitCodeFor(results);
}

/**
 * 退出码的优先级。
 *
 * 「需人工处理」（歧义、冲突、漂移）优先于「失败」：
 * 失败通常重跑即可自愈，而歧义放着不管会持续产生重复文档或覆盖错文档。
 * CI 里按优先级告警，才不会让真正需要人介入的问题被重试噪音淹没。
 */
export function exitCodeFor(results: readonly FileResult[]): number {
  if (results.some((r) => r.action === 'ambiguous')) return ExitCode.AMBIGUOUS;
  if (results.some((r) => r.action === 'failed')) return ExitCode.SYNC_FAILED;
  if (results.some((r) => r.action === 'conflict' || r.action === 'drift')) {
    return ExitCode.AMBIGUOUS;
  }
  return ExitCode.OK;
}

function printSummary(results: readonly FileResult[], info: (s: string) => void): void {
  const counts = new Map<FileResult['action'], number>();
  for (const r of results) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);

  const parts: string[] = [];
  const push = (action: FileResult['action'], label: string, tint: (s: string) => string): void => {
    const n = counts.get(action) ?? 0;
    if (n > 0) parts.push(tint(`${label} ${n}`));
  };

  push('created', '新建', color.green);
  push('updated', '更新', color.green);
  push('up-to-date', '未变', color.dim);
  push('planned', '待执行', color.blue);
  push('drift', '远端漂移', color.yellow);
  push('conflict', '冲突', color.yellow);
  push('ambiguous', '需消歧', color.yellow);
  push('failed', '失败', color.red);

  info(`\n${parts.join('  ') || '无文件需要处理'}`);

  const needsAttention = results.filter((r) =>
    ['failed', 'conflict', 'drift', 'ambiguous'].includes(r.action),
  );
  if (needsAttention.length > 0) {
    info('');
    for (const r of needsAttention) {
      info(`  ${r.relPath}: ${r.message ?? r.action}`);
    }
  }

  // dry-run 里带着警告的项（破坏性变更预告）也必须打出来 ——
  // 否则「演练」这一步就白做了：真正该被看见的正是这类风险。
  const warnings = results.filter((r) => r.action === 'planned' && r.message);
  if (warnings.length > 0) {
    info('');
    for (const r of warnings) {
      info(`  ${r.relPath}: ${r.message}`);
    }
  }
}
