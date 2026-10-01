#!/usr/bin/env node
/**
 * 发布**成功之后**的收尾，挂在 `postpublish` 上：确认真的发出去了，然后
 * 打 tag、提交版本号、推上去。
 *
 * ## 为什么要有这一半
 *
 * `npm publish` 一旦返回，「已发布」就是既成事实 —— 撤不回来。此刻如果
 * 仓库里没有对应的 tag 和提交，日后就没人能回答「npm 上那个 1.2.0 到底是
 * 哪份代码」。tag 是版本号与代码之间唯一的锚点，必须紧跟发布补上。
 *
 * ## 三条不能违反的规矩
 *
 * 1. **`postpublish` 会被 `npm publish --dry-run` 触发**（实测 npm 9.8.1）。
 *    演练绝不能留下 tag 和提交，所以第一件事就是看 dry-run 标记。
 * 2. **打 tag 之前先向 registry 确认这个版本真的在。** 一个指向不存在版本的
 *    tag 比没有 tag 更糟：它看起来很权威，而且是错的。
 * 3. **这里失败不等于发布失败。** 包已经在 npm 上了，所以报错必须说清
 *    「哪一步没做完、怎么手工补」，而不是让人以为要重发一遍。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { log, c, clearState, die, git, queryRegistry, readState, restoreFiles, tagExists } from './io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PKG_FILE = path.join(ROOT, 'package.json');

/** 从 tag 说明里取一段当提交正文：第一段非空、非引用的话。 */
function commitBody(notes) {
  if (!notes) return '';
  const para = notes
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('-'));
  if (!para) return '';
  return para.length > 300 ? `${para.slice(0, 297)}…` : para;
}

