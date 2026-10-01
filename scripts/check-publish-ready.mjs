#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * 发布前门禁。
 *
 * 由 `prepublishOnly` 触发，**在 `npm publish` 真正发包之前**跑。
 *
 * ## 为什么要有它
 *
 * 发布是不可逆的：npm 包发布 72 小时后不能撤回，包名会被永久占用。
 * 而「忘了改 package.json 里的占位 URL」「忘了填 license」「忘了去掉 private」
 * 这三件事都是**发出去之后才会被发现**的 —— 那时已经晚了。
 *
 * 所以把「发布就绪」做成一道能拦住的检查，而不是靠清单上的一句提醒。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const problems = [];
const warnings = [];

// ── 硬性阻拦：任何一条都会让发出去的包有问题 ──

if (pkg.private === true) {
  problems.push(
    '`private: true` 仍在 —— npm 会拒绝发布。确认要公开发布后删掉它（内部 registry 也一样）',
  );
}

if (!pkg.license) {
  problems.push(
    '缺少 `license` 字段。**这是必须由人决定的**：' +
      '内部专用可填 `UNLICENSED`，开源常见是 `MIT` / `Apache-2.0`。' +
      '没有 license 的包默认「保留所有权利」，别人装了也不能用',
  );
}

const placeholders = JSON.stringify(pkg).match(/<[a-z-]+>/g) ?? [];
if (placeholders.length > 0) {
  problems.push(
    `package.json 里还有未替换的占位符：${[...new Set(placeholders)].join('、')}。` +
      '这些会被原样发布到 npm 上',
  );
}

// LICENSE 里的占位符同样会被原样发布 —— 一份写着 `<COPYRIGHT HOLDER>` 的
// MIT 协议在法律上毫无意义
const licensePath = path.join(root, 'LICENSE');
if (fs.existsSync(licensePath)) {
  const text = fs.readFileSync(licensePath, 'utf8');
  const found = text.match(/<[A-Z][A-Z ]*>/g) ?? [];
  if (found.length > 0) {
    problems.push(
      `LICENSE 里还有未替换的占位符：${[...new Set(found)].join('、')}。` +
        '带占位符的许可协议等于没有许可',
    );
  }
}

// README 链到的本地文档必须真的在包里。
//
// 这条属于硬性阻拦：npm 页面上一个点不开的链接，比不写那个链接更让人困惑 ——
// 读者会以为是自己装错了，或者文档被删了。
const readmePath = path.join(root, 'README.md');
if (fs.existsSync(readmePath)) {
  const text = fs.readFileSync(readmePath, 'utf8');
  const linked = new Set(
    [...text.matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1]),
  );
  const packaged = new Set((pkg.files ?? []).map((f) => path.basename(f)));

  for (const link of linked) {
    if (link.includes('/')) continue; // 子目录另行判断，这里只管仓库根目录下的
    if (!packaged.has(link)) {
      problems.push(
        `README 链到 ${link}，但它不在 package.json 的 \`files\` 里 —— npm 页面上会是死链`,
      );
    }
  }
}

// ── 提醒：不阻拦，但值得在发之前想一下 ──

if (!pkg.repository?.url) {
  warnings.push('没有 repository 地址，npm 页面上不会有源码入口');
}

if (!fs.existsSync(readmePath)) {
  warnings.push('没有 README.md，npm 页面会是一张白纸');
} else {
  const text = fs.readFileSync(readmePath, 'utf8');
  if (/尚未对真实|未对真实飞书|从未对真实/.test(text)) {
    warnings.push(
      'README 里写着「尚未对真实飞书验证过」—— 确认这是你想让下载者看到的第一印象',
    );
  }
}

// 只有 license 字段明确指向一个文件时才需要那个文件。
// `UNLICENSED`（内部专用，本项目的选择）本来就不该有 LICENSE。
if (/SEE LICENSE IN/i.test(pkg.license ?? '') && !fs.existsSync(path.join(root, 'LICENSE'))) {
  problems.push(`license 字段指向 LICENSE 文件，但仓库里没有这个文件`);
}

// ── 输出 ──

if (problems.length > 0) {
  process.stderr.write('\n✗ 还没准备好发布：\n\n');
  for (const p of problems) process.stderr.write(`  · ${p}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

if (warnings.length > 0) {
  process.stdout.write('\n提示（不阻止发布）：\n\n');
  for (const w of warnings) process.stdout.write(`  · ${w}\n`);
  process.stdout.write('\n');
}

process.stdout.write('✓ 发布前检查通过\n');
