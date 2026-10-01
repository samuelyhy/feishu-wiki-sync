import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// 发布脚本刻意是纯 ESM（不进 dist、不打包、不发布），因此 tsc 看不到它的类型。
// 这里只放行这一行 —— 下面每条断言都是真实调用，行为仍然是测出来的。
// @ts-ignore
import * as release from '../../scripts/release/lib.mjs';

const {
  DEFAULT_PRE_RELEASE_COMMIT_MSG,
  compareVersions,
  extractNotes,
  findSection,
  findSensitivePaths,
  incrementVersion,
  insertSection,
  isSensitivePath,
  normalizeVersions,
  parseChangelog,
  parseCommits,
  prereleaseTag,
  renderReleaseNotes,
  resolveTargetVersion,
  setPackageVersion,
  stampDate,
} = release;

/**
 * 守着发版这件事里**判断**的部分。
 *
 * ## 为什么这些逻辑值得单独测
 *
 * 发布是不可逆的：72 小时后不能撤回，版本号永久占用。真正会出事的地方
 * 不是「脚本能不能跑通」，而是它**算错了却照样跑通** ——
 * 比如把「只有一个远端版本」的返回值从数组压成字符串，于是
 * `已发布列表.includes('0.1.0')` 永远为假，脚本高高兴兴地拿一个
 * 已经被占用的版本号去发，直到 npm 用 EPUBLISHCONFLICT 拒绝它。
 *
 * 这类错误在真机上只表现为「发版失败」，而在这里是一行断言。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/tests → 工程根 */
const ROOT = path.resolve(here, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
  files: string[];
  scripts: Record<string, string>;
  publishConfig?: { registry?: string };
};
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

describe('版本号比较', () => {
  it('按数字而不是字符串比大小', () => {
    // 字符串比较会说 "0.10.0" < "0.9.9" —— 差一点就发错版本
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  });

  it('正式版大于同号预发布版', () => {
    // 搞反了会让脚本认为 1.0.0 已经发布过，于是白改一个版本号
    assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  });

  it('拒绝不是语义化的版本号，而不是悄悄当成 0', () => {
    assert.throws(() => compareVersions('1.2', '1.2.3'), /非语义化/);
  });
});

describe('版本号递增', () => {
  it('按 major / minor / patch 递增', () => {
    assert.equal(incrementVersion('1.2.3', 'patch'), '1.2.4');
    assert.equal(incrementVersion('1.2.3', 'minor'), '1.3.0');
    assert.equal(incrementVersion('1.2.3', 'major'), '2.0.0');
  });

  it('patch 递进去掉预发布后缀，而不是再进一位', () => {
    // `npm version patch` 就是这个行为。这里若写成 1.2.4，
    // 一个已经定稿的 1.2.3 就被永久跳过了。
    assert.equal(incrementVersion('1.2.3-beta.1', 'patch'), '1.2.3');
  });

  it('预发布版继续递进时加号而不是进位', () => {
    assert.equal(incrementVersion('1.2.0-beta.3', 'prerelease'), '1.2.0-beta.4');
    assert.equal(incrementVersion('1.2.0', 'prerelease'), '1.2.1-0');
  });
});

describe('决定发哪个版本号', () => {
  it('本地版本没发布过 → 原样发布，不动它', () => {
    // 版本号是人写好的，脚本不该替人做这个决定
    const r = resolveTargetVersion({ localVersion: '0.1.1', published: ['0.1.0'], bump: 'patch' });
    assert.equal(r.target, '0.1.1');
    assert.equal(r.bumped, false);
  });

  it('本地版本发布过了 → 递增', () => {
    const r = resolveTargetVersion({ localVersion: '0.1.0', published: ['0.1.0'], bump: 'patch' });
    assert.equal(r.target, '0.1.1');
    assert.equal(r.bumped, true);
  });

  it('本地落后远端时，从远端最新版递增', () => {
    // 手边是一份落后的副本（本地 0.1.0，远端已经 0.2.0）。
    // 从本地递增算出的 0.1.1 多半也已经被占用了。
    const r = resolveTargetVersion({
      localVersion: '0.1.0',
      published: ['0.1.0', '0.1.1', '0.2.0'],
      bump: 'patch',
    });
    assert.equal(r.target, '0.2.1');
  });

  it('连续跳过已被占用的号', () => {
    const r = resolveTargetVersion({
      localVersion: '0.1.0',
      published: ['0.1.0', '0.1.1', '0.1.2'],
      bump: 'patch',
    });
    assert.equal(r.target, '0.1.3');
  });

  it('不允许递增又已经发布过 → 报错而不是硬发', () => {
    assert.throws(
      () => resolveTargetVersion({ localVersion: '0.1.0', published: ['0.1.0'], bump: 'none' }),
      /已经发布过/,
    );
  });

  it('首次发布', () => {
    const r = resolveTargetVersion({ localVersion: '0.1.0', published: [], bump: 'patch' });
    assert.equal(r.target, '0.1.0');
    assert.equal(r.bumped, false);
  });
});

