import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { COMMANDS, EXIT_CODE_DOCS, GLOBAL_FLAGS } from '../src/cli-spec.js';

/**
 * 守着「命令手册不腐烂」。
 *
 * ## 为什么需要它
 *
 * 手维护的命令清单一定会烂，而且**烂得没有声音**：改了代码忘了改文档，
 * 文档看起来仍然是对的，直到有人照着它敲了一条不存在的命令。
 * 唯一可靠的办法是让机器比对「文档里写的」与「代码实际接受的」。
 *
 * 这也正是本项目其他门禁的思路：判据写在测试里，而不是寄望于人的自觉。
 *
 * ## 比对的是双向相等
 *
 * 只查「文档里的命令都存在」不够 —— 那样新加的命令永远不必写进文档。
 * 必须同时保证「代码里的每个命令、每个开关都在文档里有交代」。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/tests → 工程根 */
const ROOT = path.resolve(here, '..', '..');
const MANUAL = path.join(ROOT, 'feishu-wiki-sync-commands.md');

function readManual(): string {
  assert.ok(fs.existsSync(MANUAL), `手册不存在: ${MANUAL}`);
  return fs.readFileSync(MANUAL, 'utf8');
}

/**
 * 切出 `### fws <name>` 章节。
 *
 * 章节在**下一个任意级别的标题**处结束，而不是「下一个 ### fws」——
 * 后者会让最后一个命令章节一直吞到文末，把「全局选项」等章节也算进去，
 * 于是比对时多出一堆本不属于该命令的开关。
 */
function commandSections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];

  const flush = (): void => {
    if (current !== null) out.set(current, buf.join('\n'));
    buf = [];
    current = null;
  };

  for (const line of md.split(/\r?\n/)) {
    const heading = line.match(/^#{2,3}\s+(.*)$/);
    if (heading) {
      flush();
      const named = heading[1]!.match(/^fws\s+([a-z-]+)\s*$/);
      if (named) current = named[1]!;
      continue;
    }
    if (current !== null) buf.push(line);
  }
  flush();

  return out;
}

/** 取出某个 `## 或 ###` 标题下的正文，到下一个同级或更高级标题为止。 */
function sectionBody(md: string, title: string): string | undefined {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let collecting = false;

  for (const line of lines) {
    const heading = line.match(/^(#{2,3})\s+(.*)$/);
    if (heading) {
      if (collecting) break;
      if (heading[2]!.trim() === title) collecting = true;
      continue;
    }
    if (collecting) out.push(line);
  }

  return collecting || out.length > 0 ? out.join('\n') : undefined;
}

/** 从表格行里抽出反引号包裹的 `--flag`，忽略 `<值>` 之类的占位。 */
function flagsIn(section: string): string[] {
  const out = new Set<string>();
  for (const line of section.split(/\r?\n/)) {
    const row = line.match(/^\|\s*`(--[a-z][a-z-]*)[^`]*`/);
    if (row?.[1]) out.add(row[1]);
  }
  return [...out].sort();
}

describe('命令手册与实现不漂移', () => {
  const md = readManual();

  it('文档里的命令集与代码里的严格相等（双向）', () => {
    const documented = [...commandSections(md).keys()].sort();
    const implemented = COMMANDS.map((c) => c.name).sort();

    assert.deepEqual(
      documented,
      implemented,
      '手册的命令章节必须与 src/cli-spec.ts 的双向相等 —— ' +
        '加了命令就要写进手册，删了命令就要从手册里删掉',
    );
  });

  it('每个命令的开关集与代码里的严格相等（双向）', () => {
    const sections = commandSections(md);

    for (const cmd of COMMANDS) {
      const section = sections.get(cmd.name);
      assert.ok(section, `手册缺少 ### fws ${cmd.name} 章节`);

      assert.deepEqual(
        flagsIn(section),
        cmd.flags.map((f) => `--${f.name}`).sort(),
        `fws ${cmd.name} 的开关集与 cli-spec.ts 不一致`,
      );
    }
  });

  it('全局选项在手册里完整列出', () => {
    const globalSection = sectionBody(md, '全局选项');
    assert.ok(globalSection, '手册缺少「全局选项」章节');

    assert.deepEqual(
      flagsIn(globalSection),
      GLOBAL_FLAGS.map((f) => `--${f.name}`).sort(),
      '全局选项集与 cli-spec.ts 不一致',
    );
  });

  it('退出码表与代码里的契约一致', () => {
    // 手册里的退出码出现在两个地方：命令总览之后的说明、以及 sync 章节的表格。
    // 这里只校验「每个退出码都在手册中出现过」，避免重复表述带来的维护负担。
    for (const entry of EXIT_CODE_DOCS) {
      assert.match(
        md,
        new RegExp(`\\b${entry.code}\\b[^\\n]*${escapeRe(entry.meaning.slice(0, 6))}`),
        `退出码 ${entry.code}（${entry.meaning}）未在手册中交代`,
      );
    }
  });

  it('手册明确写出了那些「不做的事」', () => {
    // 未实现的能力必须显式声明，否则读者会以为配了就管用。
    // 这几项是最容易被误以为已支持的。
    for (const keyword of ['nesting: mirror', 'on_delete', '删除节点']) {
      assert.ok(
        md.includes(keyword),
        `手册必须说明「${keyword}」不被支持 —— 静默的能力缺失比报错更糟`,
      );
    }
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
