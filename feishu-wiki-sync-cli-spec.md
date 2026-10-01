# 飞书知识库同步 CLI — 实现规格

> 日期：2026-09-30
> 需求：本地已生成的 Markdown 文档，按**文件名**匹配知识库中的**同名文档**，原地增量更新其内容
> 决策：**纯 CLI，不引入 Dify**；**块级增量更新，保留评论**
> 事实依据：`_research/`（飞书开放平台官方文档的离线快照，代码注释里每条「官方确认」的限制都能在其中查到出处）
>
> **为何不用 Dify**（决策记录，原设计稿已删除）：Dify 的单变量 200KB、HTTP 文本响应 1MB、
> 代码节点沙箱无文件系统且 15 秒超时、Workflow 无任何跨调用持久化状态 —— 这四条决定了
> 块级 diff 与账本在其中无法表达；而本场景内容已在本地生成、无需 LLM 加工，
> Dify 仅剩「定时调度」与「可观测」两项价值，且定时器看不见本地磁盘。净结论是纯负担。

---

## 1. 需求与范围

**做什么**：一个命令，扫描指定本地目录，把每个 `.md` 文件的内容更新到飞书知识库中**同名节点**所挂载的文档里。保留节点 `node_token`（URL 不变）、保留未变块的 `block_id`（评论不变）。

**不做什么**：
- 不做反向同步（远端改动不回写本地）
- 不做 LLM 加工（内容已生成，已是终稿）
- 不做内容改写、格式优化、标题生成

**能力边界（明确写上，避免误期待）**：

| 期望 | 是否支持 | 说明 |
|---|---|---|
| 更新同名文档内容 | ✅ | 核心功能 |
| 文档 URL 不变 | ✅ | `node_token` 不动 |
| 未变块的评论保留 | ✅ | 块级增量 |
| 改动块（文本修改）的评论保留 | ✅ | 走 `batch_update`，`block_id` 不变 |
| 本地新增文件 → 远端建新文档 | ✅ | upsert |
| 本地删除文件 → 远端删节点 | ❌ | **飞书无确认存在的删除节点 API**，降级为「加 `[已废弃]` 前缀 + 移入归档节点」 |
| 本地重命名文件 | ⚠️ | 会被当作「新增一篇 + 旧的一篇废弃」，需用账本 `aliases` 手工认领 |

---

## 2. 配置

### 2.1 `.ai-sync.env`（凭证，强制 gitignore）

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxx
```

> 全程用 `tenant_access_token`（应用身份），不走 OAuth。理由：`user_access_token` 的 refresh_token 一次性、且**授权满 365 天必须重新授权**（报 `20037`），对无人值守的同步工具是不可接受的运维负担。
> 代价：知识库里显示的文档作者是机器人。

### 2.2 `.feishu-sync/config.yaml`（映射，可入版本控制）

```yaml
version: 1

space_id: "7524100000000000001"

defaults:
  include: ["**/*.md"]
  exclude: ["**/releases/**", "**/*.draft.md"]
  on_missing: create       # 远端无同名文档时：create 新建 | fail 报错

mappings:
  - source: docs/specs
    parent_node_token: "wikcnSPECSxxxxxxxx"

  - source: docs/guides
    parent_node_token: "wikcnGUIDESxxxxxxx"
