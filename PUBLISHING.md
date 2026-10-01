# 发布流程

面向维护者。使用者只需要看 [README](README.md)。

---

## 前置：npm token 必须是 Granular 且允许绕过 2FA

**这是第一次发版最容易撞的墙，先做掉。**

npm 已不允许**经典 token**（`npm_` + 36 位，共 40 字符）为开启了 2FA 的账号发布包。用它会得到：

```
403 Forbidden - Two-factor authentication or granular access token
with bypass 2fa enabled is required to publish packages.
```

这个报错**看起来像权限问题**，实际是 token 类型问题 —— 包本身完全没问题。

### 怎么换

1. 打开 <https://www.npmjs.com/settings/~/tokens>
2. **Generate New Token** → 选 **Granular Access Token**（⚠️ 不是 Classic）
3. 配置：

   | 项 | 值 |
   |---|---|
   | Permissions | `Read and write` |
   | Packages | `All packages`（或限定 scope） |
   | ✅ | **`Allow this token to bypass 2FA`** |

   最后一项是**关键**，Classic token 里根本没有这个选项。

4. 生成后复制（只显示一次），写进 `~/.npmrc`：

   ```
   //registry.npmjs.org/:_authToken=npm_你的新token
   ```

**或者更省事**：走浏览器授权，它会处理 2FA 并自动写凭证。

```bash
npm login --auth-type=web
```

> ⚠️ token 等于发布权限，**不要提交进仓库，也不要贴到任何对话或工单里**。

### 验证

```bash
npm whoami          # 应输出你的 npm 用户名
```

若无输出或超时，说明 token 没生效，先解决它再往下走。

---

## 发布步骤

```bash
cd <本仓库>

npm run release -- --dry-run        # 先演练一遍，看看到底会发什么
npm run release                     # 正式发布（脏工作区会询问后先自动提交）
```

两条命令就够了。第一条建议每次都跑 —— 它是**完整流程**：递增版本号、更新
CHANGELOG、跑测试、构建、打包，然后停在「要不要真的发」这一步，最后把工作区
还原成原样。它会顺便告诉你包里有几个文件、多大、有没有混进 sourcemap。

### 它会替你做什么

| 步骤 | 内容 |
|---|---|
| 1. 环境 | git 仓库、工作区干净、分支、是否落后远端、npm 身份 |
| 2. 远端版本 | 查 registry 上已有的版本与 dist-tags |
| 3. 版本号 | 本地版本没发过就原样发；发过了就递增（默认 patch） |
| 4. 变更日志 | 已有对应段落就用它；有 `## [Unreleased]` 就改名；都没有就按提交记录生成草稿 |
| 5. 落盘 | 写 package.json 与 CHANGELOG.md，并留好还原现场所需的状态 |
| 6. 门禁 | 跑 `scripts/check-publish-ready.mjs` |
| 7. 构建与测试 | `npm test`（含构建） |
| 8. 摘要 | 显示版本、dist-tag、包内容，然后问一句「确认发布？」 |

发布成功之后（`postpublish`）自动：**向 registry 确认这个版本真的在** →
`git commit chore(release): vX.Y.Z` → 打 tag `vX.Y.Z`（说明取自 CHANGELOG）→
推送分支与 tag。

### 常用参数

```bash
npm run release -- minor          # 递增次版本（还可 major / patch / none）
npm run release -- --dry-run      # 演练：不发、不打 tag、不提交
npm run release -- --check        # 只报告会做什么，一个字节都不改
npm run release -- --no-test      # 跳过测试（仍然会构建）
npm run release -- --tag next     # 指定 dist-tag（预发布版必需）
npm run release -- --yes          # 不再询问（含发布前自动提交）
npm run release -- --commit-message "feat: ..."  # 覆盖自动提交说明
npm run release -- --no-auto-commit              # 脏工作区时不自动提交（旧行为）
```

### 直接敲 `npm publish` 也行，但有一样做不到

两个钩子都挂在 package.json 上，`npm publish` 走的是**同一套流程**，所以
直接敲它同样会跑门禁、测试，发布成功后同样会打 tag、提交。

**唯一做不到的是递增版本号。** npm 在启动那一刻就把 package.json 读进内存，
`prepublishOnly` 跑得比打包晚 —— 实测：

```
$ npm publish --dry-run     # prepublishOnly 把版本号改成了 2.0.0
npm notice package: when-read@1.0.0     ← 发出去的仍然是 1.0.0
$ cat package.json          # 磁盘上却是 2.0.0
```

在钩子里递增，结果是发出去旧版本、却按新版本打了 tag —— 仓库里从此挂着一个
指向不存在版本的 tag。所以钩子里**只核对不递增**：版本号已经发布过就明确拒绝，
并告诉你先跑 `npm run release`。

### 为什么要求工作区干净（以及何时自动提交）

不是洁癖。tarball 是从**工作区**打的，而 tag 指向**提交**。工作区里有未提交
的改动时，两者不是同一份代码 —— 于是 npm 上那个版本的源码，在仓库里根本找不到。

因此正式发布前工作区最终必须干净。默认行为是：**列出改动 → 询问 →
`git add -A` 并提交**（`--yes` 时跳过询问），默认说明为
`chore: commit workspace before release`，可用 `--commit-message` 覆盖。

- `--check` / `--dry-run` 只报告「会提交什么」，**不**留下真实 commit
- 疑似密钥路径（`.env`、`*.pem`、`*credentials*`、`*secret*` 等；`.env.example` 除外）会拒绝自动提交
- `--no-auto-commit`：恢复「脏则失败」，改回手工提交
- 确实要带着脏工作区硬发：`FWS_RELEASE_ALLOW_DIRTY=1`（风险自负）

