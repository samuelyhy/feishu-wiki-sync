#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { runDoctor } from '../src/commands/doctor.js';
import { runInit } from '../src/commands/init.js';
import { runPull } from '../src/commands/pull.js';
import { runStatus } from '../src/commands/status.js';
import { runSync } from '../src/commands/sync.js';
import { COMMANDS, EXIT_CODE_DOCS, GLOBAL_FLAGS, type CommandSpec } from '../src/cli-spec.js';
import { createContext } from '../src/context.js';
import { ConfigError, ExitCode, exitCodeOf, friendlyMessage } from '../src/errors.js';
import { color, createLogger } from '../src/logger.js';

/** 与 package.json 同步；发版改 version 后不必再改这里。 */
function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 源码：bin/ → 仓库根；构建后：dist/bin/ → 仓库根（也是 npm 包根）
  const candidates = [path.resolve(here, '..', 'package.json'), path.resolve(here, '..', '..', 'package.json')];
  for (const file of candidates) {
    try {
      const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
      if (typeof version === 'string' && version) return version;
    } catch {
      // 试下一个
    }
  }
  return '0.0.0';
}

const VERSION = readPackageVersion();

/**
 * `--help` 文本完全由 `src/cli-spec.ts` 生成。
 *
 * 手写的帮助文本会腐烂：加了开关忘了写进帮助，而帮助看起来仍然是对的。
 * 由 spec 生成之后，这条漂移没有发生的机会 —— 同样的数据还被
 * `tests/docs-drift.test.ts` 用来校验 `命令手册.md`。
 */
function flagLines(cmd: CommandSpec): string[] {
  const fmt = (f: { name: string; type: string; desc: string }): string => {
    const head = `  --${f.name}${f.type === 'string' ? ' <值>' : ''}`;
    return `${head.padEnd(26)}${f.desc}`;
  };
  return [...cmd.flags.map(fmt), ...GLOBAL_FLAGS.map(fmt)];
}

function buildHelp(): string {
  const sections: string[] = [];

  sections.push(`${color.bold('用法')}\n  fws <命令> [选项] [路径...]`);

  sections.push(
    `${color.bold('命令')}\n` +
      COMMANDS.map((c) => `  ${c.name.padEnd(9)}${c.summary}`).join('\n'),
  );

  for (const cmd of COMMANDS) {
    sections.push(
      `${color.bold(`${cmd.name} 选项`)}\n` +
        (flagLines(cmd).join('\n') || '  （无专属开关）'),
    );
  }

  sections.push(
    `${color.bold('示例')}\n` +
      [
        '  fws init --app-id cli_xxx --app-secret xxx --space-id 7524xxx --list-nodes',
        '  fws init --check',
        '  fws doctor --verbose',
        '  fws doctor --write',
        '  fws status --remote',
        '  fws pull --verbose',
        '  fws pull && fws sync',
        '  fws sync --dry-run',
      ].join('\n'),
  );

  sections.push(exitCodeSection());

  return header() + '\n\n' + sections.join('\n\n');
}

/**
 * 子命令自己的帮助。
 *
 * `fws sync --help` 是每个人都会敲的第一条命令。早先它会被参数解析拒绝并抛出
 * 「Unknown option '--help'」—— 而且那句话还是 Node `parseArgs` 的内部文本，
 * 读起来完全不像在帮人。
 */
function buildCommandHelp(name: string): string {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) return buildHelp();

  const usage = cmd.positionals ? `fws ${cmd.name} [选项] ${cmd.positionals}` : `fws ${cmd.name} [选项]`;

  return [
    header(),
    `${color.bold('用法')}\n  ${usage}`,
    cmd.summary,
    `${color.bold('选项')}\n${flagLines(cmd).join('\n')}`,
    exitCodeSection(),
  ].join('\n\n');
}

function header(): string {
  return `${color.bold('fws')} — 把本地 Markdown 按文件名同步到飞书知识库同名文档`;
}