```

> ⚠️ **本文写于实现之前，配置与命令面以 [命令手册](feishu-wiki-sync-commands.md) 为准。**
> 设计阶段规划过的 `on_delete`、`nesting: mirror` 与 `on_ambiguous: newest` 均**未实现**，
> 且现在会在配置加载阶段被**明确拒绝**（配了不生效比报错更糟）。
> 本文保留的是**算法推导**（为什么用 LCS、写入顺序为什么必须倒序、块级三方对比的判据），
> 那部分不随实现细节变化。

### 2.3 配置校验（`fws init --check`）

| 校验项 | 判据 |
|---|---|
| 凭证可用 | 能取到 `tenant_access_token` |
| `space_id` 存在 | `GET /wiki/v2/spaces/{space_id}` |
| `parent_node_token` 验活 | `GET /wiki/v2/spaces/get_node?token=...`，且返回的 `space_id` 与配置一致 |
| **应用有编辑权限** | 对父节点做一次只读 `GET nodes`，403 则报 `131006` 并给出「把含应用的群加为知识空间管理员」的修复指引 |
| mapping 不重叠 | 两个 `source` 不得互为父子路径 |
| 父节点不复用 | 同一 `parent_node_token` 不得出现在多个 mapping |

> 最后两项是防「两份本地文件抢同一个远端文档」——这种冲突一旦发生，表现为两台机器互相覆盖，极难排查。

---

## 3. 命令面

```bash
fws init                       # 采集凭证，建配置骨架，写 .gitignore
fws init --check               # 只做 §2.3 的校验
fws status                     # 只读：打印账本、漂移、未认领项
fws sync                       # 处理全部 mapping
fws sync docs/specs            # 只处理指定目录
fws sync docs/specs/01-domain.md   # 只处理单文件
fws sync --reclaim             # 忽略账本，重新按标题认领（用于修复错配）
```

| Flag | 语义 |
|---|---|
| `--dry-run` | 只做本地扫描与账本比对，**不发任何飞书写请求**，打印将变更的块数 |
| `--force` | 忽略「远端被人工改过」的告警，强制覆盖 |
| `--json` | 机器可读输出，供 CI 消费 |
| `--concurrency N` | 并行文档数，默认 1（受写限流 3 次/秒 约束，调高意义有限） |

**退出码**

| 码 | 含义 |
|---|---|
| 0 | 全部成功（含「无变更」） |
| 1 | 有文档同步失败 |
| 2 | 配置错误（凭证 / 节点验活 / mapping 冲突） |
| 3 | 有文档认领失败或存在歧义（同名多个），需人处理 |
| 4 | 飞书配额耗尽或持续限流（`99991403` / 反复 `99991400`） |

---

## 4. 同步算法总览

```
对每个 mapping：
  ┌─ ① 扫描本地 ─────────────────────────────────┐
  │  遍历 source 目录 → 逐文件算 content_sha256   │
  │  与账本比对 → added / modified / deleted      │
  └───────────────────────────────────────────────┘
                    ▼
  ┌─ ② 认领（建立 路径 → node_token 映射）────────┐
  │  账本里有 → 直接用                           │
  │  账本里没有 → 在 parent_node_token 子树内     │
  │              列举节点，按 title 匹配          │
  │   命中 1 个 → 写账本                         │
  │   命中 0 个 → on_missing=create 建节点        │
  │   命中 ≥2 个 → 退出码 3，打印候选让人消歧      │
  └───────────────────────────────────────────────┘
                    ▼
  ┌─ ③ 快路径：整篇跳过 ─────────────────────────┐
  │  GET /docx/v1/documents/{doc}/raw_content    │
  │  纯文本哈希 == 账本 → 整篇跳过（1 次读，0 写）│
  └───────────────────────────────────────────────┘
                    ▼
  ┌─ ④ 块级 diff ────────────────────────────────┐
  │  GET blocks（分页）→ 远端块序列 + 指纹        │
  │  md → convert → 新块序列 + 指纹              │
  │  序列对齐 → 保留 / 修改 / 新增 / 删除         │
  └───────────────────────────────────────────────┘
                    ▼
  ┌─ ⑤ 写入（顺序敏感，见 §5.4）─────────────────┐
  │  batch_update → batch_delete → descendant    │
  │  图片三步链                                   │
  └───────────────────────────────────────────────┘
                    ▼
  ┌─ ⑥ 写账本 ───────────────────────────────────┐
  │  node_token / revision_id / 新块指纹序列      │
  └───────────────────────────────────────────────┘
