import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertNoOverlap,
  deriveTitle,
  findOverlappingFiles,
  extractImageRefs,
  parseFrontMatter,
  scanMapping,
} from '../src/core/scanner.js';
import { ConfigError } from '../src/errors.js';
import type { Mapping } from '../src/core/config.js';

describe('parseFrontMatter', () => {
  it('解析顶层键值', () => {
    const fm = parseFrontMatter('---\ntitle: 领域模型\ntags: a\n---\n# Heading\n');
    assert.equal(fm.title, '领域模型');
  });

  it('去掉成对引号', () => {
    assert.equal(parseFrontMatter('---\ntitle: "带 空格"\n---\n').title, '带 空格');
  });

  it('没有 front-matter 时返回空对象而不抛错', () => {
    assert.deepEqual(parseFrontMatter('# 标题\n正文'), {});
  });

  it('未闭合的 front-matter 视为没有', () => {
    assert.deepEqual(parseFrontMatter('---\ntitle: x\n正文'), {});
  });
});

describe('deriveTitle', () => {
  it('front-matter 优先', () => {
    assert.equal(deriveTitle('---\ntitle: 显式标题\n---\n# 一级标题\n', 'a/b.md'), '显式标题');
  });

  it('其次取第一个一级标题', () => {
    assert.equal(deriveTitle('正文\n# 一级标题\n## 二级\n', 'a/b.md'), '一级标题');
  });

  it('最后回退到文件名', () => {
    assert.equal(deriveTitle('只有正文，没有标题', 'docs/specs/01-domain.md'), '01-domain');
  });

  it('一级标题必须在行首，正文里的 # 不算', () => {
    assert.equal(deriveTitle('正文里提到 # 号但不是标题', 'a/x.md'), 'x');
  });
});

describe('extractImageRefs', () => {
  it('抽取行内图片的目标串', () => {
    assert.deepEqual(extractImageRefs('![图](../assets/a.png)'), ['../assets/a.png']);
  });

  it('远程 URL 必须保留 —— 过滤掉会让后面所有图片错位', () => {
    // convert 会为远程图片也生成 Image 块（只是 token 为空）。
    // 抽取时若把它滤掉，按位置配对时后面的本地图就会被挂到它的块上。
    assert.deepEqual(extractImageRefs('![x](https://a.com/b.png)'), ['https://a.com/b.png']);
    assert.deepEqual(extractImageRefs('![x](data:image/png;base64,AAA)'), [
      'data:image/png;base64,AAA',
    ]);
  });

  it('保留原始串不做解析 —— 解析留给 resolveImages', () => {
    assert.deepEqual(extractImageRefs('![x](./a.png#frag)'), ['./a.png#frag']);
    assert.deepEqual(extractImageRefs('![x](a%20b.png)'), ['a%20b.png']);
  });

  it('严格保持出现顺序', () => {
    const md = '![1](a.png)\n![2](b.png)\n![3](c.png)';
    assert.deepEqual(extractImageRefs(md), ['a.png', 'b.png', 'c.png']);
  });

  it('跳过围栏代码块里的图片语法 —— 那是代码文本，不会生成 Image 块', () => {
    const md = ['正常：![a](a.png)', '```md', '示例：![b](b.png)', '```', '之后：![c](c.png)'].join(
      '\n',
    );
    assert.deepEqual(extractImageRefs(md), ['a.png', 'c.png']);
  });

  it('波浪号围栏同样识别', () => {
    const md = ['~~~', '![b](b.png)', '~~~', '![c](c.png)'].join('\n');
    assert.deepEqual(extractImageRefs(md), ['c.png']);
  });

  it('支持带 title 的写法', () => {
    assert.deepEqual(extractImageRefs('![x](a.png "标题")'), ['a.png']);
    assert.deepEqual(extractImageRefs("![x](a.png '标题')"), ['a.png']);
  });

  it('支持尖括号包裹的含空格路径', () => {
    assert.deepEqual(extractImageRefs('![x](<my pic.png>)'), ['my pic.png']);
  });

  it('连续多次调用结果一致（正则 lastIndex 不得泄漏）', () => {
    const md = '![1](a.png)';
    assert.deepEqual(extractImageRefs(md), extractImageRefs(md));
  });

  it('没有图片时返回空数组', () => {
    assert.deepEqual(extractImageRefs('# 只有标题\n正文'), []);
  });
});