describe('远端版本数据的归一化', () => {
  it('只有一个版本时 npm 返回的是字符串，必须当成一个元素的列表', () => {
    // 这是实测出来的：`npm view <pkg> versions --json` 在只有一个版本时
    // 返回 "0.1.0" 而不是 ["0.1.0"]。不归一化的话 published.length 会是 5，
    // includes() 永远为假 —— 于是脚本会去发一个已经存在的版本号。
    assert.deepEqual(normalizeVersions('0.1.0'), ['0.1.0']);
    assert.deepEqual(normalizeVersions(['0.1.0', '0.1.1']), ['0.1.0', '0.1.1']);
    assert.deepEqual(normalizeVersions(null), []);
  });

  it('预发布版要有自己的 dist-tag，不能顶掉 latest', () => {
    assert.equal(prereleaseTag('1.2.0-beta.3'), 'beta');
    assert.equal(prereleaseTag('1.2.0'), null);
  });
});

describe('改写 package.json', () => {
  const original = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');

  it('只动 version 那一行，其余一个字节都不改', () => {
    // 用 JSON.parse/stringify 重写整个文件，会让发布提交里混进几千行
    // 格式变动，真正改了什么反而看不见
    const next = setPackageVersion(original, '9.9.9');
    assert.equal(
      next.replace(/"version": "9\.9\.9"/, '"version": "0.0.0"'),
      original.replace(/"version": "[^"]*"/, '"version": "0.0.0"'),
    );
    assert.match(next, /"version": "9\.9\.9"/);
  });

  it('找不到 version 字段时明确报错', () => {
    assert.throws(() => setPackageVersion('{"name":"x"}', '1.0.0'), /找不到/);
  });
});