```

**关键路径选择说明**

第 ③ 步的 `raw_content` 快路径是整个方案的性价比核心。`raw_content` 只返回纯文本、体积小，**一次读取就能判定整篇是否变化**。没有它，每次同步都要拉全部块（大文档要分页几十次），纯属浪费配额。

第 ④ 步只有在快路径判定「变了」时才执行。

---

## 5. 块级增量更新（核心）

这一节是全部实现难度所在。

### 5.1 为什么需要指纹：convert 不返回稳定 ID

`convert` 的输入是 Markdown 文本，**没有任何机制让本地 md 携带远端 block_id**。它返回的永远是临时 ID（`children_id` 由调用方自定义，`descendant` 再映射成真实 block_id）。

所以「本地第 N 个块对应远端哪个块」**只能靠内容指纹来对齐**。这是整个算法的出发点。

### 5.2 块指纹

```
fingerprint(block) = sha256(
    block_type
  + "\n" + normalized_text(block)      // 文本 trim、连续空白归一
  + "\n" + style_signature(block)      // bold/italic/link/对齐/代码语言等
  + "\n" + children_fingerprints       // 递归，用于表格/Callout 等容器块
)
```

要点：
- **必须包含样式**。否则「加粗了某个词」会被判成「没变」而漏掉。
- **容器块递归**。表格的指纹要含单元格内容，否则改表格内容不会被检出。
- **归一化要保守**。归一化过度会造成「明明变了却判为没变」的静默漏更——这比误报严重得多。

### 5.3 序列对齐（三级策略）

把「远端一级块指纹序列」`R[]` 与「本地新块指纹序列」`L[]` 对齐：

**第一级：精确匹配（LCS）**
用最长公共子序列找指纹完全相同的块。命中的块 → **保留，不发任何请求，`block_id` 与评论都不动**。LCS 天然处理了插入、删除、移动。

**第二级：结构配对（在 LCS 留下的空隙里）**
LCS 会把「改了一个字的块」判成「删一个 + 加一个」。但飞书支持 `batch_update` 直接改文本且 **`block_id` 不变 → 评论保留**。所以要在空隙里把它们认回来：

> 在同一个空隙中，若「待删序列」与「待增序列」**长度相同**且**逐个 `block_type` 相同** → 一一配对为 **UPDATE**。

**第三级：相似度兜底**
对长度不同的空隙，按文本相似度（编辑距离比 ≥ 0.5）且类型相同做贪心配对 → **UPDATE**。阈值以下的保持为独立的 DELETE / INSERT。

**剩余**：只在远端有的 → DELETE；只在本地有的 → INSERT。

### 5.4 写入顺序（索引会错位，顺序必须对）

飞书的三个约束共同决定了写入顺序：

1. `batch_delete` 用的是 **`start_index` / `end_index` 索引范围**（左闭右开），不是 block_id 列表。
2. `descendant` 的 `index` 是**父块子块列表中的插入位置**。
3. 两者都会改变后续块的位置。

**因此：倒序处理变化段，段内先删后插。**

```
① 先做全部 batch_update
   └─ update 不改索引，可以安全地先做完（这也是它优先级最高的原因：
      既保 block_id 又不动索引，一举两得）

② 把剩余的变化点按 LCS 保留块切分成「变化段」：
   保留块天然把文档分成若干连续区间，每个区间 = 一段删除 + 一段插入

③ 从【最后一个变化段】开始，向前逐个处理：
     段内：先 batch_delete(start_index, end_index)
           再 descendant(index=<该段起始位置>)
   └─ 倒序的意义：处理后面的段不会让前面段的索引失效
```

**举例**

```
远端一级块:  [R0] [R1] [R2] [R3] [R4]      （索引 0..4）
本地新块:    [L0] [L1] [L2] [L3] [L4] [L5]

LCS 精确匹配: R0↔L0（索引 0），R3↔L4（索引 3→4）
变化段1: 远端 [1,2] ↔ 本地 [1,2,3]
变化段2: 远端 [4,4] ↔ 本地 [5,5]

处理顺序：
  段2 → delete(4,5)  然后 insert at 4     ← 先做后面的
  段1 → delete(1,3)  然后 insert at 1     ← 段1 的索引未受段2 影响 ✓