function manualSteps({ version, tag, branch, remote }) {
  const lines = [
    `git add package.json CHANGELOG.md`,
    `git commit -m "chore(release): ${tag}"`,
    `git tag -a ${tag} -m "${version}"`,
  ];
  if (remote) {
    if (branch) lines.push(`git push ${remote} ${branch}`);
    lines.push(`git push ${remote} ${tag}`);
  }
  return lines;
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  const name = pkg.name;
  const registry = pkg.publishConfig?.registry ?? 'https://registry.npmjs.org/';
  // 确认用的是这个包真正发布到的 registry（publishConfig 可以指向别处）
  const state = readState(ROOT);

  // preflight 没跑过（例如有人直接 `npm publish --ignore-scripts` 之后手动改了钩子），
  // 这里无事可做，但不该把一次成功的发布变成失败。
  if (!state) {
    log.skip('没有找到发布状态记录：跳过打 tag 与提交（本次发布仍然成功）');
    return;
  }

  const { version, previousVersion, distTag, notes, dryRun, isCI, noGit, branch, remotes = [] } = state;
  const tag = `v${version}`;

  // ── 演练：还原现场，什么都不留 ──────────────────────────────
  if (dryRun) {
    const { restored, kept } = restoreFiles(state.files ?? {});
    clearState(ROOT);

    process.stdout.write('\n');
    log.ok(`演练完成：${c.bold(`${name}@${version}`)} 走完了全部流程，但没有真的发布`);
    if (restored.length > 0) log.info(`已还原 ${restored.map((f) => path.relative(ROOT, f)).join('、')}`);
    if (kept.length > 0) log.warn(`保留了中途手工改过的 ${kept.map((f) => path.relative(ROOT, f)).join('、')}`);
    log.info(c.dim('没有打 tag，没有提交，工作区与演练前一致。'));
    return;
  }

  process.stdout.write('\n');

  // ── 确认这个版本真的在 registry 上 ──────────────────────────
  if (pkg.version !== version) {
    log.warn(
      `package.json 里现在写的是 ${pkg.version}，而这次发布的是 ${version} —— ` +
        'tag 会打在当前 HEAD 上，请确认它们对得上',
    );
  }

  let confirmed = false;
  if (process.env.FWS_RELEASE_OFFLINE === '1') {
    confirmed = true;
  } else {
    // 读接口偶尔比写接口慢一拍，给它三次机会再说「查不到」
    for (const wait of [0, 2000, 5000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const probe = queryRegistry(`${name}@${version}`, { registry });
      if (probe.reachable && probe.published.includes(version)) {
        confirmed = true;
        break;
      }
    }
  }

  if (!confirmed) {
    // 不打 tag：tag 是「这份代码 = 这个版本」的声明，声明错了比不声明更麻烦
    die(`${version} 没能从 registry 上确认，因此**没有**打 tag`, [
      'npm 只在发布成功之后才会跑 postpublish，所以包大概已经在 npm 上了；',
      '但这里连查几次都没查到，可能只是查询接口还没同步过来。',
      '',
      `先肉眼确认：npm view ${name}@${version} version`,
      '确认存在后，手工补上：',
      ...manualSteps({ version, tag, branch, remote: remotes[0] }).map((l) => `  ${l}`),
    ]);
  }

  if (process.env.FWS_RELEASE_OFFLINE === '1') {
    log.warn(`离线模式：跳过 registry 确认，直接按发布成功处理（${name}@${version}）`);
  } else {
    log.ok(`已确认 ${c.bold(`${name}@${version}`)} 在 registry 上（dist-tag ${distTag}）`);
  }

  // ── CI 里不碰 git ───────────────────────────────────────────
  if (isCI || noGit) {
    clearState(ROOT);
    log.warn(
      isCI
        ? 'CI 环境：跳过提交与打 tag（版本号必须由人在本地提交好，CI 只负责发出去）'
        : 'FWS_RELEASE_NO_GIT：跳过提交与打 tag',
    );
    log.info(c.dim(`记得在本地补上：git tag -a ${tag} -m "${version}"`));
    printPublished(name, version);
    return;
  }

  // ── 打 tag 前的最后一道闸：仓库状态 ─────────────────────────
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    clearState(ROOT);
    die('当前目录不是 git 仓库，无法打 tag 与提交', [
      `包已经发布成功（${name}@${version}）。`,
      '请在有仓库副本的地方补上：',
      ...manualSteps({ version, tag, branch, remote: remotes[0] }).map((l) => `  ${l}`),
    ]);
  }

  if (tagExists(tag)) {
    const sha = git(['rev-list', '-n', '1', tag]).stdout.trim();
    clearState(ROOT);
    die(`tag ${tag} 已经存在（指向 ${sha.slice(0, 8)}），没有动它`, [
      '包已经发布成功，但 tag 是旧的 —— 直接把它指到新提交上，等于悄悄改写了历史，',
      '所以这里停住，交给人决定：',
      '',
      `  git tag -d ${tag}          # 确认那个 tag 只在本地、且是失败发布的残留`,
      ...manualSteps({ version, tag, branch, remote: remotes[0] })
        .slice(1)
        .map((l) => `  ${l}`),
      '',
      `若 ${tag} 已经推到远端，请不要动它 —— 换一个版本号重新发布。`,
    ]);
  }

  // 只提交我们自己改过的文件。别的改动如果混进来，那个 tag 就名不副实了。
  const files = Object.keys(state.files ?? {});
  const relatives = files.map((f) => path.relative(ROOT, f));
  const others = git(['status', '--porcelain'])
    .stdout.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\S+\s+/, ''))
    .filter((f) => f && !relatives.some((r) => f === r || f.startsWith(`${r}/`)));

  if (others.length > 0) {
    log.warn(`工作区里还有 ${others.length} 处与本次发布无关的改动，它们不会被提交（tag 只对应发布内容）`);
    for (const f of others.slice(0, 5)) log.note(`${c.dim('│')} ${f}`);
  }

  // 直接敲 `npm publish` 时（核对模式），版本号是人事先提交好的，
  // 这里没有东西要提交 —— 那就只打 tag，不要造一个空提交出来。
  if (relatives.length === 0) {
    log.skip('没有需要提交的文件（版本号已经在 HEAD 里）');
  } else {
    const added = git(['add', ...relatives]);
    if (!added.ok) log.warn(`git add 失败：${added.stderr.trim()}`);

    const message = `chore(release): ${tag}`;
    const body = commitBody(notes);
    const commitArgs = ['commit', '-m', message];
    if (body) commitArgs.push('-m', body);

    const committed = git(commitArgs);
    if (!committed.ok) {
      clearState(ROOT);
      die('提交失败 —— 包已经发布，但版本号没有进仓库', [
        committed.stderr.trim() || committed.stdout.trim(),
        '',
        ...manualSteps({ version, tag, branch, remote: remotes[0] }).map((l) => `  ${l}`),
      ]);
    }
    log.ok(`已提交 ${c.bold(git(['rev-parse', '--short', 'HEAD']).stdout.trim())} ${message}`);
  }

  const tagged = git(['tag', '-a', tag, '-m', notes?.trim() || `发布 ${version}`]);
  if (!tagged.ok) {
    clearState(ROOT);
    die('打 tag 失败 —— 包已经发布，提交已完成', [
      tagged.stderr.trim() || tagged.stdout.trim(),
      '',
      ...manualSteps({ version, tag, branch, remote: remotes[0] })
        .slice(2)
        .map((l) => `  ${l}`),
    ]);
  }
  log.ok(`已打 tag ${c.bold(tag)}（说明取自 CHANGELOG）`);

  // ── 推送 ───────────────────────────────────────────────────
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) {
    clearState(ROOT);
    log.warn('没有配置 git remote：提交和 tag 只在本地');
    log.info(c.dim(`配置远端后推送：git push <remote> ${branch ?? 'HEAD'} && git push <remote> ${tag}`));
    printPublished(name, version);
    return;
  }

  // 有上游分支就直接推；没有则顺手把上游建起来（-u），否则 tag 推上去了、分支还在本地
  const hasUpstream = Boolean(state.upstream);
  const pushArgs = hasUpstream ? ['push', remote] : ['push', '-u', remote, branch];
  const pushed = git(pushArgs);
  if (pushed.ok) log.ok(`已推送分支到 ${remote}`);
  else log.warn(`推送分支失败：${pushed.stderr.trim().split('\n')[0]}`);

  const pushedTag = git(['push', remote, `refs/tags/${tag}`]);
  if (pushedTag.ok) log.ok(`已推送 tag ${tag} 到 ${remote}`);
  else log.warn(`推送 tag 失败：${pushedTag.stderr.trim().split('\n')[0]}`);

  clearState(ROOT);
  printPublished(name, version);

  if (!pushed.ok || !pushedTag.ok) {
    die('包已发布成功，但推送没做完', [
      '提交和 tag 都在本地，只是没推上去（网络、权限，或者分支需要先拉取）。',
      '',
      `  git push ${remote} ${branch ?? 'HEAD'}`,
      `  git push ${remote} ${tag}`,
    ]);
  }
}

function printPublished(name, version) {
  process.stdout.write('\n');
  log.ok(`发布完成：${c.bold(`${name}@${version}`)}`);
  log.info(`npm   https://www.npmjs.com/package/${name}/v/${version}`);
  log.info(`安装  npm i ${name}@${version}`);
}

main().catch((error) => {
  die('发布收尾阶段异常中断', [
    '包很可能已经发布成功 —— 这只影响 tag 与提交。',
    error?.stack ?? String(error),
  ]);
});
