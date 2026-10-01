#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * 便携的测试入口。
 *
 * ## 为什么不直接写 `node --test "dist/tests/**\/*.test.js"`
 *
 * `--test` 对 **glob 模式**的支持是 Node 21 才加的。本包声明 `engines: >=18`，
 * 在 18/20 上那条命令会直接报「找不到模块」，而不是跑测试 ——
 * 一个只在旧版本上出现的失败，最容易被误读成「测试挂了」。
 *
 * 这里自己递归找文件、显式列给 `node --test`，任何 ≥18 的版本都能跑。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const testsDir = path.join(root, 'dist', 'tests');

if (!fs.existsSync(testsDir)) {
  process.stderr.write(
    `找不到 ${path.relative(root, testsDir)} —— 需要先构建。\n` +
      `直接跑 \`npm test\`（它会先构建），或先 \`npm run build\`。\n`,
  );
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.test.js')) files.push(full);
  }
};
walk(testsDir);
files.sort();

if (files.length === 0) {
  process.stderr.write(`在 ${path.relative(root, testsDir)} 下没找到任何 *.test.js\n`);
  process.exit(1);
}

// 显式传文件名而不是目录：目录形式的支持在各版本间也不一致
// （Node 22 上 `node --test dist/tests` 会把它当成要 require 的模块）。
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(result.status ?? 1);
