# Release Auto-Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作区有未提交改动时，`npm run release` 可确认后自动提交，再继续发布，无需手工 commit。

**Architecture:** 纯逻辑（敏感路径 / 默认消息）进 `lib.mjs`；`git add -A` + commit 进 `io.mjs`；编排改 `preflight.mjs` 脏检查分支；参数解析改 `cli.mjs`。`--check` / `--dry-run` 只报告不提交，随后按干净继续。

**Tech Stack:** Node.js ESM（现有 `scripts/release/*`）、`node:test`（`tests/release.test.ts`）

## Global Constraints

- 默认开启自动提交流程；`--no-auto-commit` 恢复旧行为
- 默认消息：`chore: commit workspace before release`
- `--check` / `--dry-run` 不执行 commit
- 敏感文件命中则拒绝自动提交
- 不改 `finalize.mjs` 的发布后 tag / release commit

---

### Task 1: 敏感路径与默认消息（lib + 测试）

**Files:**
- Modify: `scripts/release/lib.mjs`（文末新增一节）
- Modify: `tests/release.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_PRE_RELEASE_COMMIT_MSG: string`
  - `isSensitivePath(relPath: string): boolean`
  - `findSensitivePaths(paths: string[]): string[]`

- [ ] **Step 1: 写失败测试**

在 `tests/release.test.ts` 增加 import 与 describe：

```ts
import * as release from '../../scripts/release/lib.mjs';
// 解构增加：DEFAULT_PRE_RELEASE_COMMIT_MSG, isSensitivePath, findSensitivePaths

describe('发布前自动提交：敏感路径', () => {
  it('识别常见密钥文件，放过 .env.example', () => {
    assert.equal(isSensitivePath('.env'), true);
    assert.equal(isSensitivePath('apps/foo/.env.local'), true);
    assert.equal(isSensitivePath('certs/server.pem'), true);
    assert.equal(isSensitivePath('id_rsa'), true);
    assert.equal(isSensitivePath('my-credentials.json'), true);
    assert.equal(isSensitivePath('.env.example'), false);
    assert.equal(isSensitivePath('src/core/config.ts'), false);
  });

  it('findSensitivePaths 只返回命中项', () => {
    assert.deepEqual(
      findSensitivePaths(['README.md', '.env', 'src/a.ts', 'secret-token.txt']),
      ['.env', 'secret-token.txt'],
    );
  });

  it('默认提交消息非空', () => {
    assert.ok(DEFAULT_PRE_RELEASE_COMMIT_MSG.trim().length > 0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- tests/release.test.ts`（或项目等价命令）  
Expected: FAIL — `isSensitivePath` / `DEFAULT_PRE_RELEASE_COMMIT_MSG` 未导出

- [ ] **Step 3: 在 lib.mjs 实现**

