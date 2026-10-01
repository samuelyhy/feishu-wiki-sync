# 发布前自动提交脏工作区 — 设计

日期：2026-10-01  
状态：待实现

## 问题

`pnpm release` / `npm run release` 要求工作区干净：tarball 来自工作区，tag 指向提交，两者必须是同一份代码。当前实现是脏则直接失败，要求手工 `git add && git commit`，打断「一键发布」。

发布成功后的 `chore(release): vX.Y.Z` 提交与 `vX.Y.Z` tag **已经**由 `finalize.mjs`（`postpublish`）完成，本设计不改那条路径。

## 目标

工作区有未提交改动时，发布准备阶段可**确认后自动提交**，再继续递增版本 / 写 CHANGELOG / 测试 / 发布，无需再开终端手工 commit。

## 非目标

- 不替代发布后的 release commit / tag（已有）
- 不引入 AI 推断的提交信息
- 不在 `--allow-dirty` 下偷偷提交（那是「带着脏工作区硬发」的逃生口）

## 行为

| 场景 | 行为 |
|---|---|
| 工作区干净 | 与现在相同 |
| 脏 + 未设 `--no-auto-commit` / `--allow-dirty` | 列出改动摘要 → 确认（或 `--yes`）→ 敏感文件扫描 → `git add -A` + commit → 刷新 git 状态 → 继续发布 |
| `--check` / `--dry-run` | **只报告**「会提交 N 个文件 / 消息是什么」，**不执行** commit；随后按「工作区将干净」继续后续检查/演练（否则演练永远卡在脏检查） |
| `--no-auto-commit` | 恢复旧行为：脏则 `die` |
| `--allow-dirty` | 不提交，带着脏工作区继续（风险自负，已有） |
| 敏感文件命中 | 拒绝自动提交，打印命中路径，要求手工处理或移出工作区 |
| 提交失败 | 中止发布，不写版本号 |

确认文案示例：`提交以上 N 处改动并继续发布？ (y/N)`  
`--yes` / `FWS_RELEASE_YES=1` / 非 TTY：与现有 `confirm()` 一致，直接视为同意。

## 参数与环境变量

| CLI | 环境变量 | 默认 | 作用 |
|---|---|---|---|
| （默认开启自动提交流程） | — | on | 脏则询问后提交 |
| `--no-auto-commit` | `FWS_RELEASE_NO_AUTO_COMMIT=1` | off | 脏则直接失败（旧行为） |
| `--commit-message <msg>` | `FWS_RELEASE_COMMIT_MSG` | `chore: commit workspace before release` | 自动提交的说明 |
| `--yes` | `FWS_RELEASE_YES=1` | — | 跳过确认（含本步） |
| `--allow-dirty` | `FWS_RELEASE_ALLOW_DIRTY=1` | — | 已有，不提交 |

## 敏感路径规则（纯函数，可单测）

对 `git status --porcelain` 列出的路径做匹配（大小写不敏感，按 basename 或完整相对路径）：

- 精确/后缀：`.env`、`.env.*`（不含 `.env.example`）
- 扩展名：`.pem`、`.key`、`.p12`、`.pfx`
- 名称含：`credentials`、`secret`、`id_rsa`、`id_ed25519`

命中任一条 → 不 `git add`，报错退出并列出路径。

## 架构落点

沿用现有分层，**不新增独立进程**：

1. **`lib.mjs`**（纯逻辑）
   - `DEFAULT_PRE_RELEASE_COMMIT_MSG`
   - `isSensitivePath(relPath) → boolean`
   - `findSensitivePaths(paths) → string[]`
2. **`io.mjs`**（副作用）
   - `commitAll(message) → { ok, status, stdout, stderr }`：`git add -A` + `git commit -m …`
3. **`preflight.mjs`**（编排）
   - 在现有「工作区不干净」分支：按上表分支；提交成功后重新 `gitState()`，再走后续步骤
4. **`cli.mjs`**
   - 解析 `--no-auto-commit`、`--commit-message`；更新 `USAGE`
5. **`PUBLISHING.md`**
   - 「为什么要求工作区干净」旁补充自动提交说明与逃生开关

## 与 finalize 的关系

| 阶段 | 提交内容 | 时机 |
|---|---|---|
| preflight 自动提交 | 用户工作区全部改动（敏感文件除外） | 发布**前**，保证 tarball ≡ HEAD |
| finalize release 提交 | 仅脚本改过的 `package.json` / `CHANGELOG.md` | 发布**后**，再打 `vX.Y.Z` |

两步独立：前一步失败则根本不发布；后一步失败则包已在 npm，按现有手工补救文案处理。

## 测试

在 `tests/release.test.ts` 增加：

- `isSensitivePath` / `findSensitivePaths`：正例与 `.env.example` 反例
- 默认提交消息常量存在且非空

不在单测里真跑 `git commit`（副作用层）；行为靠 preflight 注释与文档约束。

## 验收

1. 脏工作区执行 `npm run release -- --dry-run`：报告将提交的文件数，工作区无新 commit
2. 脏工作区执行 `npm run release -- --yes --no-test`（或同等）：先出现自动提交，再进入发布流程；HEAD 含先前改动
3. 工作区含 `.env`：自动提交被拒绝，明确列出路径
4. `--no-auto-commit`：行为与改前一致（脏则失败）
