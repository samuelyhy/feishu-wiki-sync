import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { Mapping, SyncConfig } from '../src/core/config.js';
import { LedgerStore } from '../src/core/ledger.js';
import { Syncer, type FileResult } from '../src/core/syncer.js';
import type { DocxApi } from '../src/feishu/docx.js';
import type { MediaApi } from '../src/feishu/media.js';
import type { WikiApi } from '../src/feishu/wiki.js';
import { silentLogger } from '../src/logger.js';
import { FakeFeishu } from './helpers/fake-feishu.js';

const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(parentNodeToken = 'w-root'): {
  tmp: string;
  fake: FakeFeishu;
  ledger: LedgerStore;
  run: (opts?: {
    dryRun?: boolean;
    force?: boolean;
    reclaim?: boolean;
    allowDestructive?: boolean;
  }) => Promise<FileResult[]>;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-sync-'));
  tmpDirs.push(tmp);
  fs.mkdirSync(path.join(tmp, 'docs/specs'), { recursive: true });

  const fake = new FakeFeishu();

  const mapping: Mapping = {
    source: 'docs/specs',
    parentNodeToken,
    include: ['**/*.md'],
    exclude: [],
    onMissing: 'create',
    onAmbiguous: 'fail',
  };
  const config: SyncConfig = { version: 1, spaceId: 's1', mappings: [mapping] };
  const ledger = new LedgerStore(tmp, config.spaceId);

  const syncer = new Syncer({
    cwd: tmp,
    config,
    ledger,
    wiki: fake.wiki as unknown as WikiApi,
    docx: fake.docx as unknown as DocxApi,
    media: fake.media as unknown as MediaApi,
    logger: silentLogger,
  });

  return {
    tmp,
    fake,
    ledger,
    run: (opts = {}) =>
      syncer.run({
        dryRun: opts.dryRun ?? false,
        force: opts.force ?? false,
        reclaim: opts.reclaim ?? false,
        allowDestructive: opts.allowDestructive ?? false,
      }),
  };
}

function writeDoc(tmp: string, relPath: string, content: string): void {
  fs.writeFileSync(path.join(tmp, relPath), content, 'utf8');
}