```js
export const DEFAULT_PRE_RELEASE_COMMIT_MSG = 'chore: commit workspace before release';

const SENSITIVE_BASENAME_EXACT = new Set(['.env', 'id_rsa', 'id_ed25519']);
const SENSITIVE_EXT = /\.(pem|key|p12|pfx)$/i;
const SENSITIVE_NAME = /(^|[^a-z0-9])(credentials|secret)([^a-z0-9]|$)/i;

export function isSensitivePath(relPath) {
  const normalized = String(relPath).replaceAll('\\', '/');
  const base = normalized.split('/').pop() ?? normalized;
  if (/^\.env\.example$/i.test(base)) return false;
  if (SENSITIVE_BASENAME_EXACT.has(base.toLowerCase())) return true;
  if (/^\.env(\.|$)/i.test(base)) return true; // .env, .env.local, .env.production …
  if (SENSITIVE_EXT.test(base)) return true;
  if (SENSITIVE_NAME.test(base)) return true;
  return false;
}

export function findSensitivePaths(paths) {
  return paths.filter((p) => isSensitivePath(p));
}
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit**（仅当用户要求时）

---

### Task 2: io.commitAll

**Files:**
- Modify: `scripts/release/io.mjs`

**Interfaces:**
- Consumes: existing `git(args, opts)`
- Produces: `commitAll(message: string) → { ok, status, stdout, stderr }`

- [ ] **Step 1: 实现 `commitAll`**

```js
/** 暂存全部改动并提交。调用方须已做敏感文件检查。 */
export function commitAll(message) {
  const added = git(['add', '-A']);
  if (!added.ok) return added;
  return git(['commit', '-m', String(message)]);
}
```

- [ ] **Step 2: 无单独测试**（副作用层；由 Task 3 编排）

---

### Task 3: preflight 编排 + cli 参数

**Files:**
- Modify: `scripts/release/preflight.mjs`（`readOptions` + 脏检查块约 178–195 行）
- Modify: `scripts/release/cli.mjs`（`parseArgs` + `USAGE`）
- Modify: `PUBLISHING.md`（工作区干净一节）

**Interfaces:**
- Consumes: `findSensitivePaths`, `DEFAULT_PRE_RELEASE_COMMIT_MSG`, `commitAll`, `confirm`, `gitState`
- Options:
  - `autoCommit`（默认 true；`FWS_RELEASE_NO_AUTO_COMMIT=1` → false）
  - `commitMessage`（`FWS_RELEASE_COMMIT_MSG` 或默认常量）

- [ ] **Step 1: cli 解析**

```js
case '--no-auto-commit':
  env.FWS_RELEASE_NO_AUTO_COMMIT = '1';
  break;
case '--commit-message': {
  const value = argv[++i];
  if (!value) problems.push('--commit-message 后面要跟提交说明');
  else env.FWS_RELEASE_COMMIT_MSG = value;
  break;
}
```

USAGE 增加对应行。

- [ ] **Step 2: preflight 替换脏检查**

伪代码：

```
if unexpected.length > 0 && !allowDirty && !isCI:
  sensitive = findSensitivePaths(unexpected)
  if sensitive.length: die(...)
  if checkOnly || dryRun:
    log.warn(`工作区有 N 处改动；正式发布时会先提交（消息：…）`)
    // 不 die，继续
  else if !autoCommit:
    die(旧文案 + 提示可用默认自动提交)
  else:
    列出摘要
    agreed = await confirm(`提交以上 N 处改动并继续发布？`, { yes })
    if !agreed: die/cancel
    result = commitAll(commitMessage)
    if !result.ok: die
    git = gitState() // 刷新
    log.ok(`已提交 …`)
```

注意：CI 当前跳过脏检查（`!opts.isCI`）；保持不变。`--allow-dirty` 仍优先于自动提交。

- [ ] **Step 3: 更新 PUBLISHING.md**

说明默认会询问后自动提交；列出 `--no-auto-commit`、`--commit-message`、`--allow-dirty`。

- [ ] **Step 4: 源码级钉死参数**（可选，放 `tests/release.test.ts`）

断言 `cli.mjs` 含 `--no-auto-commit` 与 `--commit-message`。

- [ ] **Step 5: 跑全量测试**

Run: `pnpm test`  
Expected: PASS

---

### Task 4: 手工验收（不改仓库真实发布）

- [ ] `pnpm release -- --check`：脏工作区时应报告将提交，且不产生新 commit、不改 package.json
- [ ] 含 `.env` 的临时文件：应拒绝（可用临时 touch + `--check` 验证文案路径；测完删除）

---

## Spec coverage

| Spec 要求 | Task |
|---|---|
| 交互确认 / `--yes` | Task 3 |
| 默认消息 + `--commit-message` | Task 1 + 3 |
| `git add -A` | Task 2 |
| 敏感路径拦截 | Task 1 + 3 |
| `--check`/`--dry-run` 不提交并继续 | Task 3 |
| `--no-auto-commit` | Task 3 |
| 不改 finalize tag | （无改动） |
| 测试敏感路径 | Task 1 |
| PUBLISHING.md | Task 3 |
