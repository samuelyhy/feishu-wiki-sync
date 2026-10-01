import { ExitCode, FeishuApiError, friendlyMessage } from '../errors.js';
import { extractImageRefs } from '../core/scanner.js';
import { buildTreeFromConvert, imageBlockIdsInOrder } from '../core/tree.js';
import { blockTypeName } from '../core/blocks.js';
import type { AppContext } from '../context.js';
import { color, type Logger } from '../logger.js';

/**
 * `fws doctor` —— 把「未经验证的假设」变成可执行的检查。
 *
 * ## 为什么需要它
 *
 * 这个工具的全部逻辑都建立在若干条**无法从官方文档确证**的假设上
 * （远程图片是否生成 Image 块、convert 的频控等级、tenant token 能否写入…）。
 * 在拿到真实凭证之前，它们既不能被证实也不能被证伪，只能被标成「未确认」。
 *
 * 而「未确认」在实践中等于「上线后才发现」。这个命令把每一条假设
 * 变成一次真实调用 + 一句判读，让人在**部署前**就能把关。
 *
 * ## 设计原则
 *
 * - **每一项独立成败**：一项失败不影响后面的检查，一次跑完拿到全貌。
 * - **只读默认**：写操作（会创建真实文档）必须显式加 `--write`。
 * - **失败必须给「怎么办」**：只说「权限不足」没有用，要说清去哪个后台开什么。
 */
export interface DoctorOptions {
  write: boolean;
  json: boolean;
  verbose: boolean;
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  /** 这一项验证的是哪条假设 —— 让人知道它为什么存在 */
  assumption?: string;
}

/**
 * 转换用样本：覆盖所有我们声称支持的 Markdown 元素。
 *
 * 末尾的**远程图片**是关键：它决定「按位置配对」这个算法前提能不能成立。
 */
const CONVERT_SAMPLE = [
  '# 一级标题',
  '',
  '普通段落，含**加粗**与 `行内代码`。',
  '',
  '- 无序项一',
  '- 无序项二',
  '',
  '1. 有序项一',
  '2. 有序项二',
  '',
  '> 引用段落',
  '',
  '```python',
  'print("hello")',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '![远程图片](https://example.com/placeholder.png)',
].join('\n');

const WRITE_PROBE_MARKDOWN = ['# fws doctor 验证文档', '', '这一行由 fws doctor 写入。'].join('\n');

export async function runDoctor(ctx: AppContext, options: DoctorOptions): Promise<number> {
  const checks: DoctorCheck[] = [];

  checks.push(checkConfig(ctx));
  checks.push(await checkCredentials(ctx));
  checks.push(await checkSpace(ctx));

  const parentChecks = await checkParents(ctx);
  checks.push(...parentChecks);

  const convertCheck = await checkConvert(ctx);
  checks.push(convertCheck);

  if (options.write) {
    checks.push(...(await checkWritePath(ctx, options)));
  } else {
    checks.push({
      name: '写入链路',
      status: 'skipped',
      detail: '未测试（加 --write 启用；会在知识库里创建一篇可手动删除的验证文档）',
      assumption: 'tenant_access_token 能否真正写入知识库文档（**这是最关键的一条**）',
    });
  }

  render(checks, ctx.logger, options);

  if (checks.some((c) => c.status === 'fail')) return ExitCode.SYNC_FAILED;
  if (checks.some((c) => c.status === 'warn')) return ExitCode.AMBIGUOUS;
  return ExitCode.OK;
}

// ─────────────────────────── 各项检查 ───────────────────────────

function checkConfig(ctx: AppContext): DoctorCheck {
  const sources = ctx.config.mappings.map((m) => m.source).join('、');
  return {
    name: '配置',
    status: 'ok',
    detail: `${ctx.config.mappings.length} 个 mapping：${sources}；space_id=${ctx.config.spaceId}`,
  };
}

async function checkCredentials(ctx: AppContext): Promise<DoctorCheck> {
  if (!ctx.auth) {
    return {
      name: '凭证',
      status: 'skipped',
      detail: '离线模式，未检查',
    };
  }
  try {
    const seconds = await ctx.auth.probe();
    return {
      name: '凭证',
      status: 'ok',
      detail: `tenant_access_token 获取成功，有效期 ${seconds} 秒`,
    };
  } catch (err) {
    return {
      name: '凭证',
      status: 'fail',
      detail: friendlyMessage(err),
      hint:
        '核对 .ai-sync.env 里的 FEISHU_APP_ID / FEISHU_APP_SECRET，' +
        '并确认应用已**发布版本**（未发布时权限与凭证都不生效）',
    };
  }
}

async function checkSpace(ctx: AppContext): Promise<DoctorCheck> {
  try {
    const nodes = await ctx.wiki.listChildren(ctx.config.spaceId);
    return {
      name: '知识空间',
      status: 'ok',
      detail: `可访问，顶级节点 ${nodes.length} 个`,
    };
  } catch (err) {
    return {
      name: '知识空间',
      status: 'fail',
      detail: friendlyMessage(err),
      hint: explainPermissionError(err, [
        '确认 space_id 正确（知识库设置页面地址栏里的数字部分）',
        '确认已开通 wiki:wiki scope 并**发布应用版本**',
      ]),
    };
  }
}