function exitCodeSection(): string {
  return (
    `${color.bold('退出码')}\n` +
    EXIT_CODE_DOCS.map((e) => `  ${String(e.code).padEnd(3)}${e.meaning}`).join('\n')
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${buildHelp()}\n`);
    return ExitCode.OK;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return ExitCode.OK;
  }

  const rest = argv.slice(1);

  // `fws <命令> --help` 是每个人都会敲的第一条命令，必须在派发之前拦下来 ——
  // 否则它会落到参数解析里被当成未知开关而报错。
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`${buildCommandHelp(command)}\n`);
    return ExitCode.OK;
  }

  switch (command) {
    case 'init':
      return await cmdInit(rest);
    case 'doctor':
      return await cmdDoctor(rest);
    case 'pull':
      return await cmdPull(rest);
    case 'status':
      return await cmdStatus(rest);
    case 'sync':
      return await cmdSync(rest);
    default:
      process.stderr.write(`未知命令: ${command}\n\n${buildHelp()}\n`);
      return ExitCode.CONFIG_ERROR;
  }
}

type Values = Record<string, string | boolean | undefined>;

/**
 * 参数解析。
 *
 * 用 Node 原生 `util.parseArgs` 而不是 commander：本 CLI 只有四个子命令、
 * 十来个开关，引入一个 arg 库带来的依赖与升级负担大于它省下的代码。
 *
 * 接受的开关由 `cli-spec.ts` 决定 —— 命令行上写了 spec 里没有的开关会被
 * `strict: true` 拒绝，因此「帮助里写的」与「实际接受的」不可能不一致。
 */
function parseCommon(
  args: string[],
  commandName: string,
): { values: Values; positionals: string[] } {
  const spec = COMMANDS.find((c) => c.name === commandName);
  const options: Record<string, { type: 'string' | 'boolean' }> = {};

  for (const flag of [...GLOBAL_FLAGS, ...(spec?.flags ?? [])]) {
    options[flag.name] = { type: flag.type };
  }

  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options });
  } catch (err) {
    // `parseArgs` 的原文会附带一段讲 `--` 用法的技术说明，读起来不像在帮人。
    // 取第一句就够定位问题，剩下的用一句「去哪看」替代。
    // 同时恢复成配置错误的退出码（原先会落到 1，被 CI 误读成「同步失败，可重试」）。
    const first = (err instanceof Error ? err.message : String(err)).split('.')[0] ?? '';
    throw new ConfigError(
      `参数错误：${first}`,
      `用 \`fws ${commandName} --help\` 查看该命令支持的开关`,
    );
  }

  return {
    values: parsed.values as Values,
    positionals: parsed.positionals as string[],
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean => v === true;

async function cmdInit(args: string[]): Promise<number> {
  const { values } = parseCommon(args, 'init');

  const cwd = str(values.cwd) ?? process.cwd();
  const logger = createLogger({ verbose: bool(values.verbose), json: bool(values.json) });

  await runInit(cwd, logger, {
    ...(str(values['app-id']) ? { appId: str(values['app-id'])! } : {}),
    ...(str(values['app-secret']) ? { appSecret: str(values['app-secret'])! } : {}),
    ...(str(values['space-id']) ? { spaceId: str(values['space-id'])! } : {}),
    ...(str(values['parent-node-token'])
      ? { parentNodeToken: str(values['parent-node-token'])! }
      : {}),
    check: bool(values.check),
    listNodes: bool(values['list-nodes']),
  });

  return ExitCode.OK;
}

async function cmdDoctor(args: string[]): Promise<number> {
  const { values } = parseCommon(args, 'doctor');

  const cwd = str(values.cwd) ?? process.cwd();
  const json = bool(values.json);
  const verbose = bool(values.verbose);
  const logger = createLogger({ verbose, json });

  // doctor 是「诊断一切」的命令，所以连「装不起来」也要以体检报告的形式说清楚，
  // 而不是抛一句错误就退出 —— 用户来这里正是为了知道哪里不对。
  let ctx;
  try {
    ctx = createContext(cwd, logger);
  } catch (err) {
    return reportFatal(logger, json, err);
  }

  return await runDoctor(ctx, { write: bool(values.write), json, verbose });
}

async function cmdPull(args: string[]): Promise<number> {
  const { values, positionals } = parseCommon(args, 'pull');

  const cwd = str(values.cwd) ?? process.cwd();
  const json = bool(values.json);
  const logger = createLogger({ verbose: bool(values.verbose), json });

  const ctx = createContext(cwd, logger);

  return await runPull(ctx, {
    write: bool(values.write),
    json,
    verbose: bool(values.verbose),
    paths: positionals,
  });
}

async function cmdStatus(args: string[]): Promise<number> {
  const { values, positionals } = parseCommon(args, 'status');

  const cwd = str(values.cwd) ?? process.cwd();
  const logger = createLogger({ verbose: bool(values.verbose), json: bool(values.json) });

  // status 默认完全离线：它要能在没有网络、没有凭证的环境里回答
  // 「本地有哪些文件还没同步」——这是 CI 与本地排查最常见的起点。
  const ctx = createContext(cwd, logger, { offline: !bool(values.remote) });

  const { code } = await runStatus(ctx, {
    remote: bool(values.remote),
    json: bool(values.json),
    verbose: bool(values.verbose),
    ...(positionals.length ? { paths: positionals } : {}),
  });

  return code;
}

async function cmdSync(args: string[]): Promise<number> {
  const { values, positionals } = parseCommon(args, 'sync');

  const cwd = str(values.cwd) ?? process.cwd();
  const json = bool(values.json);
  const logger = createLogger({ verbose: bool(values.verbose), json });

  const ctx = createContext(cwd, logger);

  return await runSync(ctx, {
    dryRun: bool(values['dry-run']),
    force: bool(values.force),
    reclaim: bool(values.reclaim),
    allowDestructive: bool(values['allow-destructive']),
    json,
    ...(positionals.length ? { paths: positionals } : {}),
  });
}

/** 连上下文都建不起来时，也要以「一条失败的检查项」的形式报告。 */
function reportFatal(logger: ReturnType<typeof createLogger>, json: boolean, err: unknown): number {
  const code = exitCodeOf(err);
  const message = friendlyMessage(err);

  if (json) {
    process.stdout.write(`${JSON.stringify([{ name: '配置', status: 'fail', detail: message }], null, 2)}\n`);
  } else {
    logger.info(`${color.red('✗')} 配置  ${message}`);
    logger.info(`\n${color.red('1 项未通过')}`);
  }
  return code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const code = exitCodeOf(err);
    const label =
      code === ExitCode.QUOTA_EXHAUSTED
        ? '配额耗尽'
        : code === ExitCode.CONFIG_ERROR
          ? '配置错误'
          : '执行失败';
    process.stderr.write(`${color.red(`${label}:`)} ${friendlyMessage(err)}\n`);
    process.exitCode = code;
  });
