import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../errors.js';
import { CONFIG_DIR, configPath, writeDefaultConfig } from '../core/config.js';
import { ENV_FILE_NAME, loadEnvFile, writeEnvFile } from '../core/env.js';
import type { Logger } from '../logger.js';
import { color } from '../logger.js';
import { createContext } from '../context.js';

export interface InitOptions {
  appId?: string;
  appSecret?: string;
  spaceId?: string;
  parentNodeToken?: string;
  check: boolean;
  listNodes: boolean;
}

export async function runInit(
  cwd: string,
  logger: Logger,
  options: InitOptions,
): Promise<void> {
  // ── 1) 凭证 ──
  const existing = loadEnvFile(cwd);
  const appId = options.appId ?? existing.FEISHU_APP_ID ?? '';
  const appSecret = options.appSecret ?? existing.FEISHU_APP_SECRET ?? '';

  if (options.appId || options.appSecret) {
    const file = writeEnvFile(cwd, {
      ...(options.appId ? { FEISHU_APP_ID: options.appId } : {}),
      ...(options.appSecret ? { FEISHU_APP_SECRET: options.appSecret } : {}),
    });
    logger.info(`${color.green('✓')} 已写入凭证 ${path.relative(cwd, file)}`);
  }

  ensureGitignore(cwd, logger);

  // ── 2) 配置骨架 ──
  const spaceId = options.spaceId ?? '';
  if (!fs.existsSync(configPath(cwd))) {
    if (!spaceId) {
      logger.warn(
        `${color.yellow('!')} 未提供 --space-id，已生成占位符配置；请填写后重新运行 init --check`,
      );
    }
    const file = writeDefaultConfig(cwd, spaceId);
    logger.info(`${color.green('✓')} 已生成配置骨架 ${path.relative(cwd, file)}`);
    // 只在**没有别的事要做**时才提前返回。
    // 早先这里写的是 `!spaceId || !parentNodeToken` 就 return，
    // 于是 README 与 --help 里示范的 `init --app-id ... --space-id ... --list-nodes`
    // 会先建好骨架、然后**默默跳过** --list-nodes —— 命令承诺的事一件没做。
    if (!options.check && !options.listNodes) {
      logger.info(
        `  下一步：填写 space_id 与 mappings[].parent_node_token，` +
          `可用 ${color.bold('fws init --list-nodes')} 列出可选节点`,
      );
      return;
    }
  }

  if (options.parentNodeToken) {
    applyParentNodeToken(cwd, options.parentNodeToken, logger);
  }

  if (!options.check && !options.listNodes) return;

  // ── 3) 联网验活 ──
  if (!appId || !appSecret) {
    throw new ConfigError(
      '验活需要飞书应用凭证',
      '执行 `fws init --app-id <id> --app-secret <secret> --check`',
    );
  }

  const ctx = createContext(cwd, logger);
  await checkSpace(ctx, logger);
  if (options.listNodes) await listTopNodes(ctx, logger);
  await checkMappings(ctx, logger);
}

/** 补 .gitignore。凭证文件入库是最不该发生的泄漏。 */
function ensureGitignore(cwd: string, logger: Logger): void {
  const file = path.join(cwd, '.gitignore');
  const entry = ENV_FILE_NAME;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = existing.split(/\r?\n/).map((l) => l.trim());

  if (lines.includes(entry)) return;

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(
    file,
    `${existing}${prefix}\n# 飞书凭证，绝不入库\n${entry}\n${CONFIG_DIR}/ledger.json\n`,
    'utf8',
  );
  logger.info(`${color.green('✓')} 已把 ${entry} 加入 .gitignore`);
}

function applyParentNodeToken(cwd: string, token: string, logger: Logger): void {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes(token)) return;

  const replaced = content.replace(
    /parent_node_token:\s*.*$/m,
    `parent_node_token: "${token}"`,
  );
  if (replaced !== content) {
    fs.writeFileSync(file, replaced, 'utf8');
    logger.info(`${color.green('✓')} 已写入 parent_node_token: ${token}`);
  }
}

async function checkSpace(ctx: ReturnType<typeof createContext>, logger: Logger): Promise<void> {
  const info = await ctx.wiki.listChildren(ctx.config.spaceId).catch((err: unknown) => {
    throw new ConfigError(
      `无法访问知识空间 ${ctx.config.spaceId}: ${err instanceof Error ? err.message : String(err)}`,
      '确认 space_id 正确，且应用已被加为该知识空间的成员/管理员',
    );
  });
  logger.info(
    `${color.green('✓')} 知识空间可访问（顶级节点 ${info.length} 个）`,
  );
}

async function listTopNodes(ctx: ReturnType<typeof createContext>, logger: Logger): Promise<void> {
  const nodes = await ctx.wiki.listChildren(ctx.config.spaceId);
  logger.info(`\n顶级节点（可作为 parent_node_token）：`);
  for (const n of nodes) {
    logger.info(`  ${n.node_token}  ${n.title}`);
  }
  logger.info('');
}

/**
 * 校验每个 mapping 的父节点是否存在、是否可达。
 *
 * 这一步单独做而不是塞进 loadConfig，是因为它需要联网；
 * 塞进去会让 `--dry-run` 这类本该离线的命令也强制联网。
 */
async function checkMappings(ctx: ReturnType<typeof createContext>, logger: Logger): Promise<void> {
  let failed = false;

  for (const m of ctx.config.mappings) {
    try {
      const node = await ctx.wiki.getNode(m.parentNodeToken);
      if (!node) {
        logger.error(`${color.red('x')} ${m.source}: parent_node_token ${m.parentNodeToken} 不存在`);
        failed = true;
        continue;
      }
      const children = await ctx.wiki.listChildren(ctx.config.spaceId, m.parentNodeToken);
      logger.info(
        `${color.green('✓')} ${m.source} → 「${node.title}」（现有子节点 ${children.length} 个）`,
      );
    } catch (err) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`${color.red('x')} ${m.source}: ${msg}`);
      if (/131006|permission/i.test(msg)) {
        logger.error(
          `  ${color.yellow('权限提示')}：仅申请 wiki:wiki scope 是不够的。` +
            `需创建一个群 → 把应用作为机器人加入该群 → 在知识库「成员设置」里把该群加为管理员。`,
        );
      }
    }
  }

  if (failed) {
    throw new ConfigError('部分 mapping 校验未通过', '修正后重新运行 `fws init --check`');
  }
  logger.info(`\n${color.green('全部校验通过')}`);
}