---

## 发布门禁会拦什么

发布前会依次跑两道：`scripts/release/preflight.mjs`（流程门禁）和
`scripts/check-publish-ready.mjs`（元数据门禁）。

**流程门禁**（`preflight.mjs`）：

| 检查 | 为什么 |
|---|---|
| 工作区不干净 | 默认询问后自动提交；`--no-auto-commit` 时失败；敏感文件一律拒绝自动提交 |
| 仓库没有任何提交 | 打 tag 需要落点 |
| 版本号已经发布过（钩子模式） | 会被 npm 拒绝；且无法在此处递增，只能先跑 `npm run release` |
| 版本号已占用（准备模式） | 自动递增到下一个未被占用的号 |
| 查不到远端版本 | 判断不了版本号是否被占，宁可不发 |
| `npm whoami` 无输出 | token 失效或类型不对（见本文开头） |
| 预发布版没带 `--tag` | 会顶掉 `latest`，别人装到的就是测试版 |

**元数据门禁**（`check-publish-ready.mjs`，硬性阻拦）：

| 检查 | 为什么 |
|---|---|
| `private: true` 仍在 | npm 会直接拒绝发布 |
| 缺少 `license` 字段 | 没有 license 的包默认「保留所有权利」，别人装了也不能用 |
| package.json 里有 `<占位符>` | 会被原样发布到 npm 上 |
| LICENSE 里有 `<占位符>` | 带占位符的许可协议等于没有许可 |
| README 链到的文档不在 `files` 里 | npm 页面上会是死链 |
| `license` 指向 LICENSE 文件但那文件不存在 | — |

**只提示不阻拦**：

- 没有 `repository` 地址（npm 页面上不会有源码入口）
- README 里写着「尚未对真实飞书验证过」
- 没有 git remote（发布后 tag 和提交只在本地，提示里给了推送命令）
- 本地落后远端
- 包里有 sourcemap / `.ts` / 测试文件

**发布失败一律回滚**：测试没过、门禁没过、连接断开 —— 工作区会被还原到
发布前的样子（只还原脚本自己改过的文件；中途手工改过的内容会保留并提示）。

---

## 版本号规则

语义化版本：

| 变更 | 版本 |
|---|---|
| 破坏性变更（命令改名、配置字段改名、退出码语义变化） | major |
| 新增命令或开关 | minor |
| 修 bug、改文档 | patch |

**`0.x` 阶段不要当真**：首次发布用 `0.1.0`。正式对外承诺兼容性后再进 `1.0.0`。

改版本号时**必须同步 `CHANGELOG.md`** —— 它是「哪个版本含什么」的唯一判据。

---

## 发布失败怎么排查

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `E403 ... bypass 2fa` | token 是 Classic 类型 | 见本文开头，换成 Granular |
| `E401 Unauthorized` | token 失效或写错 | `npm whoami` 验证后重新生成 |
| `E403 ... not allowed to publish` | 包名被占用，或 scope 无权限 | `npm view <包名>` 查占用情况 |
| `EPUBLISHCONFLICT` | 该版本号已发布过 | 跑 `npm run release`，它会递增版本号；**npm 不允许覆盖已发布的版本** |
| 门禁报错 | 元数据没备齐 | 按报错逐条修，报错里写了具体原因 |
| 「包已发布，但 tag/提交失败」 | 发布了，收尾那步没做完 | 包不会重发。按屏幕上的命令手工补 tag 与提交 |
| 「没能从 registry 上确认，因此没有打 tag」 | 查询接口还没同步过来 | 先 `npm view <包名>@<版本> version` 确认，再按提示手工打 tag |
| 「已经存在 tag vX」 | 上一次发布失败的残留 | 确认那个 tag 只在本地后 `git tag -d vX`，再补上 |

状态文件在 `.git/fws-release-state.json`（不会进版本库），里面记着准备阶段改过
什么、该打什么 tag。中途被打断时，下一次 `npm run release` 会先按它把工作区还原。

⚠️ **发布 72 小时后不能再撤回**，且包名会被永久占用。所以有门禁挡在前面。

---

## 从 CI 发布（可选）

本机 token 只适合个人发版。要让发版可重复、且不依赖某台机器，可以让 CI 来发。

仓库里已经有 `.github/workflows/publish.yml`，做的是这件事。它的几个要点：

1. Granular token 存为仓库 Secret `NPM_TOKEN`
2. 只在**显式触发**时跑（`workflow_dispatch`），不挂在每次 push 上
3. 先 `pnpm test`，再发布 —— 不能发一个测试没过的版本出去
4. `actions/setup-node` 配 `registry-url: https://registry.npmjs.org` 以读 `NODE_AUTH_TOKEN`
5. 发布成功后用 `GITHUB_TOKEN` 补打 tag（需要 `contents: write`）

**CI 里不会递增版本号**，这是刻意的：版本号必须在本地提交好。CI 的职责是
「把仓库里那个已经提交、已经 review 过的版本送出去」，如果它自己会改版本号，
发出去的东西就和仓库里的任何一次提交都对不上了。

所以流程是：本地 `npm run release`（递增 → 测试 → 发布 → 打 tag → 提交 → 推送），
CI 只是另一条把**同一个已提交版本**发出去的通道。二者都跑同一套钩子。

> 若仓库托管在 Gitee，把同一套步骤搬到 Gitee Go 即可 —— 逻辑一样，只是 YAML 写法不同。