describe('Syncer 端到端', () => {
  it('首次同步：创建节点并把全部内容写入', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', '# 标题\n第一段\n第二段\n');

    const results = await run();

    assert.equal(results.length, 1);
    assert.equal(results[0]!.action, 'created');
    assert.equal(fake.nodes.length, 1, '应创建一个知识库节点');

    const docId = fake.nodes[0]!.obj_token;
    assert.deepEqual(fake.blockTexts(docId), ['# 标题', '第一段', '第二段']);
  });

  it('重复运行零写入 —— 幂等是第一判据', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', '# 标题\n正文\n');

    await run();
    fake.clearWrites();

    const second = await run();

    assert.equal(second[0]!.action, 'up-to-date');
    assert.deepEqual(fake.writes, [], `第二次运行不该有任何写调用，实际: ${fake.writes.join(',')}`);
  });

  it('中间插入一行：只插入，不重建整篇', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\n');
    await run();

    const docId = fake.nodes[0]!.obj_token;
    const idsBefore = fake.blockIds(docId);

    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nNEW\nC\n');
    fake.clearWrites();
    const results = await run();

    assert.equal(results[0]!.action, 'updated');
    assert.deepEqual(fake.blockTexts(docId), ['A', 'B', 'NEW', 'C']);

    const idsAfter = fake.blockIds(docId);
    // A、B、C 三块应保留原 block_id（评论随之保留），只有新块是新 id
    assert.equal(idsAfter[0], idsBefore[0], 'A 应保持原 block_id');
    assert.equal(idsAfter[1], idsBefore[1], 'B 应保持原 block_id');
    assert.equal(idsAfter[3], idsBefore[2], 'C 应保持原 block_id');
    assert.equal(fake.writes.filter((w) => w === 'createDescendant').length, 1);
  });

  it('修改一行：走 batch_update，block_id 不变（评论得以保留）', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\n');
    await run();

    const docId = fake.nodes[0]!.obj_token;
    const idsBefore = fake.blockIds(docId);

    writeDoc(tmp, 'docs/specs/a.md', 'A\nB-改过了\nC\n');
    fake.clearWrites();
    await run();

    assert.deepEqual(fake.blockTexts(docId), ['A', 'B-改过了', 'C']);
    assert.deepEqual(fake.blockIds(docId), idsBefore, '三块 block_id 都不该变');
    assert.ok(fake.writes.includes('batchUpdate'), '应使用 batch_update');
    assert.equal(
      fake.writes.includes('createDescendant'),
      false,
      '不该重建块 —— 重建会丢失挂在块上的评论',
    );
  });

  it('删除一行：只删该行', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\n');
    await run();

    const docId = fake.nodes[0]!.obj_token;
    const idsBefore = fake.blockIds(docId);

    writeDoc(tmp, 'docs/specs/a.md', 'A\nC\n');
    fake.clearWrites();
    await run();

    assert.deepEqual(fake.blockTexts(docId), ['A', 'C']);
    assert.equal(fake.blockIds(docId)[0], idsBefore[0]);
    assert.equal(fake.blockIds(docId)[1], idsBefore[2], 'C 应保留原 block_id');
  });

  it('文首插入 + 中间修改 + 文末删除：最终内容与本地完全一致（索引不错位）', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\nD\nE\n');
    await run();

    const docId = fake.nodes[0]!.obj_token;
    const idsBefore = fake.blockIds(docId);

    // 同时命中三种变更，并且分布在文档首、中、尾 —— 这正是写入顺序
    // 出错（先处理靠前的段导致索引失效）时会暴露的场景
    writeDoc(tmp, 'docs/specs/a.md', 'NEW\nA\nB-changed\nC\nD\n');
    fake.clearWrites();
    await run();

    assert.deepEqual(
      fake.blockTexts(docId),
      ['NEW', 'A', 'B-changed', 'C', 'D'],
      '远端内容必须与本地逐块一致',
    );

    // 文首插入把后面全部右移一位，所以 A/B/C/D 分别落在索引 1/2/3/4
    const idsAfter = fake.blockIds(docId);
    assert.equal(idsAfter.includes(idsBefore[4]!), false, 'E 应被删除');
    assert.equal(idsAfter[1], idsBefore[0], 'A 应保留 block_id');
    assert.equal(idsAfter[2], idsBefore[1], 'B 应保留 block_id（走 update）');
    assert.equal(idsAfter[3], idsBefore[2], 'C 应保留 block_id');
    assert.equal(idsAfter[4], idsBefore[3], 'D 应保留 block_id');
  });

  it('多处不连续变更：每一段都落在正确位置', async () => {
    const { tmp, fake, run } = setup();
    const lines = Array.from({ length: 12 }, (_, i) => `L${i}`);
    writeDoc(tmp, 'docs/specs/a.md', `${lines.join('\n')}\n`);
    await run();
    const docId = fake.nodes[0]!.obj_token;

    // 在第 2 行后插入、删除第 6 行、修改第 10 行
    const next = [...lines];
    next.splice(3, 0, 'INSERTED');
    next.splice(7, 1); // 原 L7
    next[10] = 'MODIFIED';
    writeDoc(tmp, 'docs/specs/a.md', `${next.join('\n')}\n`);

    await run();

    assert.deepEqual(fake.blockTexts(docId), next);
  });

  it('全量重写（内容完全不同）：内容仍然一致', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    writeDoc(tmp, 'docs/specs/a.md', 'X\nY\nZ\nW\n');
    await run();

    assert.deepEqual(fake.blockTexts(docId), ['X', 'Y', 'Z', 'W']);
  });

  it('清空文档：所有块被删除（需显式授权）', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    writeDoc(tmp, 'docs/specs/a.md', '');
    // 「把远端整篇清空」被破坏性护栏拦着，要显式授权才执行 ——
    // 这是刻意的：本地文件被误清空是最常见的误删来源
    await run({ allowDestructive: true });

    assert.deepEqual(fake.blockTexts(docId), []);
  });

  it('远端被人工修改时拒绝覆盖（漂移保护）', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    fake.editRemotely(docId, 0, '同事手工改成这样');
    fake.clearWrites();

    const results = await run();

    assert.equal(results[0]!.action, 'drift');
    assert.deepEqual(fake.writes, [], '不该写入任何内容');
    assert.deepEqual(
      fake.blockTexts(docId),
      ['同事手工改成这样', 'B'],
      '人工修改必须被保住',
    );
  });

  it('本地与远端都被改动时报告冲突', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    fake.editRemotely(docId, 0, '同事改的');
    writeDoc(tmp, 'docs/specs/a.md', 'A-本地改的\nB\n');

    const results = await run();
    assert.equal(results[0]!.action, 'conflict');
  });

  it('--force 时覆盖人工修改', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    fake.editRemotely(docId, 0, '同事改的');
    writeDoc(tmp, 'docs/specs/a.md', 'A2\nB\n');

    const results = await run({ force: true });

    assert.equal(results[0]!.action, 'updated');
    assert.deepEqual(fake.blockTexts(docId), ['A2', 'B']);
  });

  it('--dry-run 不产生任何写入', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\n');

    const results = await run({ dryRun: true });

    assert.equal(results[0]!.action, 'planned');
    assert.deepEqual(fake.writes, []);
  });

  it('本地文件改了但归一化后内容一致时，只更新账本不写远端', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A  B\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    // 多了一个空格 —— 归一化后与原来相同
    writeDoc(tmp, 'docs/specs/a.md', 'A   B\n');
    fake.clearWrites();
    const results = await run();

    assert.equal(results[0]!.action, 'up-to-date');
    assert.deepEqual(fake.writes, []);
    assert.deepEqual(fake.blockTexts(docId), ['A  B']);
  });

  it('多个文件各自认领到各自的节点', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', '# 甲\n');
    writeDoc(tmp, 'docs/specs/b.md', '# 乙\n');

    const results = await run();

    assert.equal(results.length, 2);
    assert.equal(fake.nodes.length, 2);
    const titles = fake.nodes.map((n) => n.title).sort();
    assert.deepEqual(titles, ['乙', '甲']);
  });

  it('远端已有同名文档时按标题认领，而不是新建', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', '# 已存在的文档\n内容\n');

    // 预置一个同名节点
    const existing = await fake.wiki.createNode({
      spaceId: 's1',
      parentNodeToken: 'w-root',
      title: '已存在的文档',
    });
    fake.clearWrites();

    await run();

    assert.equal(fake.nodes.length, 1, '不该新建节点');
    assert.deepEqual(fake.blockTexts(existing.obj_token), ['# 已存在的文档', '内容']);
  });

  it('同名多个时报告歧义而不猜', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', '# 重名\n内容\n');

    await fake.wiki.createNode({ spaceId: 's1', parentNodeToken: 'w-root', title: '重名' });
    await fake.wiki.createNode({ spaceId: 's1', parentNodeToken: 'w-root', title: '重名' });
    fake.clearWrites();

    const results = await run();

    assert.equal(results[0]!.action, 'ambiguous');
    assert.deepEqual(fake.writes, [], '宁可停下问人，也不能猜一个覆盖掉');
  });

  it('账本记录了节点映射，避免下次重新按标题匹配', async () => {
    const { tmp, fake, ledger, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', '# 标题\n');

    await run();

    const entry = ledger.get('docs/specs/a.md');
    assert.ok(entry, '账本应有记录');
    assert.equal(entry.node_token, fake.nodes[0]!.node_token);
    assert.equal(entry.obj_token, fake.nodes[0]!.obj_token);
    assert.match(entry.local_sha256, /^[0-9a-f]{64}$/);
  });

  it('写入中途失败后重跑能自愈，而不是被误判成「远端被人改过」', async () => {
    // 这是最隐蔽的一类死锁：写到一半挂了 → 远端 revision 变了但账本记不上
    // → 下次运行把「revision 不符」当成人工修改 → 拒绝同步并要 --force。
    // 用户看到的是「同步失败一次之后再也同步不上去」。
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    // 同时命中「改一行」（batch_update）与「加一行」（descendant），
    // 让 descendant 失败 —— 此时 update 已经落到远端了
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB-改了\nC\nNEW\n');
    fake.failOnce('createDescendant');

    const failed = await run();
    assert.equal(failed[0]!.action, 'failed', '第一次应当失败');

    const retry = await run();
    assert.equal(
      retry[0]!.action,
      'updated',
      `重跑必须能续上，实际=${retry[0]!.action}（${retry[0]!.message ?? ''}）`,
    );
    assert.deepEqual(fake.blockTexts(docId), ['A', 'B-改了', 'C', 'NEW']);
  });

  it('--reclaim 重新认领原节点，而不是新建重复文档', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', '# 标题\n内容\n');
    await run();
    assert.equal(fake.nodes.length, 1);

    const res = await run({ reclaim: true });

    assert.equal(fake.nodes.length, 1, 'reclaim 的语义是重新认领，不该产生重复节点');
    assert.equal(res[0]!.action, 'up-to-date');
  });
});

