/**
 * 块序列对齐：把「远端已有的顶层块」与「本地 Markdown 转出的新块」配对，
 * 产出最小变更集。
 *
 * ## 为什么对齐只能靠指纹
 *
 * `convert` 吃 Markdown、吐临时 ID；本地 md 无法携带远端 `block_id`。
 * 所以「本地第 N 个块 = 远端哪个块」只能靠内容指纹推断。
 *
 * ## 三级策略的实际实现（见 §gap 处理）
 *
 * 规格里写了三级（精确匹配 / 结构配对 / 相似度兜底）。实现时发现
 * **第三级是多余的**：LCS 已处理插入、删除、移动；剩下长度相等且类型逐个
 * 相同的空隙，正是「内容被编辑」的情形，结构配对直接命中。
 * 长度不等的空隙是真正的结构变化，做相似度贪心配对会带来**顺序错乱风险**
 * （配对结果可能非单调，导致远端块顺序与本地不一致），得不偿失。
 *
 * 因此实现为两级：**LCS 精确匹配** + **等长同型的整体 update**。
 * 这是有意的取舍：牺牲极少数场景的评论保留，换取顺序绝对正确。
 */

export interface AlignItem {
  /** 远端为 block_id；本地为临时占位（写入时才生成）。 */
  id: string;
  /** block_type */
  type: number;
  /** 内容指纹 */
  fp: string;
  /** 块级样式签名。仅当两侧相等才能走 UPDATE，见 blocks.ts 的说明。 */
  styleSig: string;
  /** 能否用 batch_update 原地更新（保住 block_id 与评论） */
  updatable: boolean;
}

export type AlignOp =
  | { kind: 'keep'; r: number; l: number }
  | { kind: 'update'; r: number; l: number }
  | { kind: 'delete'; r: number }
  | { kind: 'insert'; l: number };

/**
 * 一个「变化段」：远端待删区间 + 本地待插区间。
 *
 * `rStart/rEnd` 是**原始远端索引**。倒序处理各段时，段之前的索引未被改动，
 * 因此这些索引始终有效 —— 这是写入顺序算法成立的前提。
 */
export interface ChangeSegment {
  rStart: number;
  rEnd: number;
  lStart: number;
  lEnd: number;
}

export interface AlignResult {
  ops: AlignOp[];
  segments: ChangeSegment[];
  stats: {
    keep: number;
    update: number;
    insert: number;
    remove: number;
  };
}

/**
 * 最长公共子序列（Hunt–Szymanski）。
 *
 * 不用教科书上的 O(n·m) DP 表：一篇文档的顶层块数可达几千，
 * DP 表的内存与时间都不可接受。Hunt–Szymanski 借助「指纹 → 位置」索引
 * 把复杂度降到与实际匹配数相关，在「大部分块没变」的常见情形下接近线性。
 *
 * 返回按两侧索引单调递增的匹配对。
 */
export function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const positions = new Map<string, number[]>();
  for (let i = 0; i < a.length; i++) {
    const list = positions.get(a[i]);
    if (list) list.push(i);
    else positions.set(a[i], [i]);
  }

  // 候选对：按 b 升序排列；同一 b 命中的多个 a 用降序，保证 LIS 严格递增时
  // 同一 b 至多被选中一次。
  const pairA: number[] = [];
  const pairB: number[] = [];
  for (let j = 0; j < b.length; j++) {
    const list = positions.get(b[j]);
    if (!list) continue;
    for (let k = list.length - 1; k >= 0; k--) {
      pairA.push(list[k]);
      pairB.push(j);
    }
  }

  const n = pairA.length;
  if (n === 0) return [];

  // 耐心排序求 LIS（对 pairA 严格递增）
  const tails: number[] = [];
  const parent = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const v = pairA[i];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairA[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) parent[i] = tails[lo - 1];
    tails[lo] = i;
  }

  const out: Array<[number, number]> = [];
  let cur = tails[tails.length - 1];
  while (cur >= 0) {
    out.push([pairA[cur], pairB[cur]]);
    cur = parent[cur];
  }
  out.reverse();
  return out;
}

/**
 * 对齐两个顶层块序列。
 *
 * 产出顺序与文档顺序一致，`segments` 按**正序**给出 —— 倒序处理由调用方
 * （plan 阶段）负责，因为倒序是写入策略而非对齐语义。
 */
export function align(remote: readonly AlignItem[], local: readonly AlignItem[]): AlignResult {
  const matched = lcsPairs(
    remote.map((r) => r.fp),
    local.map((l) => l.fp),
  );

  const ops: AlignOp[] = [];
  const segments: ChangeSegment[] = [];
  let keep = 0;
  let update = 0;
  let insert = 0;
  let remove = 0;

  const handleGap = (rStart: number, rEnd: number, lStart: number, lEnd: number): void => {
    const rLen = rEnd - rStart;
    const lLen = lEnd - lStart;
    if (rLen === 0 && lLen === 0) return;

    // 等长 + 类型逐个相同 + 都可原地更新 → 全部转为 UPDATE。
    // 顺序天然保持（逐个对应），且 block_id 不变，评论得以保留。
    if (rLen === lLen && rLen > 0) {
      let pairable = true;
      for (let k = 0; k < rLen; k++) {
        const r = remote[rStart + k];
        const l = local[lStart + k];
        // styleSig 必须相同：update_text_elements 改不了块级样式，
        // 配对成功也会「同步报成功但远端没变」。
        if (
          !r ||
          !l ||
          r.type !== l.type ||
          r.styleSig !== l.styleSig ||
          !r.updatable ||
          !l.updatable
        ) {
          pairable = false;
          break;
        }
      }
      if (pairable) {
        for (let k = 0; k < rLen; k++) {
          ops.push({ kind: 'update', r: rStart + k, l: lStart + k });
          update++;
        }
        return;
      }
    }

    // 否则整段替换。不做部分配对 —— 部分配对会让远端块顺序与本地不一致。
    for (let r = rStart; r < rEnd; r++) {
      ops.push({ kind: 'delete', r });
      remove++;
    }
    for (let l = lStart; l < lEnd; l++) {
      ops.push({ kind: 'insert', l });
      insert++;
    }
    segments.push({ rStart, rEnd, lStart, lEnd });
  };

  let rPrev = 0;
  let lPrev = 0;
  for (const [r, l] of matched) {
    handleGap(rPrev, r, lPrev, l);
    ops.push({ kind: 'keep', r, l });
    keep++;
    rPrev = r + 1;
    lPrev = l + 1;
  }
  handleGap(rPrev, remote.length, lPrev, local.length);

  return { ops, segments, stats: { keep, update, insert, remove } };
}

/**
 * 判断这次对齐是否「无实际变化」。
 *
 * `update` 也是变化（虽然保住 block_id），所以不能只看 segments。
 */
export function isNoop(result: AlignResult): boolean {
  return result.stats.update === 0 && result.stats.insert === 0 && result.stats.remove === 0;
}

/**
 * 把变化段按**从后往前**排序。
 *
 * 写入顺序是这套算法里最容易做错的地方：`batch_delete` 用索引范围、
 * `descendant` 用插入位置，两者都会挪动后续块。
 * 先处理靠后的段，靠前段的索引才不会被破坏。
 */
export function segmentsInWriteOrder(segments: readonly ChangeSegment[]): ChangeSegment[] {
  return [...segments].sort((x, y) => y.rStart - x.rStart);
}
