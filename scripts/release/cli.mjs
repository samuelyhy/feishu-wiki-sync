#!/usr/bin/env node
/**
 * 一键发布入口：`npm run release`。
 *
 * ## 它本身几乎不做事，这是故意的
 *
 * 真正干活的是 `prepublishOnly` → preflight 和 `postpublish` → finalize。
 * 这个文件只做一件事：把命令行参数翻译成环境变量，然后调用 `npm publish`。
 *
 * 之所以绕这一圈而不是自己实现「递增 → 发布 → 打 tag」，是因为
 * **两条路必须走出同一个结果**：有人习惯 `npm run release`，有人习惯直接敲
 * `npm publish`，这两条路如果各写一套流程，早晚会分叉。让钩子做唯一的实现，
 * 入口只负责传参，就不可能分叉。
 *
 * 参数不能直接透传给 `npm publish` —— npm 不认识 `--minor` 这种自定义开关，
 * 而生命周期脚本只能通过环境变量把信息带进去。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { c, npm } from './io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const USAGE = `
一键发布：递增版本号、生成/更新 CHANGELOG、跑测试、发布、打 tag、提交、推送。

  npm run release                 递增补丁版并发布
  npm run release -- minor        递增次版本
  npm run release -- major        递增主版本
  npm run release -- --dry-run    完整演练一遍，不发布、不提交
  npm run release -- --check      只报告会做什么，什么都不改
  npm run release -- --yes        不再确认，直接发（CI 用）
  npm run release -- --no-test    跳过测试（仍然会构建）
  npm run release -- --tag next   指定 dist-tag（预发布版必需）
  npm run release -- --commit-message "..."  覆盖发布前自动提交的说明
  npm run release -- --no-auto-commit        脏工作区时不自动提交（旧行为）

工作区有未提交改动时，默认会询问后先提交再发布（--yes 时跳过询问）。
直接敲 \`npm publish\` 走的是同一套流程 —— 两个钩子都挂在 package.json 上。
`;

const BUMP_KINDS = new Set([
  'major',
  'minor',
  'patch',
  'prerelease',
  'premajor',
  'preminor',
  'prepatch',
  'none',
]);

function parseArgs(argv) {
  const env = {};
  const npmArgs = [];
  const problems = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case '--dry-run':
        npmArgs.push('--dry-run');
        env.FWS_RELEASE_DRY_RUN = '1';
        break;
      case '--yes':
      case '-y':
        env.FWS_RELEASE_YES = '1';
        break;
      case '--check':
        env.FWS_RELEASE_CHECK = '1';
        break;
      case '--no-test':
        env.FWS_RELEASE_SKIP_TESTS = '1';
        break;
      case '--no-bump':
        env.FWS_RELEASE_BUMP = 'none';
        break;
      case '--skip-changelog':
        env.FWS_RELEASE_SKIP_CHANGELOG = '1';
        break;
      case '--allow-dirty':
        env.FWS_RELEASE_ALLOW_DIRTY = '1';
        break;
      case '--no-auto-commit':
        env.FWS_RELEASE_NO_AUTO_COMMIT = '1';
        break;
      case '--commit-message': {
        const value = argv[++i];
        if (!value) problems.push('--commit-message 后面要跟提交说明');
        else env.FWS_RELEASE_COMMIT_MSG = value;
        break;
      }
      case '--tag': {
        const value = argv[++i];
        if (!value) problems.push('--tag 后面要跟一个 dist-tag 名字');
        else npmArgs.push('--tag', value);
        break;
      }
      default:
        if (BUMP_KINDS.has(arg)) env.FWS_RELEASE_BUMP = arg;
        else if (arg.startsWith('-')) problems.push(`不认识的开关：${arg}`);
        else problems.push(`不认识的参数：${arg}`);
    }
  }

  return { env, npmArgs, problems };
}

/**
 * 跑 preflight，返回退出码（它自己会把人话讲清楚）。
 *
 * 注意这里**不**替调用方退出：`--check` 跑完是必须停下的，
 * 而准备跑完是必须继续的。把「跑完了」和「失败了」混成同一个返回值，
 * 就会出现「体检跑完接着把包发了」——真的发生过一次。
 */
function runPreflight(args, env) {
  const result = spawnSync(process.execPath, [path.join(HERE, 'preflight.mjs'), ...args], {
    stdio: 'inherit',
    cwd: ROOT,
    env,
  });
  return result.status ?? 1;
}

function main() {
  const { env, npmArgs, problems } = parseArgs(process.argv.slice(2));

  if (problems.length > 0) {
    process.stderr.write(`\n✗ ${problems.join('\n✗ ')}\n${USAGE}\n`);
    process.exit(1);
  }

  const childEnv = { ...process.env, ...env };

  // --check 不发布，只是把 preflight 当体检工具跑一遍 —— 跑完就结束。
  // 这里必须**无条件退出**：体检通过不等于可以接着发布。
  if (env.FWS_RELEASE_CHECK) {
    process.exit(runPreflight(['--check'], childEnv));
  }

  // 第一步：准备。**必须是一个独立进程，而且必须在 npm 启动之前跑完。**
  //
  // npm 在启动那一刻就把 package.json 读进内存了，`prepublishOnly` 再改
  // 版本号已经太晚 —— 发出去的仍然是改动前那个（见 preflight.mjs 顶部）。
  // 所以递增、写 CHANGELOG 都在这里先做完，等 npm 起来时磁盘上已经是终稿。
  const prepared = runPreflight(['--prepare'], childEnv);
  if (prepared !== 0) process.exit(prepared);

  // 第二步：发布。npm 会依次触发 prepublishOnly（核对，不再改文件）
  // → 打包上传 → postpublish（打 tag、提交、推送）。
  const result = npm(['publish', ...npmArgs], {
    capture: false,
    env: {
      ...childEnv,
      // 同一棵树上的测试刚在准备阶段跑过，别为了发一次版跑两遍
      FWS_RELEASE_TESTS_DONE: '1',
    },
    // 不设超时：npm 可能停下来等 2FA 验证码，把它掐掉只会让人白等一场
    timeout: 30 * 60 * 1000,
  });

  if (result.ok) process.exit(0);

  // 发布失败：**不自动还原**。
  //
  // 发布有可能其实已经在服务端成功了（响应丢了、代理超时），这时把版本号
  // 改回去，反倒会让人以为同一个号还能再发一次 —— 那是 EPUBLISHCONFLICT。
  // 所以现场留着，把该怎么办写清楚。下一次 `npm run release` 会先还原。
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  process.stderr.write(
    [
      '',
      `${c.red('✗')} ${c.bold('发布没有成功')}（npm 退出码 ${result.status || 1}）`,
      '',
      `  package.json 现在是 ${c.bold(version)}，CHANGELOG 也更新过了 —— 这些改动`,
      '  既没有提交，也没有打 tag（两者都要等发布成功之后才做）。',
      '',
      '  弄清上面的报错之后：',
      `    · 重跑 ${c.bold('npm run release')} —— 它会先还原现场，再从头来一遍`,
      `    · 或者 ${c.bold('git checkout -- .')} 手工丢弃`,
      '',
      '  常见报错见 PUBLISHING.md「发布失败怎么排查」。',
      '',
    ].join('\n'),
  );
  process.exit(result.status || 1);
}

main();
