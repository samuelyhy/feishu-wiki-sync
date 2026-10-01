import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { LEDGER_FILE, CONFIG_DIR } from '../src/core/config.js';
import { LedgerStore, type LedgerDoc } from '../src/core/ledger.js';
import { ConfigError } from '../src/errors.js';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpProject(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-ledger-'));
  tmpDirs.push(tmp);
  return tmp;
}

function doc(nodeToken: string, objToken = 'd1'): LedgerDoc {
  return {
    node_token: nodeToken,
    obj_token: objToken,
    title: 't',
    claimed_by: 'title',
    local_sha256: 'a'.repeat(64),
    remote_revision_id: 1,
    images: {},
    last_synced_at: '2026-09-30T00:00:00.000Z',
  };
}

describe('LedgerStore', () => {
  it('账本不存在时返回空账本', () => {
    const store = new LedgerStore(tmpProject(), 's1');
    assert.deepEqual(store.paths(), []);
    assert.equal(store.get('x.md'), undefined);
  });

  it('保存后能重新加载', () => {
    const tmp = tmpProject();
    const store = new LedgerStore(tmp, 's1');
    store.set('docs/a.md', doc('w1'));
    store.save();

    const reloaded = new LedgerStore(tmp, 's1');
    assert.equal(reloaded.get('docs/a.md')?.node_token, 'w1');
  });

  it('写入是原子的：不留下 .tmp 残file', () => {
    const tmp = tmpProject();
    const store = new LedgerStore(tmp, 's1');
    store.set('a.md', doc('w1'));
    store.save();

    const dir = path.join(tmp, CONFIG_DIR);
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'rename 之后不该残留临时文件');
    assert.ok(fs.existsSync(path.join(dir, LEDGER_FILE)));
  });

  it('账本损坏时报配置错误并给出恢复路径', () => {
    const tmp = tmpProject();
    fs.mkdirSync(path.join(tmp, CONFIG_DIR), { recursive: true });
    fs.writeFileSync(path.join(tmp, CONFIG_DIR, LEDGER_FILE), '{ not json', 'utf8');

    assert.throws(
      () => new LedgerStore(tmp, 's1'),
      (err: unknown) => err instanceof ConfigError && /reclaim/.test(err.hint ?? ''),
    );
  });

  it('同一 node_token 被两个路径引用时加载即失败 —— 这是静默数据损坏', () => {
    const tmp = tmpProject();
    fs.mkdirSync(path.join(tmp, CONFIG_DIR), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, CONFIG_DIR, LEDGER_FILE),
      JSON.stringify({
        version: 1,
        space_id: 's1',
        documents: { 'a.md': doc('same'), 'b.md': doc('same', 'd2') },
        aliases: {},
      }),
      'utf8',
    );

    assert.throws(() => new LedgerStore(tmp, 's1'), /同一个节点/);
  });

  it('pathForNode 反查已认领路径', () => {
    const store = new LedgerStore(tmpProject(), 's1');
    store.set('a.md', doc('w1'));
    assert.equal(store.pathForNode('w1'), 'a.md');
    assert.equal(store.pathForNode('nope'), undefined);
  });

  it('aliases 支持本地重命名后找回原节点', () => {
    const store = new LedgerStore(tmpProject(), 's1');
    store.addAlias('old.md', 'w1');
    assert.equal(store.resolveAlias('old.md'), 'w1');
  });

  it('remove 后不再出现在路径列表中', () => {
    const store = new LedgerStore(tmpProject(), 's1');
    store.set('a.md', doc('w1'));
    store.remove('a.md');
    assert.deepEqual(store.paths(), []);
  });

  it('图片素材记录可跨运行复用（上传有 10000 次/天 硬限）', () => {
    const tmp = tmpProject();
    const store = new LedgerStore(tmp, 's1');
    const d = doc('w1');
    d.images = { 'assets/a.png': { sha256: 'abc', token: 'T1' } };
    store.set('a.md', d);
    store.save();

    const reloaded = new LedgerStore(tmp, 's1');
    assert.equal(reloaded.get('a.md')?.images['assets/a.png']?.token, 'T1');
  });
});
