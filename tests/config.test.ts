import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';

import { CONFIG_DIR, CONFIG_FILE, loadConfig, validateConfig, type SyncConfig } from '../src/core/config.js';
import { parseEnvFile } from '../src/core/env.js';
import { ConfigError } from '../src/errors.js';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function projectWithConfig(raw: unknown): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-cfg-'));
  tmpDirs.push(tmp);
  fs.mkdirSync(path.join(tmp, CONFIG_DIR), { recursive: true });
  fs.writeFileSync(path.join(tmp, CONFIG_DIR, CONFIG_FILE), stringifyYaml(raw), 'utf8');
  return tmp;
}

function base(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    version: 1,
    spaceId: 's1',
    mappings: [
      {
        source: 'docs/specs',
        parentNodeToken: 'w1',
        include: ['**/*.md'],
        exclude: [],
        onMissing: 'create',
        onAmbiguous: 'fail',
      },
    ],
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('缺少配置文件时给出可执行的修复指引', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-nocfg-'));
    tmpDirs.push(tmp);
    assert.throws(
      () => loadConfig(tmp),
      (err: unknown) => err instanceof ConfigError && /fws init/.test(err.hint ?? ''),
    );
  });

  it('defaults 会合并进每个 mapping', () => {
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      defaults: { include: ['**/*.md'], exclude: ['skip/**'], on_missing: 'fail' },
      mappings: [{ source: 'a', parent_node_token: 'w1' }],
    });

    const cfg = loadConfig(tmp);
    assert.deepEqual(cfg.mappings[0]!.exclude, ['skip/**']);
    assert.equal(cfg.mappings[0]!.onMissing, 'fail');
  });

  it('mapping 自身设置覆盖 defaults', () => {
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      defaults: { on_missing: 'fail' },
      mappings: [{ source: 'a', parent_node_token: 'w1', on_missing: 'create' }],
    });
    assert.equal(loadConfig(tmp).mappings[0]!.onMissing, 'create');
  });

  it('非法 on_missing 回退到默认值而不是抛错', () => {
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      mappings: [{ source: 'a', parent_node_token: 'w1', on_missing: 'whatever' }],
    });
    assert.equal(loadConfig(tmp).mappings[0]!.onMissing, 'create');
  });

  it('YAML 语法错误报告为配置错误', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-badyaml-'));
    tmpDirs.push(tmp);
    fs.mkdirSync(path.join(tmp, CONFIG_DIR), { recursive: true });
    fs.writeFileSync(path.join(tmp, CONFIG_DIR, CONFIG_FILE), 'a: [unclosed\n', 'utf8');
    assert.throws(() => loadConfig(tmp), ConfigError);
  });
});

describe('validateConfig', () => {
  it('缺少 space_id 时报错', () => {
    assert.throws(() => validateConfig(base({ spaceId: '' })), /space_id/);
  });

  it('没有 mappings 时报错', () => {
    assert.throws(() => validateConfig(base({ mappings: [] })), /mappings/);
  });

  it('不支持的版本时报错', () => {
    assert.throws(() => validateConfig(base({ version: 99 })), /版本/);
  });

  it('同一父节点被两个 source 复用时报错 —— 否则两份文件会互相覆盖', () => {
    const cfg = base({
      mappings: [
        { ...base().mappings[0]!, source: 'a' },
        { ...base().mappings[0]!, source: 'b' },
      ],
    });
    assert.throws(() => validateConfig(cfg), /同时使用/);
  });

  it('嵌套的 source **不再**被拒 —— 路径嵌套本身无害', () => {
    // 早先这里一律拒绝父子目录的 source，理由是「会让同一文件被处理两次」。
    // 但那把安全配置也拒了：上层只用 `*.md`（不递归）时，两者文件集根本不相交。
    // 现在改成在扫描阶段精确检查「有没有文件被两个 mapping 匹配」——
    // 见 scanner.test.ts 的 findOverlappingFiles。
    const cfg = base({
      mappings: [
        { ...base().mappings[0]!, source: 'docs', parentNodeToken: 'w1' },
        { ...base().mappings[0]!, source: 'docs/specs', parentNodeToken: 'w2' },
      ],
    });
    assert.doesNotThrow(() => validateConfig(cfg));
  });

  it('拒绝绝对路径与越出工程的路径', () => {
    assert.throws(
      () => validateConfig(base({ mappings: [{ ...base().mappings[0]!, source: '../escape' }] })),
      /相对路径/,
    );
  });

  it('合法配置通过校验', () => {
    assert.doesNotThrow(() => validateConfig(base()));
  });
});

describe('未实现的配置项：加载即拒绝，而不是静默失效', () => {
  it('nesting: mirror 报错', () => {
    // 静默 no-op 是最不能接受的缺陷类型：用户以为会有目录层级，实际全部平铺，
    // 而且不报错、不告警，等发现时知识库结构已经乱了。
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      mappings: [{ source: 'a', parent_node_token: 'w1', nesting: 'mirror' }],
    });
    assert.throws(() => loadConfig(tmp), /nesting: mirror/);
  });

  it('nesting: flat 允许保留（与当前行为一致，老配置不必改）', () => {
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      mappings: [{ source: 'a', parent_node_token: 'w1', nesting: 'flat' }],
    });
    assert.doesNotThrow(() => loadConfig(tmp));
  });

  it('on_delete 报错', () => {
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      mappings: [{ source: 'a', parent_node_token: 'w1', on_delete: 'deprecate' }],
    });
    assert.throws(() => loadConfig(tmp), /on_delete/);
  });

  it('defaults 里的 on_delete 同样报错', () => {
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      defaults: { on_delete: 'warn' },
      mappings: [{ source: 'a', parent_node_token: 'w1' }],
    });
    assert.throws(() => loadConfig(tmp), /on_delete/);
  });

  it('archive_node_token 报错', () => {
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      archive_node_token: 'w9',
      mappings: [{ source: 'a', parent_node_token: 'w1' }],
    });
    assert.throws(() => loadConfig(tmp), /archive_node_token/);
  });

  it('on_ambiguous: newest 报错 —— 它只是取列表最后一个，不是按时间取最新', () => {
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      mappings: [{ source: 'a', parent_node_token: 'w1', on_ambiguous: 'newest' }],
    });
    assert.throws(() => loadConfig(tmp), /on_ambiguous/);
  });

  it('错误信息给出「怎么办」', () => {
    const tmp = projectWithConfig({
      version: 1,
      space_id: 's1',
      mappings: [{ source: 'a', parent_node_token: 'w1', nesting: 'mirror' }],
    });
    assert.throws(
      () => loadConfig(tmp),
      (err: unknown) => err instanceof ConfigError && /删除/.test(err.hint ?? ''),
    );
  });
});

describe('parseEnvFile', () => {
  it('解析 KEY=VALUE，忽略注释与空行', () => {
    const env = parseEnvFile('# 注释\n\nA=1\nB=two\n');
    assert.deepEqual(env, { A: '1', B: 'two' });
  });

  it('去掉成对引号', () => {
    assert.deepEqual(parseEnvFile('A="x y"\nB=\'z\'\n'), { A: 'x y', B: 'z' });
  });

  it('值里含等号时只按第一个等号切分', () => {
    assert.deepEqual(parseEnvFile('A=b=c\n'), { A: 'b=c' });
  });

  it('忽略没有等号的行', () => {
    assert.deepEqual(parseEnvFile('GARBAGE\nA=1\n'), { A: '1' });
  });
});
