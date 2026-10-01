import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigError } from '../errors.js';

export const CONFIG_DIR = '.feishu-sync';
export const CONFIG_FILE = 'config.yaml';
export const LEDGER_FILE = 'ledger.json';

export type OnMissing = 'create' | 'fail';
/** 同名多个时的处置。**只有 `fail`** —— 见 loadConfig 里的说明。 */
export type OnAmbiguous = 'fail';

export interface Mapping {
  /** 本地目录，相对工程根 */
  source: string;
  /** 目标知识库父节点 */
  parentNodeToken: string;
  include: string[];
  exclude: string[];
  onMissing: OnMissing;
  onAmbiguous: OnAmbiguous;
}

export interface SyncConfig {
  version: number;
  spaceId: string;
  baseUrl?: string;
  mappings: Mapping[];
}

interface RawDefaults {
  include?: string[];
  exclude?: string[];
  nesting?: string;
  on_missing?: string;
  on_ambiguous?: string;
  on_delete?: string;
}

interface RawMapping extends RawDefaults {
  source?: string;
  parent_node_token?: string;
}

interface RawConfig {
  version?: number;
  space_id?: string;
  base_url?: string;
  archive_node_token?: string;
  defaults?: RawDefaults;
  mappings?: RawMapping[];
}

export function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR, CONFIG_FILE);
}

export function ledgerPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR, LEDGER_FILE);
}

