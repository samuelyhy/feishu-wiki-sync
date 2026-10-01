/**
 * 命令面的**单一真相源**。
 *
 * `bin/cli.ts` 的参数解析与 `--help` 文本都由这里生成，
 * `tests/docs-drift.test.ts` 则用它来断言 `命令手册.md` 没有腐烂。
 *
 * 手维护的命令清单一定会烂：改了代码忘了改文档，而文档看起来仍然是对的。
 * 让文档和实现都从同一份数据出发，这条漂移就没了发生的机会。
 */

export type FlagType = 'string' | 'boolean';

export interface FlagSpec {
  name: string;
  type: FlagType;
  desc: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  /** 位置参数的说明；没有位置参数的命令留空 */
  positionals?: string;
  flags: FlagSpec[];
  /** 手册里该命令的章节锚点用的标题，与 `### fws <name>` 对应 */
}

/** 所有命令都支持的开关。 */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: 'cwd', type: 'string', desc: '指定工程根目录（默认当前目录）' },
  { name: 'json', type: 'boolean', desc: '以 JSON 输出结果到 stdout（人类可读日志改走 stderr）' },
  { name: 'verbose', type: 'boolean', desc: '输出逐项详情' },
];

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'init',
    summary: '采集凭证、生成配置骨架、校验知识库权限',
    flags: [
      { name: 'app-id', type: 'string', desc: '飞书自建应用 App ID，写入 .ai-sync.env' },
      { name: 'app-secret', type: 'string', desc: '飞书自建应用 App Secret，写入 .ai-sync.env' },
      { name: 'space-id', type: 'string', desc: '知识空间 ID，写入配置骨架' },
      { name: 'parent-node-token', type: 'string', desc: '目标父节点 node_token，写入配置' },
      { name: 'list-nodes', type: 'boolean', desc: '列出知识空间的顶级节点' },
      { name: 'check', type: 'boolean', desc: '联网校验空间可达、各父节点存在且应用有权限' },
    ],
  },
  {
    name: 'doctor',
    summary: '体检：逐项验证凭证、权限、转换与写入链路（部署前跑一次）',
    flags: [
      {
        name: 'write',
        type: 'boolean',
        desc: '额外验证写入链路；会在知识库里创建一篇验证文档（飞书无删除节点 API，需手工删除）',
      },
    ],
  },
  {
    name: 'pull',
    summary: '拉取远端与本地对比（git 语义）：谁领先、谁新增、哪里冲突',
    positionals: '[路径...]',
    flags: [
      { name: 'write', type: 'boolean', desc: '把远端领先/远端新增的文档写入本地（默认只报告）' },
    ],
  },
  {
    name: 'status',
    summary: '只读：查看哪些文件未认领 / 已修改 / 远端有漂移',
    positionals: '[路径...]',
    flags: [{ name: 'remote', type: 'boolean', desc: '额外检查远端是否被人改过（每篇 1 次读请求）' }],
  },
  {
    name: 'sync',
    summary: '执行同步（块级增量更新，保留评论）',
    positionals: '[路径...]',
    flags: [
      { name: 'dry-run', type: 'boolean', desc: '只扫描与比对，不写入任何内容（也不会创建节点）' },
      { name: 'force', type: 'boolean', desc: '覆盖「远端被人修改过」的文档；默认拒绝并跳过' },
      { name: 'reclaim', type: 'boolean', desc: '忽略账本，重新按标题认领（用于账本损坏后重建）' },
      {
        name: 'allow-destructive',
        type: 'boolean',
        desc: '授权破坏性变更（清空远端 / 大规模删除 / 首次纳管非空文档）；默认一律拦截',
      },
    ],
  },
];

/** 进程退出码契约。调用方（CI、包装脚本）依赖这些数字，改动即破坏性变更。 */
export const EXIT_CODE_DOCS: ReadonlyArray<{ code: number; meaning: string; action: string }> = [
  { code: 0, meaning: '全部成功（含「无变更」）', action: '—' },
  { code: 1, meaning: '有文档同步失败', action: '重跑常能自愈' },
  { code: 2, meaning: '配置错误', action: '改配置或凭证' },
  { code: 3, meaning: '需人工处理（同名歧义 / 冲突 / 远端漂移）', action: '必须人介入' },
  { code: 4, meaning: 'API 配额耗尽', action: '本月别再跑了' },
];

export function commandByName(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** 某命令实际接受的开关 = 全局开关 + 该命令自己的。 */
export function flagsFor(name: string): readonly FlagSpec[] {
  const cmd = commandByName(name);
  return [...GLOBAL_FLAGS, ...(cmd?.flags ?? [])];
}