describe('变更日志', () => {
  it('能解析出本仓库已有的版本段落', () => {
    const sections = parseChangelog(changelog);
    assert.ok(sections.length >= 2);
    assert.equal(sections[0].version, pkg.version);
    assert.ok(
      sections.every((s: { body: string }) => s.body.length > 0),
      '每个段落都该有正文',
    );
    // 新版本在前 —— CHANGELOG 是倒序的，插错位置会让人以为这版什么都没改
    assert.ok(compareVersions(sections[0].version, sections[1].version) > 0);
  });

  it('段落之间不留重复的分隔线', () => {
    const next = insertSection(changelog, {
      version: '99.0.0',
      date: '2026-01-01',
      body: '正文。',
    });
    const sections = parseChangelog(next);
    assert.equal(sections[0].version, '99.0.0');
    assert.equal(sections[1].version, pkg.version);
    assert.ok(!/\n-{3,}\s*\n\s*-{3,}\s*\n/.test(next), '不该出现连续两条 ---');
    assert.equal(sections[0].body, '正文。');
  });

  it('没有日期的段落会补上日期', () => {
    const withoutDate = changelog.replace(/^## \[0\.1\.1\].*$/m, '## [0.1.1]');
    const { md, changed } = stampDate(withoutDate, '0.1.1', '2026-11-11');
    assert.equal(changed, true);
    assert.match(md, /^## \[0\.1\.1\].*2026-11-11$/m);
    // 已经有日期的不要重复加
    assert.equal(stampDate(md, '0.1.1', '2026-12-12').changed, false);
  });

  it('查不到的版本返回 null，而不是一个空的段落', () => {
    assert.equal(extractNotes(changelog, '99.0.0'), null);
    assert.equal(findSection(changelog, '99.0.0'), null);
  });
});

describe('提交记录 → 发布说明', () => {
  const raw =
    'a1b2c3d\x1ffeat(cli): 支持 --json\x1f\x1e' +
    'b2c3d4e\x1ffix: 修掉块级更新的偏移\x1f\x1e' +
    'c3d4e5f\x1fdocs: 补 README\x1f\x1e' +
    'd4e5f60\x1fchore(release): v0.1.2\x1f\x1e' +
    'e5f6071\x1frefactor!: 改掉配置字段\x1f\x1e';

  it('拆出类型、范围与破坏性标记', () => {
    const commits = parseCommits(raw);
    assert.equal(commits.length, 5);
    assert.equal(commits[0].type, 'feat');
    assert.equal(commits[0].scope, 'cli');
    assert.equal(commits[0].text, '支持 --json');
    assert.equal(commits[4].breaking, true);
  });

  it('按章节归拢，破坏性变更排在最前', () => {
    const notes = renderReleaseNotes(parseCommits(raw), { range: 'v0.1.1..HEAD' });
    assert.ok(notes);
    assert.ok(notes.indexOf('破坏性变更') < notes.indexOf('### 新增'));
    assert.ok(notes.indexOf('### 新增') < notes.indexOf('### 修复'));
    assert.match(notes, /支持 --json/);
    assert.match(notes, /\*\*cli\*\*：/);
  });

  it('发版自身的提交不进发布说明', () => {
    // 「chore(release): v0.1.2 用什么号」对使用者毫无信息量
    const notes = renderReleaseNotes(parseCommits(raw), {});
    assert.ok(!notes?.includes('chore(release)'));
  });

  it('提不出内容时返回 null，让调用方拒绝发布', () => {
    // 返回一个空段落的话，CHANGELOG 里就会出现一节什么都没说的版本
    assert.equal(renderReleaseNotes([], {}), null);
    assert.equal(
      renderReleaseNotes(parseCommits('a1b2c3d\x1fchore(release): v0.1.2\x1f\x1e'), {}),
      null,
    );
  });
});

describe('发布前自动提交：敏感路径', () => {
  it('识别常见密钥文件，放过 .env.example', () => {
    assert.equal(isSensitivePath('.env'), true);
    assert.equal(isSensitivePath('apps/foo/.env.local'), true);
    assert.equal(isSensitivePath('certs/server.pem'), true);
    assert.equal(isSensitivePath('id_rsa'), true);
    assert.equal(isSensitivePath('my-credentials.json'), true);
    assert.equal(isSensitivePath('.env.example'), false);
    assert.equal(isSensitivePath('src/core/config.ts'), false);
  });

  it('findSensitivePaths 只返回命中项', () => {
    assert.deepEqual(findSensitivePaths(['README.md', '.env', 'src/a.ts', 'secret-token.txt']), [
      '.env',
      'secret-token.txt',
    ]);
  });

  it('默认提交消息非空', () => {
    assert.ok(DEFAULT_PRE_RELEASE_COMMIT_MSG.trim().length > 0);
  });
});

/**
 * 发布链路本身也要有判据。
 *
 * 钩子被删掉、CHANGELOG 忘了写、发布脚本被打进包里 —— 这三件事都不会让
 * 任何测试变红，却都会在真正发版那天出问题。所以在这里钉住。
 */
describe('发布链路', () => {
  it('prepublishOnly 与 postpublish 都指向真实存在的脚本', () => {
    // npm 只在真正推包前后跑这两个钩子。少一个，就只能发出一个
    // 「没有 tag、没有提交、CHANGELOG 也没更新」的版本 —— 而且不可撤回。
    for (const hook of ['prepublishOnly', 'postpublish']) {
      const command = pkg.scripts[hook];
      assert.ok(command, `package.json 缺少 ${hook}`);
      const file = /node\s+(\S+)/.exec(command)?.[1];
      assert.ok(file, `${hook} 应该是一个 node 脚本`);
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${hook} 指向的 ${file} 不存在`);
    }
    assert.ok(pkg.scripts.release, '缺少一键发布入口 npm run release');
  });

  it('版本号在 CHANGELOG 里有对应段落', () => {
    // 「改了 package.json 忘了改 CHANGELOG」是最常见的发布事故，
    // 而且发到 npm 上之后才发现 —— 那时已经晚了
    const section = findSection(changelog, pkg.version);
    assert.ok(section, `CHANGELOG.md 里没有 [${pkg.version}] 段落`);
    assert.ok(section.body.trim().length > 0, `[${pkg.version}] 段落是空的`);
    assert.ok(section.date, `[${pkg.version}] 段落没有日期`);
  });

  it('最新的 CHANGELOG 段落就是 package.json 的版本', () => {
    // 版本号停在 0.2.0、CHANGELOG 顶部却已经是 0.3.0，说明上一个版本
    // 只在文档里存在过
    assert.equal(parseChangelog(changelog)[0].version, pkg.version);
  });

  it('cli 支持发布前自动提交相关开关', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'release', 'cli.mjs'), 'utf8');
    assert.match(cli, /--no-auto-commit/, '缺少 --no-auto-commit');
    assert.match(cli, /--commit-message/, '缺少 --commit-message');
  });

  it('--check 跑完必须停下，不能接着把包发了', () => {
    // 这条不是假想的。`--check` 原本写成「跑完 preflight，失败才退出」，
    // 于是体检通过之后，控制流直接落到下面去把包发布了 —— 真的发出过一次，
    // 只是被 npm 的 403 拦在了门外。
    //
    // 行为测试要跑到真 registry 才能覆盖它，代价太大（而且测试不该联网），
    // 所以这里退回源码层面把这条约束钉死：`--check` 那个分支里必须有
    // 无条件退出。
    const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'release', 'cli.mjs'), 'utf8');
    const start = cli.indexOf('if (env.FWS_RELEASE_CHECK)');
    assert.ok(start > 0, 'cli.mjs 里找不到 --check 分支');

    const end = cli.indexOf('\n  }', start);
    const branch = cli.slice(start, end);
    assert.match(branch, /process\.exit\(/, '--check 分支里必须无条件退出，否则会继续发布');
  });

  it('发布脚本本身不进 npm 包', () => {
    for (const entry of pkg.files) {
      assert.ok(!entry.startsWith('scripts'), `files 里不该有 ${entry}`);
    }
  });
});