export function loadConfig(cwd: string): SyncConfig {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    throw new ConfigError(
      `未找到配置文件 ${CONFIG_DIR}/${CONFIG_FILE}`,
      '执行 `fws init` 生成配置骨架',
    );
  }

  let raw: RawConfig;
  try {
    raw = (parseYaml(fs.readFileSync(file, 'utf8')) ?? {}) as RawConfig;
  } catch (err) {
    throw new ConfigError(
      `${CONFIG_DIR}/${CONFIG_FILE} 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  rejectUnimplemented(raw);

  const defaults: RawDefaults = raw.defaults ?? {};
  const config: SyncConfig = {
    version: raw.version ?? 1,
    spaceId: String(raw.space_id ?? ''),
    ...(raw.base_url ? { baseUrl: raw.base_url } : {}),
    mappings: (raw.mappings ?? []).map((m) => ({
      source: normalizeRel(m.source ?? ''),
      parentNodeToken: String(m.parent_node_token ?? ''),
      include: m.include ?? defaults.include ?? ['**/*.md'],
      exclude: m.exclude ?? defaults.exclude ?? [],
      onMissing: pickEnum(m.on_missing ?? defaults.on_missing, ['create', 'fail'], 'create'),
      onAmbiguous: 'fail' as const,
    })),
  };

  validateConfig(config);
  return config;
}

/**
 * 拒绝所有「解析了但不生效」的配置项。
 *
 * 静默 no-op 是本工具最不能接受的缺陷类型：用户配了 `nesting: mirror`
 * 以为会有目录层级，实际全部平铺；或者配了 `on_delete: deprecate` 以为
 * 删除会被归档，实际什么都不做 —— 两者都不报错。
 *
 * 宁可启动就失败，也不要让人以为配了就管用。加载时拒绝，退出码 2。
 */
function rejectUnimplemented(raw: RawConfig): void {
  const problems: string[] = [];

  const keys = (m: RawDefaults): string[] =>
    [m.nesting !== undefined ? `nesting: ${m.nesting}` : null, m.on_delete !== undefined ? `on_delete: ${m.on_delete}` : null]
      .filter((x): x is string => x !== null);

  problems.push(...keys(raw.defaults ?? {}).filter((k) => !k.startsWith('nesting: flat')));
  for (const m of raw.mappings ?? []) {
    problems.push(...keys(m).filter((k) => !k.startsWith('nesting: flat')));
  }

  // nesting: flat 与当前行为一致，允许保留（老配置不必改）；
  // 但 mirror 会被静默当成 flat，必须拦下。
  for (const m of raw.mappings ?? []) {
    if (m.nesting === 'mirror') problems.push(`nesting: mirror（source=${m.source ?? '?'}）`);
  }

  if (raw.archive_node_token !== undefined) problems.push('archive_node_token');

  // 去重后报出
  const unique = [...new Set(problems)];
  if (unique.length > 0) {
    throw new ConfigError(
      `以下配置项尚未实现，配了也不会生效：${unique.join('、')}`,
      '请从配置中删除它们。当前行为是固定的：文档全部平铺在父节点下，本地删除的文件不做处理',
    );
  }

  // on_ambiguous 只支持 fail。'newest' 曾经存在，但它按 API 返回顺序取最后一个，
  // 并不是按时间取最新 —— 一个不按自己名字行事、还会静默覆盖别人文档的选项，
  // 比没有这个选项更糟。
  const amb = raw.defaults?.on_ambiguous;
  if (amb !== undefined && amb !== 'fail') {
    throw new ConfigError(
      `on_ambiguous: ${amb} 不再支持`,
      '同名文档多个时只支持 fail（停下来让人处理）。自动挑选会静默覆盖别人的文档',
    );
  }
  for (const m of raw.mappings ?? []) {
    if (m.on_ambiguous !== undefined && m.on_ambiguous !== 'fail') {
      throw new ConfigError(`on_ambiguous: ${m.on_ambiguous} 不再支持（source=${m.source ?? '?'}）`);
    }
  }
}

/**
 * 静态校验（不联网）。
 *
 * 联网验活（节点是否存在、应用有无权限）在 `init --check` 里单独做 ——
 * 把网络校验塞进 loadConfig 会让每个命令都必须联网才能启动，
 * 连 `--dry-run` 都跑不了。
 */
export function validateConfig(config: SyncConfig): void {
  if (config.version !== 1) {
    throw new ConfigError(`不支持的配置版本: ${config.version}`, '当前仅支持 version: 1');
  }
  if (!config.spaceId) {
    throw new ConfigError('配置缺少 space_id', `在 ${CONFIG_DIR}/${CONFIG_FILE} 中填写知识空间 ID`);
  }
  if (config.mappings.length === 0) {
    throw new ConfigError('配置中没有 mappings', '至少配置一个 source → parent_node_token 的映射');
  }

  const usedParents = new Map<string, string>();
  for (const m of config.mappings) {
    if (!m.source) throw new ConfigError('mapping 缺少 source');
    if (!m.parentNodeToken) {
      throw new ConfigError(
        `mapping ${m.source} 缺少 parent_node_token`,
        '用 `fws status` 列出目标父节点下的现有节点，确认 token 正确',
      );
    }
    if (m.source.startsWith('..') || path.isAbsolute(m.source)) {
      throw new ConfigError(
        `mapping source 必须是工程内的相对路径: ${m.source}`,
      );
    }

    // 防「两份本地文件抢同一个远端文档」——这种冲突表现为两台机器互相覆盖，
    // 且不会报任何错，等发现时内容已经来回丢过好几轮了。
    const prev = usedParents.get(m.parentNodeToken);
    if (prev) {
      throw new ConfigError(
        `parent_node_token ${m.parentNodeToken} 被 ${prev} 与 ${m.source} 同时使用`,
        '每个父节点只能对应一个 source 目录，否则两份文档会互相覆盖',
      );
    }
    usedParents.set(m.parentNodeToken, m.source);
  }

  // 这里**不再**一律拒绝嵌套的 source。
  //
  // 早先的规则是「两个 source 不得互为父子路径」，理由是「嵌套会让同一个文件
  // 被两个 mapping 处理」。但那条规则把**安全**的配置也一并拒了：
  //
  //   - source: products       include: ["*.md"]     ← 只吃根层的文件
  //   - source: products/01-A                          ← 吃子目录
  //
  // 两者匹配的文件集**完全不相交**，却因为路径嵌套被判为非法。
  //
  // 真正要防的是「同一文件被处理两次」，而那可以精确检查 —— 扫描一遍、
  // 看有没有文件的归属超过一个 mapping（见 scanner.ts 的 assertNoOverlap）。
  // 精确检查比路径形态的启发式更准，也不会误伤合法配置。
}

export function writeDefaultConfig(cwd: string, spaceId: string): string {
  const dir = path.join(cwd, CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(cwd);

  if (fs.existsSync(file)) return file;

  // 只生成**真正生效**的配置项。未实现的项（nesting / on_delete /
  // archive_node_token / on_ambiguous: newest）一律不写进骨架 ——
  // 生成器写进去等于教用户以为自己配了。
  const skeleton = {
    version: 1,
    space_id: spaceId || '<填写知识空间 ID>',
    defaults: {
      include: ['**/*.md'],
      exclude: ['**/releases/**', '**/*.draft.md'],
      on_missing: 'create',
    },
    mappings: [
      {
        source: 'docs/specs',
        parent_node_token: '<填写目标父节点 node_token>',
      },
    ],
  };

  fs.writeFileSync(file, stringifyYaml(skeleton), 'utf8');
  return file;
}

/** 保证 `fws` 的运行态目录存在。 */
export function ensureConfigDir(cwd: string): string {
  const dir = path.join(cwd, CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