describe('Syncer 图片处理', () => {
  it('图片先插入块再上传素材，然后 replace_image', async () => {
    const { tmp, fake, run } = setup();
    fs.mkdirSync(path.join(tmp, 'docs/specs/assets'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/specs/assets/p.png'), 'fake-image-bytes');
    writeDoc(tmp, 'docs/specs/a.md', '# 标题\n![图](assets/p.png)\n正文\n');

    await run();

    const docId = fake.nodes[0]!.obj_token;
    // 顺序必须是：insert 在前、upload 在后 —— 反了会因为没有 Image BlockID 而失败
    const insertAt = fake.writes.indexOf('createDescendant');
    const uploadAt = fake.writes.indexOf('uploadImage');
    assert.ok(insertAt >= 0 && uploadAt >= 0, `应同时有插入与上传: ${fake.writes.join(',')}`);
    assert.ok(insertAt < uploadAt, '必须先插入块拿到 Image BlockID，再上传素材');

    const blocks = fake.docs.get(docId)!.blocks;
    assert.equal(blocks.length, 3, '# 标题 / 图片 / 正文');
    assert.equal(blocks[0]!.text, '# 标题');
    assert.equal(blocks[1]!.type, 27, '中间应是图片块');
    assert.equal(blocks[2]!.text, '正文');
  });

  it('远程图排在本地图之前时，本地图不会被挂到错误的块上', async () => {
    // 这是最容易静默出错的一条：convert 会为远程图也生成 Image 块（token 为空）。
    // 若抽取图片引用时把远程图过滤掉，按位置配对就会整体前移一位 ——
    // 本地图会被上传到远程图那个块上，而且全程不报错。
    const { tmp, fake, run } = setup();
    fs.mkdirSync(path.join(tmp, 'docs/specs/assets'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/specs/assets/d.png'), 'local-bytes');
    writeDoc(
      tmp,
      'docs/specs/a.md',
      ['![远程](https://a.com/x.png)', '![本地](assets/d.png)'].join('\n'),
    );

    await run();

    const docId = fake.nodes[0]!.obj_token;
    const imageBlocks = fake.docs.get(docId)!.blocks.filter((b) => b.type === 27);
    assert.equal(imageBlocks.length, 2, '远程图与本地图各占一个块');

    assert.equal(fake.uploadedImages.length, 1, '只该上传本地那张');
    assert.equal(fake.uploadedImages[0]!.fileName, 'd.png');
    assert.equal(
      fake.uploadedImages[0]!.parentNode,
      imageBlocks[1]!.id,
      '必须挂到第二个图块（本地图那个），而不是第一个（远程图）',
    );
  });

  it('抽取到的图片数与 convert 产出的图片块数不一致时明确报错', async () => {
    // 宁可失败也不要静默把图片挂到错误的位置上
    const { tmp, fake, run } = setup();
    fs.mkdirSync(path.join(tmp, 'docs/specs/assets'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/specs/assets/d.png'), 'bytes');
    writeDoc(tmp, 'docs/specs/a.md', '![本地](assets/d.png)\n');

    fake.dropImageBlocksInConvert = true;
    const results = await run();

    assert.equal(results[0]!.action, 'failed');
    assert.match(results[0]!.message ?? '', /无法安全配对/);
  });

  it('图片内容变化时重新上传', async () => {
    const { tmp, fake, run } = setup();
    fs.mkdirSync(path.join(tmp, 'docs/specs/assets'), { recursive: true });
    const imgPath = path.join(tmp, 'docs/specs/assets/p.png');
    fs.writeFileSync(imgPath, 'v1');
    writeDoc(tmp, 'docs/specs/a.md', '![图](assets/p.png)\n');

    await run();
    fake.clearWrites();

    fs.writeFileSync(imgPath, 'v2');
    await run();

    assert.ok(fake.writes.includes('uploadImage'), '图片内容变了必须重新上传');
  });
});

describe('破坏性变更护栏 —— 防误删远端内容', () => {
  it('本地文件被清空时拦截，不再清空远端', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\nD\nE\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    writeDoc(tmp, 'docs/specs/a.md', '');
    const results = await run();

    assert.equal(results[0]!.action, 'failed', '被清空时必须失败，而不是静默清空远端');
    assert.match(results[0]!.message ?? '', /全部删除|破坏性/);
    assert.deepEqual(fake.blockTexts(docId), ['A', 'B', 'C', 'D', 'E'], '远端内容必须原样保留');
  });

  it('本地内容被截断大半时拦截', async () => {
    const { tmp, fake, run } = setup();
    const lines = Array.from({ length: 20 }, (_, i) => `第${i}行`);
    writeDoc(tmp, 'docs/specs/a.md', `${lines.join('\n')}\n`);
    await run();
    const docId = fake.nodes[0]!.obj_token;

    writeDoc(tmp, 'docs/specs/a.md', `${lines.slice(0, 3).join('\n')}\n`);
    const results = await run();

    assert.equal(results[0]!.action, 'failed');
    assert.equal(fake.blockTexts(docId).length, 20, '远端不该被删到只剩 3 块');
  });

  it('首次纳管别人手工维护的非空文档时拦截', async () => {
    // 最危险的一种：本地有个文件名恰好与同事的文档重名，
    // 第一次同步就会把同事写的内容整篇替换掉
    const { tmp, fake, run } = setup();
    const existing = await fake.wiki.createNode({
      spaceId: 's1',
      parentNodeToken: 'w-root',
      title: '01-domain',
    });
    fake.seedDocument(existing.obj_token, ['人工第1段', '人工第2段', '人工第3段', '人工第4段']);
    writeDoc(tmp, 'docs/specs/01-domain.md', '本地只有一行\n');

    const results = await run();

    assert.equal(results[0]!.action, 'failed');
    assert.match(results[0]!.message ?? '', /首次纳管/);
    assert.deepEqual(
      fake.blockTexts(existing.obj_token),
      ['人工第1段', '人工第2段', '人工第3段', '人工第4段'],
      '同事的内容必须原样保留',
    );
  });

  it('--allow-destructive 时才真正执行', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\nD\nE\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    writeDoc(tmp, 'docs/specs/a.md', '');
    const results = await run({ allowDestructive: true });

    assert.equal(results[0]!.action, 'updated');
    assert.deepEqual(fake.blockTexts(docId), []);
  });

  it('新建文档（远端本来就空）不算破坏性', async () => {
    const { tmp, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\n');

    const results = await run();

    assert.equal(results[0]!.action, 'created', '首次新建不该被护栏拦住');
  });

  it('正常的少量编辑不触发护栏', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\nD\nE\nF\nG\nH\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    // 删掉一行、改一行 —— 完全正常的编辑
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB-改了\nC\nD\nE\nF\nG\n');
    const results = await run();

    assert.equal(results[0]!.action, 'updated', `不该拦住正常编辑：${results[0]!.message ?? ''}`);
    assert.equal(fake.blockTexts(docId).length, 7);
  });

  it('dry-run 会预告破坏性变更，但不写入', async () => {
    const { tmp, fake, run } = setup();
    writeDoc(tmp, 'docs/specs/a.md', 'A\nB\nC\nD\nE\n');
    await run();
    const docId = fake.nodes[0]!.obj_token;

    writeDoc(tmp, 'docs/specs/a.md', '');
    fake.clearWrites();
    const results = await run({ dryRun: true });

    assert.equal(results[0]!.action, 'planned');
    assert.match(results[0]!.message ?? '', /破坏性/, 'dry-run 就要让人看见风险');
    assert.deepEqual(fake.writes, []);
    assert.equal(fake.blockTexts(docId).length, 5);
  });
});