async function checkParents(ctx: AppContext): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];

  for (const mapping of ctx.config.mappings) {
    const name = `父节点 ${mapping.source}`;
    try {
      const node = await ctx.wiki.getNode(mapping.parentNodeToken);
      if (!node) {
        out.push({
          name,
          status: 'fail',
          detail: `parent_node_token ${mapping.parentNodeToken} 查不到`,
          hint: '用 `fws init --list-nodes` 列出可选节点，确认 token 是否抄错或节点已被删除',
        });
        continue;
      }
      const children = await ctx.wiki.listChildren(ctx.config.spaceId, mapping.parentNodeToken);
      out.push({
        name,
        status: 'ok',
        detail: `→「${node.title}」（现有子节点 ${children.length} 个）`,
      });
    } catch (err) {
      out.push({
        name,
        status: 'fail',
        detail: friendlyMessage(err),
        hint: explainPermissionError(err, [
          '把「包含应用机器人的群」加为知识空间管理员（成员设置 → 添加管理员）',
          '仅申请 API scope 是不够的 —— 权限是双门禁',
        ]),
      });
    }
  }

  return out;
}

/**
 * convert 检查 —— 这一项直接决定图片对齐算法是否成立。
 *
 * 我们要知道的是：`convert` 会不会为**远程 URL 图片**也生成 Image 块？
 * - 会 → 抽取到的全部图片引用与块数相等，按位置配对适用于所有引用
 * - 不会 → 只有本地图片产生块，配对必须只在本地引用之间进行
 *
 * 两种情形代码都能处理（见 syncer 里的自适应配对），但必须知道是哪一种 ——
 * 否则一旦判断错，图片会被静默挂到错误的块上。
 */
async function checkConvert(ctx: AppContext): Promise<DoctorCheck> {
  try {
    const converted = await ctx.docx.convertMarkdown(CONVERT_SAMPLE);
    const tree = buildTreeFromConvert(converted.blocks, converted.firstLevelBlockIds);
    const imageBlocks = imageBlockIdsInOrder(tree);
    const refs = extractImageRefs(CONVERT_SAMPLE);
    const localRefs = refs.filter((r) => !/^[a-z][a-z0-9+.-]*:/i.test(r));

    const types = new Map<number, number>();
    for (const b of converted.blocks) {
      types.set(b.block_type, (types.get(b.block_type) ?? 0) + 1);
    }
    const typeList = [...types.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, n]) => `${blockTypeName(t)}×${n}`)
      .join('、');

    const detail = `返回 ${converted.blocks.length} 个块（${typeList}）；图片块 ${imageBlocks.length} 个，样本中图片引用 ${refs.length} 个（本地 ${localRefs.length} 个）`;
    const assumption = 'convert 返回的块结构，以及远程图片是否生成 Image 块（决定图片对齐方式）';

    if (imageBlocks.length === refs.length) {
      return {
        name: '转换',
        status: 'ok',
        detail: `${detail}\n→ 远程图片**会**生成 Image 块，按位置配对适用于全部图片引用`,
        assumption,
      };
    }
    if (imageBlocks.length === localRefs.length) {
      return {
        name: '转换',
        status: 'ok',
        detail: `${detail}\n→ 远程图片**不**生成 Image 块，配对只在本地图片之间进行`,
        assumption,
      };
    }
    return {
      name: '转换',
      status: 'warn',
      detail: `${detail}\n→ 两者都对不上，含图片的文档将无法配对`,
      hint:
        '这通常意味着样本里的某种写法不被支持。含图片的文档在同步时会明确报错（而不是静默错位）；' +
        '若你的文档里实际没有图片，可以忽略这条',
      assumption,
    };
  } catch (err) {
    return {
      name: '转换',
      status: 'fail',
      detail: friendlyMessage(err),
      hint: explainPermissionError(err, [
        '确认已开通 docx:document.block:convert scope 并发布应用版本',
      ]),
      assumption: 'convert 接口可用',
    };
  }
}

/**
 * 写入链路检查 —— **全案最关键的一条**。
 *
 * 社区有实践记录称 tenant_access_token 根本写不了知识库、必须用 user token。
 * 官方文档则说除「创建知识空间」与「搜索 Wiki」外都支持 tenant token。
 * 两者矛盾，只能在真实租户上判定。这一项就是那把尺子。
 */
