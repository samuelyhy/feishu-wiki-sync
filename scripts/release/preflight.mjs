#!/usr/bin/env node
/**
 * 发布前的检查与准备。两种模式，差别只有一件事：**能不能改文件**。
 *
 *   node preflight.mjs --prepare   # 准备：定版本号、写 CHANGELOG、跑测试，然后才发布
 *   node preflight.mjs             # 核对（挂在 prepublishOnly 上）：只检查，不改版本号
 *
 * ## 为什么递增版本号必须发生在 npm publish **之外**
 *
 * 这是实测出来的，也是整个脚本的形态由来的原因：
 *
 *     $ npm publish --dry-run        # prepublishOnly 把 package.json 改成 2.0.0
 *     npm notice package: when-read@1.0.0     ← 发出去的仍然是 1.0.0
 *     $ cat package.json             # 磁盘上却是 2.0.0
 *
 * npm 在**启动那一刻**就把 package.json 读进内存了，`prepublishOnly` 跑得比
 * 打包晚。所以「在 prepublishOnly 里递增版本号」会得到一个最坏的结果：
 * 发出去的是旧版本，postpublish 却按新版本去打 tag —— 仓库里从此挂着一个
 * 指向不存在版本的 tag。
 *
 * 于是分工变成：递增由 `npm run release` 在**另一个进程**里先做完，
 * 等 npm 真的启动时，package.json 上已经是最终版本号了。
 *
 * ## 那 prepublishOnly 还留着干什么
 *
 * 因为 `npm publish` 是会被直接敲出来的。那条路上不能递增（已经晚了），
 * 但可以**拦住**：版本号已经发布过就明确拒绝，并告诉人该先跑什么。
 * 再加上门禁、测试、以及给 postpublish 留一份状态 —— 直接敲 `npm publish`
 * 依然是一条完整、安全的路，只是它不会替你决定版本号。
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PRE_RELEASE_COMMIT_MSG,
  findSection,
  findSensitivePaths,
  insertSection,
  isPrerelease,
  isValidVersion,
  maxVersion,
  parseCommits,
  prereleaseTag,
  renameSection,
  renderReleaseNotes,
  resolveTargetVersion,
  setPackageVersion,
  stampDate,
  todayISO,
} from './lib.mjs';
import {
  c,
  clearState,
  commitAll,
  confirm,
  die,
  exists,
  formatBytes,
  gitLog,
  gitState,
  log,
  npm,
  npmVersion,
  packSummary,
  queryRegistry,
  readState,
  readText,
  restoreFiles,
  saveState,
  tagExists,
  whoami,
  writeText,
} from './io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TOTAL_STEPS = 8;

const PKG_FILE = path.join(ROOT, 'package.json');
const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');

function readOptions() {
  const argv = process.argv.slice(2);
  const env = process.env;
  return {
    // --prepare 是唯一允许改文件的模式；默认（钩子模式）只核对
    prepare: argv.includes('--prepare'),
    checkOnly: argv.includes('--check'),
    bump: env.FWS_RELEASE_BUMP || 'patch',
    yes: env.FWS_RELEASE_YES === '1',
    skipTests: env.FWS_RELEASE_SKIP_TESTS === '1',
    // 由 `npm run release` 在同一次调用里传下来：测试刚在准备阶段跑过。
    // 只有它能这么传 —— 换了别人，就没法保证「跑过测试的正是这棵树」。
    testsDone: env.FWS_RELEASE_TESTS_DONE === '1',
    skipChangelog: env.FWS_RELEASE_SKIP_CHANGELOG === '1',
    allowDirty: env.FWS_RELEASE_ALLOW_DIRTY === '1',
    // 默认开启：脏工作区时询问后自动提交。显式关掉才恢复「脏则失败」。
    autoCommit: env.FWS_RELEASE_NO_AUTO_COMMIT !== '1',
    commitMessage: env.FWS_RELEASE_COMMIT_MSG || DEFAULT_PRE_RELEASE_COMMIT_MSG,
    offline: env.FWS_RELEASE_OFFLINE === '1',
    dryRun: env.FWS_RELEASE_DRY_RUN === '1' || env.npm_config_dry_run === 'true',
    tag: env.FWS_RELEASE_TAG || env.npm_config_tag || null,
    isCI: Boolean(env.CI) && env.CI !== 'false',
    noGit: env.FWS_RELEASE_NO_GIT === '1',
  };
}

function preview(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), c.dim(`… 还有 ${lines.length - maxLines} 行`)];
}

function rule(label) {
  process.stdout.write(`\n${c.dim(`── ${label} ${'─'.repeat(Math.max(4, 58 - label.length))}`)}\n`);
}

let stepIndex = 0;
const step = (title) => log.step(++stepIndex, TOTAL_STEPS, title);

async function main() {
  const opts = readOptions();
  const pkgRaw = readText(PKG_FILE);
  const pkg = JSON.parse(pkgRaw);
  const name = pkg.name;
  const registry = pkg.publishConfig?.registry;

  // 上一次准备如果没走完（发布失败、或者被 Ctrl-C），它改过的文件还留在
  // 工作区里。先还原 —— 否则这次的「工作区必须是干净的」检查会报一堆
  // 其实是我们自己造成的改动。只有准备模式才需要管这件事。
  let priorState = readState(ROOT);

  if (opts.prepare && priorState?.files && Object.keys(priorState.files).length > 0) {
    const { restored, kept } = restoreFiles(priorState.files);
    clearState(ROOT);
    priorState = null;
    rule('上一次准备没有走完');
    log.warn(`已还原：${restored.map((f) => path.relative(ROOT, f)).join('、') || '（无）'}`);
    if (kept.length > 0) {
      log.warn(`保留了中途手工改过的：${kept.map((f) => path.relative(ROOT, f)).join('、')}`);
    }
  }

  // 准备阶段改过的文件（package.json / CHANGELOG.md）此刻正躺在工作区里，
  // 那是**流程本身**造成的，不是「工作区不干净」。核对模式如果不把它们
  // 排除掉，每一次 `npm run release` 都会被自己上一次的改动拦下来。
  const planned = new Set(
    Object.keys(priorState?.files ?? {}).map((f) => path.relative(ROOT, f).replaceAll('\\', '/')),
  );

  const originals = new Map();
  const written = new Map();

  /** 把准备阶段改过的文件按原样放回去；返回是否动过。 */
  const rollback = () => {
    const payload = Object.fromEntries(
      [...originals].map(([file, original]) => [file, { original, written: written.get(file) }]),
    );
    const { restored, kept } = restoreFiles(payload);
    clearState(ROOT);
    return { restored, kept };
  };

  const abort = (headline, details) => {
    const { restored, kept } = rollback();
    if (restored.length > 0) log.warn(`已还原 ${restored.map((f) => path.relative(ROOT, f)).join('、')}`);
    if (kept.length > 0) log.warn(`保留了手工改动过的 ${kept.map((f) => path.relative(ROOT, f)).join('、')}`);
    die(headline, details);
  };

  // ── 1/8 环境 ───────────────────────────────────────────────
  step(opts.prepare ? '环境' : '环境（核对模式：不改版本号）');
  let git = gitState();

  if (!git.inRepo && !opts.noGit) {
    die('当前目录不是一个 git 仓库', [
      '发布脚本要在发布成功后打 tag、提交版本号，没有 git 就做不到。',
      '确实不需要 git，设 FWS_RELEASE_NO_GIT=1 再来一次。',
    ]);
  }

  let unexpected = git.dirty.filter((f) => !planned.has(f.replaceAll('\\', '/')));

  if (git.inRepo && unexpected.length > 0 && !opts.allowDirty && !opts.isCI) {
    const shown = unexpected.slice(0, 8);
    const changeLines = [
      `有 ${unexpected.length} 处改动：`,
      ...shown.map((f) => `  · ${f}`),
      ...(unexpected.length > shown.length ? [`  · … 还有 ${unexpected.length - shown.length} 处`] : []),
    ];

    const sensitive = findSensitivePaths(unexpected);
    if (sensitive.length > 0) {
      die('工作区里有疑似密钥/凭证文件，拒绝自动提交', [
        '一键发布会 `git add -A`，把这些文件写进历史比拦在门外贵得多。',
        '',
        '命中：',
        ...sensitive.slice(0, 12).map((f) => `  · ${f}`),
        ...(sensitive.length > 12 ? [`  · … 还有 ${sensitive.length - 12} 处`] : []),
        '',
        '请移出工作区、加入 .gitignore，或确认无误后手工提交；',
        '确实要带着脏工作区硬发，设 FWS_RELEASE_ALLOW_DIRTY=1（风险自负）。',
      ]);
    }

    if (opts.checkOnly || opts.dryRun) {
      // 演练/体检不能留下真实 commit，否则「演练」就改写了历史。
      // 报告之后按「将会干净」继续，否则永远卡在脏检查。
      log.warn(
        `工作区有 ${unexpected.length} 处未提交改动；正式发布时会先自动提交` +
          `（消息：${opts.commitMessage}）`,
      );
      for (const line of changeLines.slice(0, 6)) log.note(`${c.dim('│')} ${line}`);
    } else if (!opts.autoCommit) {
      die('工作区不干净，先提交', [
        '这不是洁癖，是发布正确性问题：',
        '  tarball 是从**工作区**打的，而 tag 指向**提交**。',
        '  工作区里有未提交的改动时，两者不是同一份代码 ——',
        '  于是 npm 上那个版本的源码，在仓库里根本找不到。',
        '',
        ...changeLines,
        '',
        '先 `git add -A && git commit -m "..."`，确认无误后再发布。',
        '（默认会询问后自动提交；你用了 --no-auto-commit 才走到这里。）',
        '（确实要带着未提交改动发布，设 FWS_RELEASE_ALLOW_DIRTY=1，风险自负）',
      ]);
    } else {
      log.warn(`工作区有 ${unexpected.length} 处未提交改动 —— 发布前需要先提交`);
      for (const line of changeLines) log.note(`${c.dim('│')} ${line}`);
      log.note(`${c.dim('│')} 提交说明：${opts.commitMessage}`);

      const agreed = await confirm(`提交以上 ${unexpected.length} 处改动并继续发布？`, {
        yes: opts.yes,
      });
      if (!agreed) {
        die('已取消：工作区仍有未提交改动', [
          '改完后再跑，或用 --no-auto-commit 自己提交，或 FWS_RELEASE_ALLOW_DIRTY=1 硬发。',
        ]);
      }

      const committed = commitAll(opts.commitMessage);
      if (!committed.ok) {
        die('自动提交失败', [
          committed.stderr.trim() || committed.stdout.trim() || '（git 无输出）',
          '',
          '请手工 `git add -A && git commit` 修好后再发布。',
        ]);
      }

      git = gitState();
      unexpected = git.dirty.filter((f) => !planned.has(f.replaceAll('\\', '/')));
      if (unexpected.length > 0) {
        die('自动提交后工作区仍不干净', [
          '可能有被 hook 改回的文件，或 commit 被跳过。',
          ...unexpected.slice(0, 8).map((f) => `  · ${f}`),
        ]);
      }
      log.ok(`已自动提交（${opts.commitMessage}）`);
    }
  }

  if (git.inRepo && !git.hasCommits && !opts.isCI) {
    die('仓库还没有任何提交', [
      '发布成功后会打一个 tag 并提交版本号，二者都需要一个已有的历史作为落点。',
      '先做一次初始提交。',
    ]);
  }

  if (git.inRepo && git.branch && !['main', 'master'].includes(git.branch)) {
    log.warn(`当前分支是 ${c.bold(git.branch)}，不是 main —— tag 会指向这个分支的提交`);
  }
  if (git.inRepo && git.behind > 0) {
    log.warn(`本地落后远端 ${git.behind} 个提交 —— 你要发的是这些提交**之前**的代码，确认这是有意的`);
  }
  if (git.inRepo && git.remotes.length === 0) {
    log.warn('没有配置 git remote：发布后 tag 和提交只会留在本地，不会推上去');
  }
  if (git.inRepo) {
    log.ok(
      `git：${git.branch ?? '（游离 HEAD）'} · ${git.clean ? '工作区干净' : '工作区有改动'} · ` +
        `${git.lastTag ? `最近 tag ${git.lastTag}` : '没有任何 tag'}`,
    );
  } else {
    log.warn('跳过 git 检查（FWS_RELEASE_NO_GIT=1）');
  }

  const auth = whoami();
  const tokenInEnv = Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN);

  if (auth.status === 'unauthenticated') {
    die('npm 身份未通过（`npm whoami` 被拒绝）', [
      auth.detail ? `npm 返回：${auth.detail}` : '',
      '发布必须通过 npm 认证，且 token 必须是 **Granular Access Token** 并勾选了',
      '`Allow this token to bypass 2FA` —— Classic token 在开了 2FA 的账号上',
      '会被 npm 以一句看起来像权限问题的 403 拒绝。',
      '',
      '最快的一条路：npm login --auth-type=web',
      '细节见 PUBLISHING.md「前置：npm token 必须是 Granular 且允许绕过 2FA」。',
    ].filter(Boolean));
  }

  if (auth.status === 'unknown' && !tokenInEnv) {
    // 问不出来 ≠ 没认证。拿它挡住发布是误伤，所以只提醒。
    log.warn(`查不到 npm 身份（${auth.detail ?? '未知原因'}）—— 认证是否有效，要到推包时才知道`);
  }

  log.ok(
    `npm：${c.bold(auth.user ?? (tokenInEnv ? '（凭证来自环境变量）' : '未确认'))} · ` +
      `node ${process.version} · npm ${npmVersion()}`,
  );

  // ── 2/8 远端版本 ───────────────────────────────────────────
  step('远端版本');
  let published = [];
  let distTags = {};

  if (opts.offline) {
    log.warn('离线模式：查不到远端版本，「本地版本没发布过」这个判断这次不成立');
  } else {
    const remote = queryRegistry(name, { registry });
    if (!remote.reachable) {
      die(`查不到 ${name} 在 registry 上的版本`, [
        `npm 返回：${remote.error ?? '（无输出）'}`,
        '',
        '这一步不能跳过：查不到远端，就无法判断版本号是不是已经被占用，',
        '而「发一个已存在的版本号」一定会以 EPUBLISHCONFLICT 收场。',
        '',
        '网络恢复后重试；确认要离线发布，设 FWS_RELEASE_OFFLINE=1。',
      ]);
    }
    published = remote.published;
    distTags = remote.distTags;
    if (remote.exists) {
      log.ok(`远端已有 ${published.length} 个版本，latest = ${c.bold(maxVersion(published))}`);
      const tags = Object.entries(distTags);
      if (tags.length > 0) log.info(`dist-tags：${tags.map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    } else {
      log.ok(`远端还没有 ${name} 这个包 —— 这是首次发布`);
    }
  }

  // ── 3/8 目标版本 ───────────────────────────────────────────
  step('目标版本');
  let resolved;
  try {
    resolved = resolveTargetVersion({ localVersion: pkg.version, published, bump: opts.bump });
  } catch (error) {
    die('定不下要发布的版本号', [error.message]);
  }

  // 钩子模式：npm 早就把 package.json 读进内存了，此刻改版本号已经晚了 ——
  // 发出去的仍会是磁盘上那个号。所以只能停下来说清楚先做什么。
  if (resolved.bumped && !opts.prepare && !opts.checkOnly) {
    die(`版本号 ${pkg.version} 已经发布过，直接发布会被 npm 拒绝`, [
      '（EPUBLISHCONFLICT —— npm 不允许覆盖已发布的版本号）',
      '',
      '要递增版本号，得在 npm 启动**之前**做完：',
      '',
      `  npm run release${opts.bump !== 'patch' ? ` -- ${opts.bump}` : ''}`,
      '',
      '它会先递增版本号、写好 CHANGELOG，再调用 npm 发布。',
      '',
      '之所以不能在这里顺手改掉：npm 启动时就把 package.json 读进内存了，',
      '在 prepublishOnly 里改版本号，发出去的仍然是改动前的那个 ——',
      '实测如此，而且更糟的是 postpublish 会按新版本号打一个指向不存在版本的 tag。',
    ]);
  }

  const target = resolved.target;
  if (!isValidVersion(target)) {
    die(`算出的版本号不合法：${JSON.stringify(target)}`, ['请检查 package.json 的 version 字段。']);
  }

  if (resolved.bumped) {
    log.ok(`${c.bold(pkg.version)} → ${c.bold(target)}：${resolved.reason}`);
  } else {
    log.ok(`${c.bold(target)}：${resolved.reason}`);
  }

  const distTag = opts.tag || (isPrerelease(target) ? prereleaseTag(target) : 'latest');
  log.info(`dist-tag：${c.bold(distTag)}${distTags.latest ? `（远端当前 ${distTags.latest}）` : ''}`);

  if (isPrerelease(target) && !opts.tag && opts.prepare) {
    log.warn(`预发布版会自动用 --tag ${distTag} —— 不带 tag 发布会让它顶掉 latest`);
  }

  // 远端没有这个版本、本地却已经有 tag —— 说明上一次发到一半断了。
  if (git.inRepo && !opts.dryRun && tagExists(`v${target}`)) {
    log.warn(`本地已有 tag v${target}，但远端没有这个版本 —— 那是上一次失败发布留下的`);
  }

  // ── 4/8 变更日志 ───────────────────────────────────────────
  step('变更日志');

  let changelogText = exists(CHANGELOG_FILE) ? readText(CHANGELOG_FILE) : null;
  let notes = null;
  let changelogSource = '';
  const stamp = todayISO();

  // 「打算怎么写 CHANGELOG」这件事只算不写，所以 --check 也一并做 ——
  // 不然体检报告里最该看的那段（这次会生成什么发布说明）恰好是空的。
  const planning = opts.prepare || opts.checkOnly;

  if (!changelogText) {
    if (opts.skipChangelog || !planning) {
      log.skip('没有 CHANGELOG.md');
    } else {
      die('仓库里没有 CHANGELOG.md', [
        '发布说明是这个版本「含什么」的唯一判据，也决定 npm 页面上那个版本的样子。',
        '先建一个 CHANGELOG.md；确实不要，设 FWS_RELEASE_SKIP_CHANGELOG=1。',
      ]);
    }
  } else if (opts.skipChangelog) {
    log.warn('跳过（--skip-changelog）：tag 上会没有发布说明');
  } else {
    const existing = findSection(changelogText, target);
    const unreleased = findSection(changelogText, 'Unreleased');

    if (existing) {
      notes = existing.body;
      changelogSource = 'CHANGELOG.md 里已有的段落';
      const stamped = stampDate(changelogText, target, stamp);
      if (stamped.changed) {
        changelogText = stamped.md;
        log.info(`补上日期：## [${target}] — ${stamp}`);
      }
    } else if (unreleased?.body) {
      changelogText = renameSection(changelogText, 'Unreleased', target, stamp).md;
      notes = unreleased.body;
      changelogSource = '由 `## [Unreleased]` 改名而来';
      log.info(`把 \`## [Unreleased]\` 定为 ${target}（${stamp}）`);
    } else if (!planning) {
      log.warn(`CHANGELOG.md 里没有 [${target}] 段落 —— tag 上会没有发布说明`);
    } else {
      const range = git.inRepo && git.lastTag ? `${git.lastTag}..HEAD` : '';
      const generated = renderReleaseNotes(parseCommits(git.inRepo ? gitLog(range) : ''), {
        range: range || '全部提交',
      });

      if (!generated) {
        die(`CHANGELOG.md 里没有 [${target}] 段落，也生成不出新的`, [
          '生成不出内容通常是因为：仓库还没有提交，或者自上一个 tag 以来只有发版自身的提交。',
          '',
          '请在 CHANGELOG.md 顶部手工写下这个版本的段落：',
          `  ## [${target}] — ${stamp}`,
          '',
          '  一句话说清这个版本干了什么，下面用 ### 新增 / ### 修复 / ### 变更 分节。',
        ]);
      }

      changelogText = insertSection(changelogText, { version: target, date: stamp, body: generated });
      notes = generated;
      changelogSource = `由 git 提交自动生成（${range || '全部提交'}）`;
      log.warn('CHANGELOG 里没有这个版本，已按提交记录生成草稿 —— 提交标题里没有「为什么」');
    }
  }

  if (notes) {
    log.ok(`发布说明：${changelogSource || '沿用 CHANGELOG'}，${notes.split('\n').length} 行`);
    for (const line of preview(notes, 6)) log.note(`${c.dim('│')} ${line}`);
  } else if (!opts.prepare) {
    log.skip('没有发布说明（不影响发布，只是 tag 上没有正文）');
  }

  // ── 5/8 落盘 ───────────────────────────────────────────────
  step(opts.prepare ? '写入版本号与 CHANGELOG' : '记录发布状态');

  if (opts.checkOnly) {
    log.skip('--check：只报告，不改任何文件');
  } else if (opts.prepare) {
    const newPkgRaw = setPackageVersion(pkgRaw, target);
    originals.set(PKG_FILE, pkgRaw);
    written.set(PKG_FILE, newPkgRaw);
    writeText(PKG_FILE, newPkgRaw);
    log.ok(`package.json  version: ${pkg.version} → ${target}`);

    const before = exists(CHANGELOG_FILE) ? readText(CHANGELOG_FILE) : '';
    if (changelogText !== null && changelogText !== before) {
      originals.set(CHANGELOG_FILE, before);
      written.set(CHANGELOG_FILE, changelogText);
      writeText(CHANGELOG_FILE, changelogText);
      log.ok('CHANGELOG.md  已更新');
    } else {
      log.skip('CHANGELOG.md 无需改动');
    }
  } else {
    log.skip('核对模式：不动 package.json 与 CHANGELOG（版本号必须由准备阶段定好）');
  }

  // 核对模式**必须沿用**准备阶段记下的文件清单，不能覆盖成空的。
  //
  // 这两个钩子跑在同一个版本上：准备阶段写下 package.json 和那份清单，
  // 随后 npm 启动 → prepublishOnly（核对）→ postpublish（收尾）。核对这一步
  // 如果没有把清单带过去，收尾时就不知道准备阶段改过什么 ——
  // 提交时漏掉 CHANGELOG，演练时更是还原不回原样。
  //
  // 只有版本号对得上才沿用：对不上说明 package.json 被人在中间改过，
  // 那份旧清单已经不能代表当前这棵树了。
  const carriedFiles =
    !opts.prepare && priorState?.version === target ? (priorState.files ?? {}) : {};

  // postpublish 要靠这份状态才知道该提交什么、打什么 tag。
  //
  // `--check` 一个字都不写 —— 包括这份状态。写它会覆盖掉上一次准备留下的文件
  // 清单，那样一次中断的发布就再也还原不回去了。
  const state = {
    phase: opts.prepare || Object.keys(carriedFiles).length > 0 ? 'prepared' : 'verified',
    name,
    version: target,
    localVersion: pkg.version,
    distTag,
    dryRun: opts.dryRun,
    isCI: opts.isCI,
    noGit: opts.noGit || !git.inRepo,
    notes,
    branch: git.branch,
    remotes: git.remotes,
    startedAt: new Date().toISOString(),
    files:
      Object.keys(carriedFiles).length > 0
        ? carriedFiles
        : Object.fromEntries(
            [...originals].map(([file, original]) => [file, { original, written: written.get(file) }]),
          ),
  };

  if (!opts.checkOnly) saveState(ROOT, state);

  // ── 6/8 元数据门禁 ─────────────────────────────────────────
  step('元数据门禁');
  const gate = npm(['run', 'check:ready'], { capture: false });
  if (!gate.ok) {
    if (opts.checkOnly || !opts.prepare) {
      die('元数据还不齐备（见上面的报错）', ['按报错逐条修完再来。']);
    }
    abort('元数据还不齐备，已中止发布', ['按报错逐条修完，再重新执行。']);
  }

  // ── 7/8 构建与测试 ─────────────────────────────────────────
  step('构建与测试');
  if (opts.checkOnly) {
    log.skip('--check：不跑构建与测试');
  } else if (opts.testsDone) {
    // 只有 `npm run release` 会传这个标记：它自己的准备阶段刚在这棵树上跑过
    log.skip('测试已在准备阶段通过（同一棵树，未再重复跑）');
  } else if (opts.skipTests) {
    // 即使不跑测试也必须构建：`npm publish` 实测不跑 prepack/prepare，
    // 没人构建的话 tarball 里就是上一次的 dist（或者干脆没有）
    const build = npm(['run', 'build'], { capture: false, timeout: 300_000 });
    if (build.ok) log.warn('跳过测试（--no-test），只做了构建');
    else if (opts.prepare) abort('构建失败，已中止发布', []);
    else die('构建失败', []);
  } else {
    const test = npm(['test'], { capture: false, timeout: 900_000 });
    if (test.ok) {
      log.ok('测试通过（构建已随之完成）');
    } else if (opts.prepare) {
      abort('测试没过，已中止发布', [
        '把一个测试没过的版本发出去，是在拿别人的时间做实验 ——',
        '而且 npm 不允许覆盖已发布的版本号，修好之后只能换个号再发。',
      ]);
    } else {
      die('测试没过', ['不发。']);
    }
  }

  // ── 8/8 摘要 ───────────────────────────────────────────────
  step('即将发布');
  const wantPack = opts.checkOnly || (process.stdout.isTTY && !opts.yes);
  const pack = wantPack ? packSummary() : null;

  const lines = [
    `${c.bold(`${name}@${target}`)}  →  ${registry ?? 'https://registry.npmjs.org/'}`,
    `版本      ${pkg.version}${resolved.bumped ? '（将被递增）' : ''} → ${target}`,
    `dist-tag  ${distTag}`,
    `远端最新  ${maxVersion(published) ?? '（无）'}`,
    `改动文件  ${[...originals.keys()].map((f) => path.basename(f)).join('、') || (opts.prepare ? '（无）' : '（核对模式不改文件）')}`,
    `测试      ${opts.checkOnly ? '未跑（--check）' : opts.testsDone ? '准备阶段已通过' : opts.skipTests ? '跳过' : '通过'}`,
    pack
      ? `包内容    ${pack.entryCount} 个文件 · 压缩后 ${formatBytes(pack.size)} · 解压 ${formatBytes(pack.unpackedSize)}`
      : `包内容    ${c.dim('（未探查）')}`,
    `发布后    ${
      opts.dryRun
        ? c.yellow('演练，不打 tag、不提交')
        : opts.isCI || opts.noGit
          ? c.yellow('不发 tag、不提交（CI / FWS_RELEASE_NO_GIT）')
          : `打 tag ${c.bold(`v${target}`)}、提交、推送`
    }`,
  ];

  rule('摘要');
  for (const line of lines) log.info(line);

  if (pack) {
    // 包内容对不对，只有在这里看一眼才知道 —— 发出去就改不了了
    const odd = pack.files.filter((f) => /\.(map|ts)$/.test(f) || f.startsWith('dist/tests/'));
    if (odd.length > 0) {
      log.warn(
        `包里有 ${odd.length} 个不该发的东西（sourcemap / .ts / 测试）：` +
          `${odd.slice(0, 3).join('、')}${odd.length > 3 ? ' …' : ''}`,
      );
    }
  }

  if (opts.checkOnly) {
    rule('检查完成（--check）');
    log.ok('以上是要发生的事，本次没有改动任何文件，也没有发布');
    clearState(ROOT);
    return;
  }

  // 核对模式不提问：`npm publish` 是人自己敲的，敲下去就是确认。
  // 准备模式要问 —— 它离真正发布只差一步，而且是不可逆的那一步。
  if (opts.prepare) {
    if (!opts.dryRun) {
      log.note('');
      log.note(c.yellow('发布不可逆：72 小时后不能再撤回，版本号永久占用。'));
    }
    const agreed = await confirm(
      opts.dryRun ? `演练一次 ${name}@${target} 的发布？` : `确认发布 ${c.bold(`${name}@${target}`)}？`,
      { yes: opts.yes },
    );
    if (!agreed) {
      const { restored } = rollback();
      process.stderr.write('\n');
      log.warn(`已取消${restored.length ? `，已还原 ${restored.map((f) => path.basename(f)).join('、')}` : ''}`);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  die('发布准备阶段异常中断', [error?.stack ?? String(error)]);
});
