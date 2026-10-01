import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTree,
  blockStyleSignature,
  fingerprint,
  isUpdatableInPlace,
  normalizeText,
  stripMergeInfo,
  textOf,
  type FeishuBlock,
} from '../src/core/blocks.js';

function textBlock(id: string, content: string, style?: Record<string, unknown>): FeishuBlock {
  return {
    block_id: id,
    block_type: 2,
    text: {
      style: style ?? {},
      elements: [{ text_run: { content } }],
    },
  };
}

function boldBlock(id: string, content: string): FeishuBlock {
  return {
    block_id: id,
    block_type: 2,
    text: { elements: [{ text_run: { content, text_element_style: { bold: true } } }] },
  };
}

function makeIndex(blocks: FeishuBlock[]): Map<string, FeishuBlock> {
  return new Map(blocks.map((b) => [b.block_id, b]));
}

describe('textOf', () => {
  it('拼接多个 text_run', () => {
    const block: FeishuBlock = {
      block_id: 'b',
      block_type: 2,
      text: {
        elements: [
          { text_run: { content: 'Hello ' } },
          { text_run: { content: 'World' } },
        ],
      },
    };
    assert.equal(textOf(block), 'Hello World');
  });

  it('公式与 @提及 也有稳定表示', () => {
    const block: FeishuBlock = {
      block_id: 'b',
      block_type: 2,
      text: { elements: [{ equation: { content: 'E=mc^2' } }, { mention_user: { user_id: 'u1' } }] },
    };
    assert.equal(textOf(block), 'E=mc^2@u1');
  });

  it('非文本块返回空串而不是抛错', () => {
    assert.equal(textOf({ block_id: 'd', block_type: 22 }), '');
    assert.equal(textOf({ block_id: 'x', block_type: 9999 }), '');
  });
});

describe('normalizeText', () => {
  it('普通文本折叠空白', () => {
    assert.equal(normalizeText('  a   b \n c  ', 2), 'a b c');
  });

  it('代码块保留空白 —— 折叠会让两个不同代码片段判为相同', () => {
    const code = 'def f():\n    return 1\n\n\ndef g():\n    return 2';
    assert.equal(normalizeText(code, 14), code);
  });

  it('代码块去掉行尾空格但不改变缩进结构', () => {
    assert.equal(normalizeText('a  \n  b\t\n', 14), 'a\n  b');
  });
});

describe('blockStyleSignature', () => {
  it('代码语言进签名 —— 否则改语言会被判为无变化', () => {
    const py: FeishuBlock = { block_id: 'c', block_type: 14, code: { style: { language: 49 } } };
    const js: FeishuBlock = { block_id: 'c', block_type: 14, code: { style: { language: 30 } } };
    assert.notEqual(blockStyleSignature(py), blockStyleSignature(js));
  });

  it('无样式时为空串', () => {
    assert.equal(blockStyleSignature({ block_id: 't', block_type: 2, text: {} }), '');
  });
});

describe('fingerprint', () => {
  it('相同内容指纹相同', () => {
    const a = makeIndex([textBlock('a', 'hello')]);
    const b = makeIndex([textBlock('b', 'hello')]);
    assert.equal(fingerprint(a.get('a')!, a), fingerprint(b.get('b')!, b));
  });

  it('空白差异不影响指纹（归一化生效）', () => {
    const a = makeIndex([textBlock('a', 'hello  world')]);
    const b = makeIndex([textBlock('b', 'hello world')]);
    assert.equal(fingerprint(a.get('a')!, a), fingerprint(b.get('b')!, b));
  });

  it('文本变化改变指纹', () => {
    const a = makeIndex([textBlock('a', 'hello')]);
    const b = makeIndex([textBlock('b', 'hello!')]);
    assert.notEqual(fingerprint(a.get('a')!, a), fingerprint(b.get('b')!, b));
  });

  it('仅加粗也要改变指纹 —— 否则样式变更会被静默漏掉', () => {
    const plain = makeIndex([textBlock('a', 'hello')]);
    const bold = makeIndex([boldBlock('b', 'hello')]);
    assert.notEqual(fingerprint(plain.get('a')!, plain), fingerprint(bold.get('b')!, bold));
  });

  it('容器块的指纹包含子块内容', () => {
    const mk = (childText: string) => {
      const blocks: FeishuBlock[] = [
        { block_id: 'table', block_type: 31, children: ['cell'] },
        { block_id: 'cell', block_type: 32, parent_id: 'table', children: ['p'] },
        { block_id: 'p', block_type: 2, parent_id: 'cell', text: { elements: [{ text_run: { content: childText } }] } },
      ];
      const idx = makeIndex(blocks);
      return fingerprint(idx.get('table')!, idx);
    };
    assert.notEqual(mk('A'), mk('B'));
  });

  it('图片按来源路径做指纹，而不是 token', () => {
    // 本地 convert 出来的 Image 块 token 为空，远端有 token。
    // 用 token 做指纹会导致每张图都被判成「删+增」。
    const img = (id: string): FeishuBlock => ({ block_id: id, block_type: 27, image: {} });
    const idx = makeIndex([img('x')]);

    const withSrc = fingerprint(idx.get('x')!, idx, {
      imageSource: () => 'assets/a.png#hash1',
    });
    const withOther = fingerprint(idx.get('x')!, idx, {
      imageSource: () => 'assets/b.png#hash1',
    });
    assert.notEqual(withSrc, withOther);
  });

  it('同一路径但内容哈希变化时指纹也变 —— 重导出的同名图片必须能同步', () => {
    const idx = makeIndex([{ block_id: 'x', block_type: 27, image: {} }]);
    const a = fingerprint(idx.get('x')!, idx, { imageSource: () => 'a.png#hash1' });
    const b = fingerprint(idx.get('x')!, idx, { imageSource: () => 'a.png#hash2' });
    assert.notEqual(a, b);
  });
});