```

若段1 先处理，删掉索引 1~2 后段2 的索引 4 就已经失效了。

### 5.5 分片与限制

| 操作 | 上限 | 应对 |
|---|---|---|
| `batch_update` requests | **200**（同一 block_id 不可重复） | 分片 |
| `descendant` children_id / descendants | **1000** | 分片，注意「只写第一级子块，不写子块的子块」，否则 `1770006` |
| `batch_delete` | 按索引范围，无明确条数上限但受 3 次/秒 约束 | 变化段过大时切分 |
| 单文档总块数 | 20,000 | 超了报 `1770004`，需在本地拒绝并告警 |

### 5.6 表格与图片（两个必须写死的前置处理）

**表格**：`convert` 返回的 Table 块带 `merge_info` 字段，而它是**只读**的，插入前**必须递归剥掉**，否则稳定报错。

**图片**：Markdown 里的图片链接不会自动上传。三步链的**顺序不可调换**：

```
① convert
② descendant 插入 → 响应返回 block_id_relations（临时 ID → 真实 block_id）
③ 才轮到图片：
   POST /drive/v1/medias/upload_all
        parent_type = docx_image
        parent_node = <该 Image 块的 block_id>     ← 依赖 ② 的结果
   → PATCH batch_update  requests[].replace_image = { token }
```

先传图会因为没有 Image BlockID 而报 `1770013`。

**图片去重的优化**：账本记录「本地图片相对路径 → 飞书素材 token」。路径与内容哈希都没变时**跳过上传**（素材上传有 **10000 次/天** 硬限，图多的库必须省）。

---

## 6. 账本

`.feishu-sync/ledger.json`，随仓库走版本控制。

```jsonc
{
  "version": 1,
  "space_id": "7524100000000000001",
  "documents": {
    "docs/specs/01-domain.md": {
      "node_token": "wikcnAbc...",          // 决定 URL，绝不轻易改
      "obj_token": "doxcnXyz...",           // 真实 document_id，读写内容用它
      "title": "01-domain",                 // 认领时的标题，用于漂移检测
      "claimed_by": "title",                // title | manual
      "local_sha256": "9f2c...",            // 本地 md 内容哈希
      "remote_raw_sha256": "3a1b...",       // 远端 raw_content 哈希（快路径用）
      "remote_revision_id": 4821,           // 上次同步后的远端 revision
      "blocks": [                            // base 快照，指纹序列
        { "block_id": "doxcnA1", "type": 3, "fp": "11ab..." },
        { "block_id": "doxcnA2", "type": 2, "fp": "22cd..." }
      ],
      "images": {                            // 图片素材复用
        "assets/flow.png": { "sha256": "7c3d...", "token": "ZTEy..." }
      },
      "last_synced_at": "2026-09-30T12:00:00Z"
    }
  },
  "aliases": {                               // 手工认领登记，处理重命名
    "docs/specs/old-name.md": "wikcnAbc..."
  }
}
```

**账本的三条纪律**

1. **原子写**：先写临时文件再 rename，避免半截账本。崩溃后最多重复一次幂等操作。
2. **写盘时机**：**每篇文档写入成功后立即落盘**，而不是整批结束后统一落盘。否则中途失败会丢掉已成功部分的记录，下次重跑重复劳动。
3. **单文件对应单节点**：账本里同一个 `node_token` 不得被两个路径引用。加载时校验，违反则退出码 2。

**漂移检测**：同步前比对「远端当前 `revision_id`」与账本里的 `remote_revision_id`。不一致说明上次同步后**有人在知识库里改过**。此时：
- `--force` 未给 → 报错退出码 3，打印该文档与差异块数；
- 给了 → 覆盖，并在报告中标记「已覆盖人工修改」。

这条不能省。没有它，同步工具会静默吃掉同事在知识库里的手工修正。

---

## 7. 首次认领与消歧

```
认领流程（账本中无该路径时）：
  1. 列举 parent_node_token 子树下的所有节点
       GET /wiki/v2/spaces/{space_id}/nodes?parent_node_token=xxx&page_size=50
       分页拉完（注意：单父节点下子节点上限 2000）
  2. 建立 title → [node_token] 索引（title 做 trim + 全角半角归一）
  3. 用文件名（去 .md 扩展名，或 front-matter.title）查索引
       命中 1 个 → 认领，写账本，printed "认领 docs/specs/01-domain.md → wikcnAbc"
       命中 0 个 → on_missing=create ? 新建节点 : 退出码 3
       命中 ≥2 个 → 退出码 3，打印全部候选（node_token + 创建时间 + URL）
                     供人用 --adopt 指定