describe('图片引用到 ImageRef 的解析', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-img-'));

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function mapping(): Mapping {
    return {
      source: 'docs',
      parentNodeToken: 'w1',
      include: ['**/*.md'],
      exclude: [],
      onMissing: 'create',
      onAmbiguous: 'fail',
    };
  }

  it('本地图片解析出路径与内容哈希', () => {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/p.png'), 'bytes');
    fs.writeFileSync(path.join(tmp, 'docs/a.md'), '![p](p.png)\n');

    const imgs = scanMapping(tmp, mapping())[0]!.images;
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0]!.local, true);
    assert.equal(imgs[0]!.relPath, 'docs/p.png');
    assert.match(imgs[0]!.sha256, /^[0-9a-f]{64}$/);
  });

  it('远程图片标记为 external 且不上传', () => {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/b.md'), '![x](https://a.com/b.png)\n');

    const imgs = scanMapping(tmp, mapping()).find((f) => f.relPath === 'docs/b.md')!.images;
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0]!.local, false);
    assert.equal(imgs[0]!.sha256, 'external');
    assert.equal(imgs[0]!.relPath, undefined);
  });

  it('本地文件不存在时用 missing 哨兵，而不是从列表里删掉', () => {
    // 删掉会造成位置错位；用哨兵值则会让该块被判定为「变了」而重建
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/c.md'), '![x](nope.png)\n');

    const imgs = scanMapping(tmp, mapping()).find((f) => f.relPath === 'docs/c.md')!.images;
    assert.equal(imgs.length, 1, '找不到文件也必须占住位置');
    assert.equal(imgs[0]!.sha256, 'missing');
  });

  it('远程图与本地图混排时顺序与数量都不变', () => {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/d.png'), 'local-bytes');
    fs.writeFileSync(
      path.join(tmp, 'docs/d.md'),
      ['![r](https://a.com/x.png)', '![l](d.png)', '![r2](https://a.com/y.png)'].join('\n'),
    );

    const imgs = scanMapping(tmp, mapping()).find((f) => f.relPath === 'docs/d.md')!.images;
    assert.deepEqual(
      imgs.map((i) => [i.src, i.local]),
      [
        ['https://a.com/x.png', false],
        ['d.png', true],
        ['https://a.com/y.png', false],
      ],
    );
  });
});