async function checkWritePath(ctx: AppContext, options: DoctorOptions): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const mapping = ctx.config.mappings[0];
  if (!mapping) {
    return [{ name: '写入链路', status: 'skipped', detail: '没有 mapping 可测' }];
  }

  let nodeToken = '';
  let objToken = '';

  try {
    const node = await ctx.wiki.createNode({
      spaceId: ctx.config.spaceId,
      objType: 'docx',
      parentNodeToken: mapping.parentNodeToken,
      title: '[fws doctor] 可删除的验证文档',
    });
    nodeToken = node.node_token;
    objToken = node.obj_token;
    if (!objToken) {
      out.push({
        name: '写入链路 · 建节点',
        status: 'fail',
        detail: '创建节点成功但未返回 obj_token —— 「不传 obj_token 自动建空文档」的假设不成立',
        assumption: 'createNode 不传 obj_token 时自动创建空文档',
      });
      return out;
    }
    out.push({
      name: '写入链路 · 建节点',
      status: 'ok',
      detail: `已创建验证文档，node_token=${nodeToken}`,
      assumption: 'createNode 不传 obj_token 时自动创建空文档',
    });
  } catch (err) {
    out.push({
      name: '写入链路 · 建节点',
      status: 'fail',
      detail: friendlyMessage(err),
      hint: explainPermissionError(err, [
        '这是最关键的一条失败：说明当前身份无法在知识库里创建节点',
        '先确认应用已被加为知识空间管理员（把含应用机器人的群加为管理员）',
        '若确实无法解决，用 `fws doctor --json` 的结果去对照飞书开发者后台的 console_url 提示',
      ]),
      assumption: 'tenant_access_token 能否写入知识库（社区与官方文档说法冲突）',
    });
    return out;
  }

  // 写正文
  try {
    const converted = await ctx.docx.convertMarkdown(WRITE_PROBE_MARKDOWN);
    const tree = buildTreeFromConvert(converted.blocks, converted.firstLevelBlockIds);
    await ctx.docx.createDescendant({
      documentId: objToken,
      parentBlockId: objToken,
      childrenId: tree.topLevel,
      descendants: converted.blocks as unknown[],
      index: 0,
    });

    const readBack = await ctx.docx.listBlocks(objToken);
    const wrote = readBack.some((b) =>
      JSON.stringify(b).includes('这一行由 fws doctor 写入'),
    );

    out.push({
      name: '写入链路 · 写正文',
      status: wrote ? 'ok' : 'warn',
      detail: wrote
        ? '块已写入并读回验证成功'
        : '写入请求成功但读回没找到内容，需人工确认',
      ...(wrote
        ? {}
        : { hint: `请手工打开文档确认：node_token=${nodeToken}` }),
      assumption: 'tenant_access_token 能否写入文档正文',
    });
  } catch (err) {
    out.push({
      name: '写入链路 · 写正文',
      status: 'fail',
      detail: friendlyMessage(err),
      hint: explainPermissionError(err, [
        '节点建得出来但正文写不进去 —— 这正是社区实践记录里描述的现象',
        '若确认如此，本工具需要改用 user_access_token，那会引入 OAuth 与 365 天重授权问题',
      ]),
      assumption: 'tenant_access_token 能否写入文档正文',
    });
  }

  if (options.verbose) {
    ctx.logger.warn(
      `${color.yellow('注意')}：飞书**没有删除知识库节点的 API**，` +
        `验证文档需手工删除（在知识库里找到「[fws doctor] 可删除的验证文档」）`,
    );
  }

  return out;
}

// ─────────────────────────── 输出 ───────────────────────────

function explainPermissionError(err: unknown, extra: string[]): string {
  const lines = [...extra];
  if (err instanceof FeishuApiError) {
    if (err.code === 131006) {
      lines.unshift('错误码 131006 = 知识库权限不足：把「含应用机器人的群」加为知识空间管理员');
    } else if (err.code === 99991672) {
      lines.unshift('错误码 99991672 = 缺少 API scope：到开发者后台开通并**发布应用版本**');
    } else if (err.code === 99991403) {
      lines.unshift('错误码 99991403 = 本月 API 调用量已耗尽，需等待次月刷新或申请提额');
    }
  }
  return lines.join('\n     ');
}

const ICON: Record<CheckStatus, string> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  skipped: '·',
};

function render(checks: DoctorCheck[], logger: Logger, options: DoctorOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  }

  const paint: Record<CheckStatus, (s: string) => string> = {
    ok: color.green,
    warn: color.yellow,
    fail: color.red,
    skipped: color.dim,
  };

  const width = Math.max(...checks.map((c) => c.name.length));

  for (const check of checks) {
    const head = `${paint[check.status](ICON[check.status])} ${check.name.padEnd(width)}  ${check.detail}`;
    logger.info(head);
    if (check.hint) logger.info(`  ${color.dim('怎么办：')}${check.hint.split('\n').join('\n           ')}`);
    if (options.verbose && check.assumption) {
      logger.info(`  ${color.dim(`验证的假设：${check.assumption}`)}`);
    }
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  logger.info(
    failed > 0
      ? `\n${color.red(`${failed} 项未通过`)}${warned ? `，${warned} 项需人工确认` : ''}`
      : warned > 0
        ? `\n${color.yellow(`${warned} 项需人工确认`)}`
        : `\n${color.green('全部通过')}`,
  );
}