```

**为什么默认 `on_ambiguous: fail` 而不是自动选一个**：选错会覆盖掉另一个团队正在维护的文档，而这种错误**不会报错、只会静默发生**，等发现时数据已经丢了。宁可停下来问人。

**`--reclaim` 的用途**：账本损坏、或大批文档被重建导致 `node_token` 全部失效时，重新按标题认领。

---

## 8. 边界情况清单

实现时逐条对照，这些是实测最容易出问题的地方。

| # | 情况 | 期望行为 |
|---|---|---|
| 1 | 本地文件无变化 | 快路径命中，1 次读，0 写，退出码 0 |
| 2 | 远端被人改过 | 退出码 3，**不覆盖**，除非 `--force` |
| 3 | 同名文档多个 | 退出码 3，列候选，不猜 |
| 4 | 远端无同名文档 | `on_missing=create` 建节点；否则退出码 3 |
| 5 | 本地文档超过 20000 块 | 本地拒绝，退出码 1，提示拆分 |
| 6 | 文档含飞书特有块（Callout/画板） | **本方案无法生成它们**，但远端可能被人插入 → diff 时会判为 DELETE。需在报告中显式提示「将删除 N 个非 Markdown 块」并要求 `--force` |
| 7 | md 里有本地图片路径 | 上传素材 + `replace_image`；账本命中则跳过上传 |
| 8 | md 里有远程图片 URL | 保持链接文本，不上传（飞书不会自动抓取外链图片） |
| 9 | 表格超过 9 行 | 必须走 `descendant`（`创建块` 接口 `row_size` 上限 9） |
| 10 | 本地文件被删除 | `on_delete=deprecate`：标题加 `[已废弃]` 前缀 + 移入归档节点 |
| 11 | 本地文件被重命名 | 视为「新建 + 废弃旧的」；提供 `aliases` 手工认领 |
| 12 | 写入过程中被人工并发编辑 | 飞书返回 409 → 重取 revision 重试，3 次后转退出码 3 |
| 13 | 命中 `99991400` 限流 | 读 `x-ogw-ratelimit-reset` 头退避重试 |
| 14 | 命中 `99991403` 配额耗尽 | **不重试**，立即退出码 4 并告警 |
| 15 | 网络中断 | 账本已逐篇落盘，重跑只处理剩余部分 |

> 第 6 条值得单独强调：**人工在知识库文档里插入的高亮块、画板、分屏，在块级 diff 中会表现为「远端有、本地没有」→ 被判为删除。** 这是单向覆盖语义的必然结果，不是 bug。但如果没人提示，同事会发现自己的排版被无声抹掉。所以默认应在有非 Markdown 块时**要求显式确认**。

---

## 9. 限流与错误处理

| 接口类别 | 限制 | 策略 |
|---|---|---|
| 写类（创建/嵌套/更新/批更/删除块） | **单应用 3 次/秒** | 全局令牌桶 |
| 单篇文档并发编辑 | **3 次/秒**（跨所有写操作） | 每文档独立令牌桶，与全局取小 |
| 读类（文档信息/所有块/子块） | 5 次/秒 | 全局令牌桶 |
| Wiki 接口 | 100 次/分 | 令牌桶 |
| 素材上传 | 5 QPS、**10000 次/天** | 令牌桶 + 日计数持久化到账本 |

**退避策略**：指数退避 + 抖动，上限 60 秒，最大 5 次。命中 `99991400` 时优先读 `x-ogw-ratelimit-reset` 响应头的值。

**不可重试的错误**（重试只会继续烧配额或必然失败）：`99991403`（配额耗尽）、`131006`（权限）、`1770033`（内容超限）、`1069909`（文件超限）。

**配额预算**：飞书免费版 **100 万次/月**，文档/drive/wiki 接口全部计入。

单篇文档稳态开销（已同步、无变化）≈ **1 次调用**（`raw_content`）。
有变化时 ≈ 1 读 + 1 convert + 1 descendant + N 次 update + 图片数。

→ 1000 篇文档每轮全扫 = 1000 次调用。**每天跑 1 轮 ≈ 3 万次/月，安全；每 5 分钟一轮 ≈ 864 万次/月，超限 8 倍。**
→ **定时频率必须按文档规模定，不能拍脑袋。** 建议：靠账本 `last_synced_at` 做 LRU，每轮只处理「最久未检查」的一批。

> 注意：与全量替换相比，块级增量**并不省调用量**（都是 1 update/delete + 1 convert + 1 descendant），它的价值**纯粹是保评论**。不要指望它降配额。

---

## 10. 验收判据

实现完成后逐条验证，这些是「做对了没有」的判据：

| # | 判据 | 验证方法 |
|---|---|---|
| 1 | 重复执行零副作用 | 连续跑两次 `sync`，第二次必须 0 写请求、退出码 0 |
| 2 | 未变块评论保留 | 在远端给某块加评论 → 同步 → 评论还在 |
| 3 | 改动块评论保留 | 给某块加评论 → 改该块文本 → 同步 → 评论还在 |
| 4 | URL 稳定 | 同步前后 `node_token` 不变，链接可访问 |
| 5 | 索引不错位 | 构造「文首插入 + 文末删除 + 中间修改」的用例，结果与本地 md 逐块一致 |
| 6 | 表格正确 | 含 >9 行表格的文档同步后结构与内容正确 |
| 7 | 图片正确 | 含 3 张图的文档同步后图片可见；重跑不重复上传 |
| 8 | 漂移保护 | 手工改远端 → 同步必须拒绝并退出码 3 |
| 9 | 同名歧义 | 造两个同名节点 → 退出码 3 且列出两个候选 |
| 10 | 限流正确 | 压测连续写，不出现 `99991400` |
| 11 | 崩溃恢复 | 同步中途 Ctrl+C → 重跑不重复已完成的文档 |
| 12 | 非 Markdown 块告警 | 远端插入 Callout → 同步要求显式确认 |

第 3 条和第 5 条是最容易做错的两条，优先写测试。

---

## 11. 落地顺序

```
① fws init --check                     ← 先把权限双门禁跑通（最易卡住）
② fws status                           ← 只读，确认扫描与账本正确
③ fws sync --dry-run                   ← 确认变更清单符合预期
④ 单文件打通：fws sync docs/specs/01-domain.md
     先测「无变化跳过」→ 再测「整篇替换」→ 最后测「中间插入/删除」
