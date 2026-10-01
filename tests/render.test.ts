import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTree, type FeishuBlock } from '../src/core/blocks.js';
import { renderBlocks } from '../src/core/render.js';

const ROOT = 'doc1';

/** 用扁平块数组造树：第一个是 page 块，其余按 parent_id 挂上去。 */
function tree(children: FeishuBlock[]): ReturnType<typeof buildTree> {
  const page: FeishuBlock = {
    block_id: ROOT,
    block_type: 1,
    children: children.map((c) => c.block_id),
  };
  return buildTree([page, ...children.map((c) => ({ parent_id: ROOT, ...c }))], ROOT);
}

function text(id: string, content: string, style: Record<string, unknown> = {}): FeishuBlock {
  return {
    block_id: id,
    block_type: 2,
    text: { style, elements: [{ text_run: { content } }] },
  };
}

function styled(id: string, content: string, elementStyle: Record<string, unknown>): FeishuBlock {
  return {
    block_id: id,
    block_type: 2,
    text: { elements: [{ text_run: { content, text_element_style: elementStyle } }] },
  };
}

function heading(id: string, level: number, content: string): FeishuBlock {
  return {
    block_id: id,
    block_type: 2 + level,
    [`heading${level}`]: { elements: [{ text_run: { content } }] },
  };
}

function render(children: FeishuBlock[], options = {}): string {
  return renderBlocks(tree(children), options).markdown;
}

describe('块 → Markdown：基础块型', () => {
  it('段落', () => {
    assert.equal(render([text('a', '一段话')]), '一段话\n');
  });

  it('标题 1~9 级', () => {
    for (let level = 1; level <= 9; level++) {
      assert.equal(render([heading('h', level, '标题')]), `${'#'.repeat(level)} 标题\n`);
    }
  });

  it('无序列表', () => {
    const block: FeishuBlock = {
      block_id: 'b',
      block_type: 12,
      bullet: { elements: [{ text_run: { content: '条目' } }] },
    };
    assert.equal(render([block]), '- 条目\n');
  });

  it('有序列表', () => {
    const block: FeishuBlock = {
      block_id: 'b',
      block_type: 13,
      ordered: { elements: [{ text_run: { content: '条目' } }] },
    };
    assert.equal(render([block]), '1. 条目\n');
  });

  it('缩进层级转成两个空格', () => {
    const block: FeishuBlock = {
      block_id: 'b',
      block_type: 12,
      bullet: { style: { indentation_level: 2 }, elements: [{ text_run: { content: '子项' } }] },
    };
    assert.equal(render([block]), '    - 子项\n');
  });

  it('待办的两种状态', () => {
    const mk = (done: boolean): FeishuBlock => ({
      block_id: 't',
      block_type: 17,
      todo: { style: { done }, elements: [{ text_run: { content: '待办' } }] },
    });
    assert.equal(render([mk(false)]), '- [ ] 待办\n');
    assert.equal(render([mk(true)]), '- [x] 待办\n');
  });

  it('引用逐行加前缀', () => {
    const block: FeishuBlock = {
      block_id: 'q',
      block_type: 15,
      quote: { elements: [{ text_run: { content: '第一行' } }] },
    };
    assert.equal(render([block]), '> 第一行\n');
  });

  it('分割线', () => {
    assert.equal(render([{ block_id: 'd', block_type: 22, divider: {} }]), '---\n');
  });

  it('代码块', () => {
    const block: FeishuBlock = {
      block_id: 'c',
      block_type: 14,
      code: { style: { language: 49 }, elements: [{ text_run: { content: 'print(1)' } }] },
    };
    assert.equal(render([block]), '```python\nprint(1)\n```\n');
  });

  it('未知语言枚举留空围栏，而不是猜一个语言名', () => {
    // 猜错语言会让下次同步把语言改掉 —— 留空是安全的
    const block: FeishuBlock = {
      block_id: 'c',
      block_type: 14,
      code: { style: { language: 999 }, elements: [{ text_run: { content: 'x' } }] },
    };
    assert.equal(render([block]), '```\nx\n```\n');
  });
});

describe('块 → Markdown：行内样式', () => {
  it('粗体 / 斜体 / 删除线', () => {
    assert.equal(render([styled('a', 'x', { bold: true })]), '**x**\n');
    assert.equal(render([styled('a', 'x', { italic: true })]), '*x*\n');
    assert.equal(render([styled('a', 'x', { strikethrough: true })]), '~~x~~\n');
  });

  it('行内代码不转义、不加其余样式标记', () => {
    assert.equal(render([styled('a', 'a*b', { inline_code: true })]), '`a*b`\n');
  });

  it('链接', () => {
    assert.equal(
      render([styled('a', '点这里', { link: { url: 'https://x.com' } })]),
      '[点这里](https://x.com)\n',
    );
  });

  it('链接与粗体叠加时先后有序', () => {
    assert.equal(
      render([styled('a', 'x', { bold: true, link: { url: 'https://x.com' } })]),
      '[**x**](https://x.com)\n',
    );
  });

  it('公式', () => {
    const block: FeishuBlock = {
      block_id: 'e',
      block_type: 2,
      text: { elements: [{ equation: { content: 'E=mc^2' } }] },
    };
    assert.equal(render([block]), '$E=mc^2$\n');
  });

  it('转义会改变语义的字符', () => {
    assert.equal(render([text('a', '2*3*4')]), '2\\*3\\*4\n');
  });

  it('不转义普通字符 —— 多转会在往返时造出假差异', () => {
    assert.equal(render([text('a', 'a.b, c! d?')]), 'a.b, c! d?\n');
  });
});