describe('buildTree', () => {
  it('以 page 块的 children 作为顶层顺序', () => {
    const blocks: FeishuBlock[] = [
      { block_id: 'doc1', block_type: 1, children: ['b1', 'b2'] },
      textBlock('b1', 'one'),
      textBlock('b2', 'two'),
    ];
    const tree = buildTree(blocks, 'doc1');
    assert.deepEqual(tree.topLevel, ['b1', 'b2']);
    assert.equal(fingerprint(tree.byId.get('b1')!, tree.byId).length, 32);
  });

  it('children 缺失时按 parent_id 兜底', () => {
    const blocks: FeishuBlock[] = [
      { block_id: 'doc1', block_type: 1 },
      { ...textBlock('b1', 'one'), parent_id: 'doc1' },
      { ...textBlock('b2', 'two'), parent_id: 'doc1' },
    ];
    const tree = buildTree(blocks, 'doc1');
    assert.deepEqual(tree.topLevel, ['b1', 'b2']);
  });
});

describe('stripMergeInfo', () => {
  it('剥掉表格的 merge_info —— 它是只读字段，原样传回会报错', () => {
    const input = [
      {
        block_id: 't',
        block_type: 31,
        table: {
          property: { row_size: 2, column_size: 2, merge_info: [{ row_span: 1 }] },
        },
      },
    ];
    const out = stripMergeInfo(input) as Array<Record<string, any>>;
    const property = out[0]!.table.property;
    assert.equal('merge_info' in property, false);
    assert.equal(property.row_size, 2, '其他属性必须保留');
  });

  it('不改动没有表格的块', () => {
    const input = [textBlock('b', 'x')];
    const out = stripMergeInfo(input) as Array<Record<string, any>>;
    assert.deepEqual(out[0]!.text, input[0]!.text);
  });

  it('不修改原对象（避免污染调用方数据）', () => {
    const original = {
      block_id: 't',
      block_type: 31,
      table: { property: { merge_info: ['x'] } },
    };
    stripMergeInfo([original]);
    assert.ok(Array.isArray((original.table.property as { merge_info?: unknown }).merge_info));
  });
});

describe('isUpdatableInPlace', () => {
  it('文本类块可原地更新', () => {
    assert.equal(isUpdatableInPlace(textBlock('b', 'x')), true);
    assert.equal(isUpdatableInPlace({ block_id: 'h', block_type: 3, heading1: {} }), true);
    assert.equal(isUpdatableInPlace({ block_id: 'c', block_type: 14, code: {} }), true);
  });

  it('容器块不可原地更新', () => {
    assert.equal(isUpdatableInPlace({ block_id: 't', block_type: 31, table: {} }), false);
    assert.equal(isUpdatableInPlace({ block_id: 'c', block_type: 19, callout: {} }), false);
  });

  it('page 块不参与', () => {
    assert.equal(isUpdatableInPlace({ block_id: 'p', block_type: 1, page: {} }), false);
  });

  it('undefined 安全', () => {
    assert.equal(isUpdatableInPlace(undefined), false);
  });
});