describe('scanMapping', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-scan-'));

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function mapping(overrides: Partial<Mapping> = {}): Mapping {
    return {
      source: 'docs',
      parentNodeToken: 'w1',
      include: ['**/*.md'],
      exclude: [],
      onMissing: 'create',
      onAmbiguous: 'fail',
      ...overrides,
    };
  }

  it('递归扫描并按路径排序', () => {
    fs.mkdirSync(path.join(tmp, 'docs/sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/b.md'), '# B\n');
    fs.writeFileSync(path.join(tmp, 'docs/sub/a.md'), '# A\n');

    const files = scanMapping(tmp, mapping());
    assert.deepEqual(
      files.map((f) => f.relPath),
      ['docs/b.md', 'docs/sub/a.md'],
    );
  });

  it('排除规则生效', () => {
    fs.mkdirSync(path.join(tmp, 'docs/releases'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/releases/v1.md'), '# V1\n');

    const files = scanMapping(tmp, mapping({ exclude: ['**/releases/**'] }));
    assert.equal(
      files.some((f) => f.relPath.includes('releases')),
      false,
    );
  });

  it('跳过点开头的目录', () => {
    fs.mkdirSync(path.join(tmp, 'docs/.hidden'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/.hidden/x.md'), '# X\n');
    const files = scanMapping(tmp, mapping());
    assert.equal(
      files.some((f) => f.relPath.includes('.hidden')),
      false,
    );
  });

  it('source 不存在时返回空数组而不抛错', () => {
    assert.deepEqual(scanMapping(tmp, mapping({ source: 'not-there' })), []);
  });

  it('同一文件内容相同则哈希相同，改动后哈希不同', () => {
    const p = path.join(tmp, 'docs/hash.md');
    fs.writeFileSync(p, 'same\n');
    const first = scanMapping(tmp, mapping()).find((f) => f.relPath === 'docs/hash.md')!;
    const again = scanMapping(tmp, mapping()).find((f) => f.relPath === 'docs/hash.md')!;
    assert.equal(first.sha256, again.sha256);

    fs.writeFileSync(p, 'changed\n');
    const third = scanMapping(tmp, mapping()).find((f) => f.relPath === 'docs/hash.md')!;
    assert.notEqual(first.sha256, third.sha256);
  });

  it('图片内容变化时哈希随之变化', () => {
    fs.mkdirSync(path.join(tmp, 'docs/img'), { recursive: true });
    const imgPath = path.join(tmp, 'docs/img/p.png');
    const mdPath = path.join(tmp, 'docs/imgdoc.md');

    fs.writeFileSync(imgPath, 'v1');
    fs.writeFileSync(mdPath, '![p](img/p.png)\n');
    const before = scanMapping(tmp, mapping()).find((f) => f.relPath === 'docs/imgdoc.md')!;
    assert.equal(before.images.length, 1);

    fs.writeFileSync(imgPath, 'v2');
    const afterScan = scanMapping(tmp, mapping()).find((f) => f.relPath === 'docs/imgdoc.md')!;
    assert.notEqual(before.images[0]!.sha256, afterScan.images[0]!.sha256);
    // 文档正文没变，所以文档哈希不该变 —— 图片变化靠 images 里的哈希被发现
    assert.equal(before.sha256, afterScan.sha256);
  });
});

describe('文件被多个 mapping 匹配的检查', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-overlap-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function mappingOf(source: string, include: string[] = ['**/*.md']): Mapping {
    return {
      source,
      parentNodeToken: `w-${source}`,
      include,
      exclude: [],
      onMissing: 'create',
      onAmbiguous: 'fail',
    };
  }

  before(() => {
    fs.mkdirSync(path.join(tmp, 'products/01-A'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'products/root.md'), '# 根层文档\n');
    fs.writeFileSync(path.join(tmp, 'products/01-A/inner.md'), '# 子目录文档\n');
  });

  it('文件集不相交时通过 —— 上层只吃根层，下层吃子目录', () => {
    // 注意 include 写的是 `products/*.md` 而不是 `*.md`：
    // include 匹配的是**工程根相对路径**，不是 source 相对路径。
    // 写成 `*.md` 会一个文件都匹配不到，那样测试也会「通过」，
    // 但通过的原因是完全错误的 —— 这种测试比没有更危险。
    const mappings = [mappingOf('products', ['products/*.md']), mappingOf('products/01-A')];
    assert.deepEqual(findOverlappingFiles(tmp, mappings), []);
    assert.doesNotThrow(() => assertNoOverlap(tmp, mappings));

    // 反过来确认上层确实匹配到了根层文件，证明上面不是「因为没匹配才对」
    assert.equal(scanMapping(tmp, mappings[0]!).length, 1);
  });

  it('include 写错（匹配不到任何文件）时不会伪装成「不重叠」', () => {
    // 这正是上面那条注释警告的情形：`*.md` 匹配不到工程根下的
    // `products/root.md`（含斜杠），所以上层 mapping 是空的，
    // 重叠检查自然通过 —— 但用户以为自己在同步根层文件。
    const wrong = [mappingOf('products', ['*.md']), mappingOf('products/01-A')];
    assert.deepEqual(findOverlappingFiles(tmp, wrong), []);
    assert.equal(scanMapping(tmp, wrong[0]!).length, 0, '这条 mapping 实际什么都没匹配到');
  });

  it('父目录递归包含时被抓出 —— 同一文件会建出两份远端文档', () => {
    const mappings = [mappingOf('products'), mappingOf('products/01-A')];
    const overlap = findOverlappingFiles(tmp, mappings);

    assert.equal(overlap.length, 1);
    assert.equal(overlap[0]!.relPath, 'products/01-A/inner.md');
    assert.deepEqual(overlap[0]!.sources, ['products', 'products/01-A']);
  });

  it('报错信息指出是哪个文件、被谁匹配，并给出改法', () => {
    const mappings = [mappingOf('products'), mappingOf('products/01-A')];
    assert.throws(
      () => assertNoOverlap(tmp, mappings),
      (err: unknown) =>
        err instanceof ConfigError &&
        /inner\.md/.test(err.message) &&
        /include/.test(err.hint ?? ''),
    );
  });

  it('完全不嵌套的多个 mapping 互不影响', () => {
    const mappings = [mappingOf('products/01-A'), mappingOf('products', ['*.md'])];
    assert.deepEqual(findOverlappingFiles(tmp, mappings), []);
  });
});