⑤ 补块级 diff 的三级对齐，用 §10 验收判据 3、5 验证
⑥ 图片与表格（用含图和表的真实文档）
⑦ 漂移保护与退出码
⑧ 全量 + 定时（频率按 §9 的配额预算定）
```

第 ④ 步的「先全量替换再优化成块级 diff」是刻意的：先让整条链路（认证 → 认领 → convert → 写入）跑通，再在**已验证的骨架**上换 diff 算法。反过来先写 diff 算法，一旦出问题会分不清是 diff 错了还是 API 调用错了。

---

## 附：核心 API 速查

```
# 鉴权
POST /open-apis/auth/v3/tenant_access_token/internal      app_id + app_secret

# 知识库
GET  /open-apis/wiki/v2/spaces/{space_id}/nodes           列举子节点（认领用）
GET  /open-apis/wiki/v2/spaces/get_node?token=&obj_type=  反查节点
POST /open-apis/wiki/v2/spaces/{space_id}/nodes           创建节点（不传 obj_token 则自动建空文档）
POST /open-apis/wiki/v2/spaces/{space_id}/nodes/{node_token}/update_title
POST /open-apis/wiki/v2/spaces/{space_id}/nodes/{node_token}/move

# 文档块
GET   /open-apis/docx/v1/documents/{doc}/raw_content      纯文本（快路径探针）
GET   /open-apis/docx/v1/documents/{doc}/blocks           全部块（page_size ≤500，需分页）
POST  /open-apis/docx/v1/documents/blocks/convert         md → 块
POST  /open-apis/docx/v1/documents/{doc}/blocks/{parent}/descendant   批量插入（≤1000）
PATCH /open-apis/docx/v1/documents/{doc}/blocks/batch_update          批量更新（≤200）
DELETE /open-apis/docx/v1/documents/{doc}/blocks/{id}/children/batch_delete  按索引范围删

# 素材
POST /open-apis/drive/v1/medias/upload_all                parent_type=docx_image
```
