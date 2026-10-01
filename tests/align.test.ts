import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { align, isNoop, lcsPairs, segmentsInWriteOrder, type AlignItem } from '../src/core/align.js';

/** 构造对齐项。`t` 是 block_type，`fp` 是内容指纹。 */
function item(id: string, fp: string, opts: { t?: number; style?: string; updatable?: boolean } = {}): AlignItem {
  return {
    id,
    type: opts.t ?? 2,
    fp,
    styleSig: opts.style ?? '',
    updatable: opts.updatable ?? true,
  };
}

describe('lcsPairs', () => {
  it('完全相同时全部配对', () => {
    assert.deepEqual(lcsPairs(['a', 'b', 'c'], ['a', 'b', 'c']), [
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('完全不相同时无配对', () => {
    assert.deepEqual(lcsPairs(['a', 'b'], ['x', 'y']), []);
  });

  it('识别中间插入', () => {
    assert.deepEqual(lcsPairs(['a', 'b', 'c'], ['a', 'x', 'b', 'c']), [
      [0, 0],
      [1, 2],
      [2, 3],
    ]);
  });

  it('识别中间删除', () => {
    assert.deepEqual(lcsPairs(['a', 'x', 'b'], ['a', 'b']), [
      [0, 0],
      [2, 1],
    ]);
  });

  it('处理重复指纹时不重复配对', () => {
    // 两个相同的指纹，两边各一个 —— 只能配一对，不能把同一个远端块配两次
    const pairs = lcsPairs(['dup', 'dup'], ['dup']);
    assert.equal(pairs.length, 1);
  });

  it('保持索引单调递增', () => {
    const pairs = lcsPairs(['a', 'b', 'c', 'd'], ['b', 'a', 'd', 'c']);
    for (let i = 1; i < pairs.length; i++) {
      assert.ok(pairs[i]![0] > pairs[i - 1]![0], '远端索引必须递增');
      assert.ok(pairs[i]![1] > pairs[i - 1]![1], '本地索引必须递增');
    }
  });

  it('大规模输入不退化（Hunt–Szymanski 的意义）', () => {
    const n = 5000;
    const a = Array.from({ length: n }, (_, i) => `fp${i}`);
    const b = [...a.slice(0, 100), 'NEW', ...a.slice(100)];
    const started = Date.now();
    const pairs = lcsPairs(a, b);
    const elapsed = Date.now() - started;
    assert.equal(pairs.length, n);
    assert.ok(elapsed < 5000, `5000 元素耗时 ${elapsed}ms，不该这么慢`);
  });
});

describe('align', () => {
  it('两侧完全一致时全为 keep，且无变化段', () => {
    const remote = [item('r0', 'A'), item('r1', 'B')];
    const local = [item('l0', 'A'), item('l1', 'B')];
    const r = align(remote, local);

    assert.equal(r.stats.keep, 2);
    assert.equal(r.stats.update, 0);
    assert.equal(r.segments.length, 0);
    assert.ok(isNoop(r));
  });

  it('单块文本修改配对为 update —— 这是保留评论的关键路径', () => {
    const remote = [item('r0', 'A'), item('r1', 'B'), item('r2', 'C')];
    const local = [item('l0', 'A'), item('l1', 'B-changed'), item('l2', 'C')];
    const r = align(remote, local);

    assert.equal(r.stats.keep, 2);
    assert.equal(r.stats.update, 1);
    assert.equal(r.stats.insert, 0);
    assert.equal(r.stats.remove, 0);
    // update 不进变化段：它不动索引，也不该触发删除
    assert.equal(r.segments.length, 0);
    assert.ok(!isNoop(r));

    const upd = r.ops.find((o) => o.kind === 'update');
    assert.ok(upd && upd.kind === 'update');
    assert.equal(upd.r, 1, 'update 应指向远端中间那块（block_id 将被保留）');
  });

  it('块级样式不同时不得配对为 update', () => {
    // update_text_elements 改不了代码块语言，配对成功也是静默失败。
    // 真实场景里样式参与指纹计算，所以样式不同必然指纹也不同 ——
    // 于是 LCS 不会匹配，落到「等长同型」的候选判断上。
    const remote = [item('r0', 'code-a', { t: 14, style: 'lang49' })];
    const local = [item('l0', 'code-b', { t: 14, style: 'lang30' })];
    const r = align(remote, local);

    assert.equal(r.stats.update, 0);
    assert.equal(r.stats.remove, 1);
    assert.equal(r.stats.insert, 1);
  });

  it('容器块（不可原地更新）走删+插', () => {
    const remote = [item('r0', 'table-a', { t: 31, updatable: false })];
    const local = [item('l0', 'table-b', { t: 31, updatable: false })];
    const r = align(remote, local);

    assert.equal(r.stats.update, 0);
    assert.equal(r.segments.length, 1);
  });

  it('中间插入产生一个变化段，两侧保留块不参与', () => {
    const remote = [item('r0', 'A'), item('r1', 'C')];
    const local = [item('l0', 'A'), item('l1', 'B'), item('l2', 'C')];
    const r = align(remote, local);

    assert.equal(r.stats.keep, 2);
    assert.equal(r.stats.insert, 1);
    assert.equal(r.stats.remove, 0);
    assert.deepEqual(r.segments, [{ rStart: 1, rEnd: 1, lStart: 1, lEnd: 2 }]);
  });

  it('中间删除只删不插', () => {
    const remote = [item('r0', 'A'), item('r1', 'B'), item('r2', 'C')];
    const local = [item('l0', 'A'), item('l1', 'C')];
    const r = align(remote, local);

    assert.equal(r.stats.remove, 1);
    assert.equal(r.stats.insert, 0);
    assert.deepEqual(r.segments, [{ rStart: 1, rEnd: 2, lStart: 1, lEnd: 1 }]);
  });

  it('文首插入 + 文末删除 + 中间修改，产出三个可独立处理的区域', () => {
    const remote = [item('r0', 'A'), item('r1', 'B'), item('r2', 'C'), item('r3', 'D')];
    const local = [
      item('l0', 'NEW'),
      item('l1', 'A'),
      item('l2', 'B-changed'),
      item('l3', 'C'),
    ];
    const r = align(remote, local);

    assert.equal(r.stats.keep, 2, 'A 与 C 应保留');
    assert.equal(r.stats.update, 1, 'B 应原地更新');
    assert.equal(r.stats.insert, 1, '文首新增一块');
    assert.equal(r.stats.remove, 1, '文末删除 D');

    // 文首插入是变化段；中间修改不进段；文末删除是变化段
    assert.deepEqual(r.segments, [
      { rStart: 0, rEnd: 0, lStart: 0, lEnd: 1 },
      { rStart: 3, rEnd: 4, lStart: 4, lEnd: 4 },
    ]);
  });

  it('空文档到有内容', () => {
    const r = align([], [item('l0', 'A'), item('l1', 'B')]);
    assert.equal(r.stats.insert, 2);
    assert.deepEqual(r.segments, [{ rStart: 0, rEnd: 0, lStart: 0, lEnd: 2 }]);
  });

  it('有内容到空文档', () => {
    const r = align([item('r0', 'A'), item('r1', 'B')], []);
    assert.equal(r.stats.remove, 2);
    assert.deepEqual(r.segments, [{ rStart: 0, rEnd: 2, lStart: 0, lEnd: 0 }]);
  });
});

describe('不变量：stats.remove 必须等于所有变化段的范围之和', () => {
  // 破坏性护栏是拿 stats.remove 判断的。若它与真正要删的块数对不上，
  // 护栏会「看着过了」而删除照常发生 —— 这条不变量必须成立。
  const cases: Array<[string, AlignItem[], AlignItem[]]> = [
    ['完全一致', [item('r0', 'A')], [item('l0', 'A')]],
    ['整段重写', [item('r0', 'A'), item('r1', 'B')], [item('l0', 'X'), item('l1', 'Y')]],
    ['清空', [item('r0', 'A'), item('r1', 'B'), item('r2', 'C')], []],
    ['从空到有', [], [item('l0', 'A')]],
    ['首中尾混合', [item('r0', 'A'), item('r1', 'B'), item('r2', 'C'), item('r3', 'D')], [item('l0', 'NEW'), item('l1', 'A'), item('l2', 'B-改'), item('l3', 'C')]],
    ['多处不连续删除', [item('r0', 'A'), item('r1', 'B'), item('r2', 'C'), item('r3', 'D'), item('r4', 'E')], [item('l0', 'A'), item('l1', 'E')]],
    ['只有一个块被替换', [item('r0', 'A')], [item('l0', 'B')]],
  ];

  for (const [name, remote, local] of cases) {
    it(name, () => {
      const r = align(remote, local);
      const fromSegments = r.segments.reduce((n, s) => n + (s.rEnd - s.rStart), 0);
      assert.equal(fromSegments, r.stats.remove);
    });
  }
});

describe('segmentsInWriteOrder', () => {
  it('按远端起始索引倒序 —— 顺序错了索引会静默错位', () => {
    const segments = [
      { rStart: 0, rEnd: 1, lStart: 0, lEnd: 1 },
      { rStart: 10, rEnd: 11, lStart: 9, lEnd: 10 },
      { rStart: 5, rEnd: 6, lStart: 5, lEnd: 6 },
    ];
    const ordered = segmentsInWriteOrder(segments);
    assert.deepEqual(
      ordered.map((s) => s.rStart),
      [10, 5, 0],
    );
  });

  it('不修改原数组', () => {
    const segments = [
      { rStart: 1, rEnd: 2, lStart: 1, lEnd: 2 },
      { rStart: 5, rEnd: 6, lStart: 5, lEnd: 6 },
    ];
    const before = JSON.stringify(segments);
    segmentsInWriteOrder(segments);
    assert.equal(JSON.stringify(segments), before);
  });
});