describe('块 → Markdown：表格与图片', () => {
  function table(): FeishuBlock[] {
    return [
      { block_id: 'tb', block_type: 31, children: ['r1', 'r2'] },
      { block_id: 'r1', block_type: 32, children: ['c11', 'c12'] },
      { block_id: 'c11', block_type: 32, children: ['p11'] },
      { block_id: 'p11', block_type: 2, text: { elements: [{ text_run: { content: '列 A' } }] } },
      { block_id: 'c12', block_type: 32, children: ['p12'] },
      { block_id: 'p12', block_type: 2, text: { elements: [{ text_run: { content: '列 B' } }] } },
      { block_id: 'r2', block_type: 32, children: ['c21', 'c22'] },
      { block_id: 'c21', block_type: 32, children: ['p21'] },
      { block_id: 'p21', block_type: 2, text: { elements: [{ text_run: { content: '1' } }] } },
      { block_id: 'c22', block_type: 32, children: ['p22'] },
      { block_id: 'p22', block_type: 2, text: { elements: [{ text_run: { content: '2' } }] } },
    ];
  }

  it('表格渲染成管道表格', () => {
    const page: FeishuBlock = { block_id: ROOT, block_type: 1, children: ['tb'] };
    const md = renderBlocks(buildTree([page, ...table()], ROOT)).markdown;
    assert.equal(md, '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n');
  });

  it('单元格里的竖线被转义，不会撑破表格', () => {
    const cells = table().map((b) =>
      b.block_id === 'p11'
        ? { ...b, text: { elements: [{ text_run: { content: 'a|b' } }] } }
        : b,
    );
    const page: FeishuBlock = { block_id: ROOT, block_type: 1, children: ['tb'] };
    const md = renderBlocks(buildTree([page, ...cells], ROOT)).markdown;
    assert.match(md, /a\\\|b/);
  });

  it('图片渲染成稳定的占位形式，并单独报告', () => {
    const img: FeishuBlock = {
      block_id: 'img1',
      block_type: 27,
      image: { token: 'TOK123', caption: { content: '架构图' } },
    };
    const result = renderBlocks(tree([img]));

    assert.equal(result.markdown, '![架构图](feishu-media:TOK123)\n');
    assert.deepEqual(result.images, [{ blockId: 'img1', token: 'TOK123' }]);
  });

  it('没有 token 的图片块也不崩', () => {
    const img: FeishuBlock = { block_id: 'i', block_type: 27, image: {} };
    assert.equal(renderBlocks(tree([img])).markdown, '![](feishu-media:)\n');
  });
});

describe('块 → Markdown：表达不了的块', () => {
  it('高亮块标记为占位，但递归渲染子块让内容不丢', () => {
    const blocks: FeishuBlock[] = [
      { block_id: 'callout', block_type: 19, children: ['inner'] },
      text('inner', '高亮块里的内容'),
    ];
    const page: FeishuBlock = { block_id: ROOT, block_type: 1, children: ['callout'] };
    const result = renderBlocks(buildTree([page, ...blocks], ROOT));

    assert.match(result.markdown, /<!-- fws-unsupported:19 -->/);
    assert.match(result.markdown, /高亮块里的内容/, '内容必须保留');
    assert.deepEqual(result.unsupported, [{ blockId: 'callout', type: 19, name: '高亮块' }]);
  });

  it('空的高亮块只留占位', () => {
    const blocks: FeishuBlock[] = [{ block_id: 'callout', block_type: 19 }];
    const page: FeishuBlock = { block_id: ROOT, block_type: 1, children: ['callout'] };
    const result = renderBlocks(buildTree([page, ...blocks], ROOT));
    assert.equal(result.markdown, '<!-- fws-unsupported:19 -->\n');
  });

  it('画板等也不崩，且不产生子块递归问题', () => {
    const blocks: FeishuBlock[] = [{ block_id: 'board', block_type: 43 }];
    const page: FeishuBlock = { block_id: ROOT, block_type: 1, children: ['board'] };
    const result = renderBlocks(buildTree([page, ...blocks], ROOT));
    assert.equal(result.unsupported.length, 1);
    assert.equal(result.unsupported[0]!.name, 'board');
  });
});

describe('块 → Markdown：结构与选项', () => {
  it('块之间用空行分隔', () => {
    assert.equal(render([text('a', '一'), text('b', '二')]), '一\n\n二\n');
  });

  it('withBlockIds 在每块前插入注释锚点', () => {
    const md = render([text('blk1', '内容')], { withBlockIds: true });
    assert.match(md, /<!-- block:blk1 -->/);
  });

  it('空文档输出只有换行，不崩', () => {
    assert.equal(renderBlocks(tree([])).markdown, '\n');
  });

  it('输出总是以单个换行结尾', () => {
    assert.ok(render([text('a', 'x')]).endsWith('\n'));
  });
});
