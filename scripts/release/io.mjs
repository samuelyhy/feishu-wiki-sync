/**
 * 发布脚本的**副作用层**：npm、git、文件、终端。
 *
 * 所有和外部世界打交道的东西都收在这里，`preflight.mjs` / `finalize.mjs`
 * 只负责编排。好处是看编排时不必再猜「这行到底会不会改我的仓库」。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

import { normalizeVersions } from './lib.mjs';

// ─────────────────────────────────────────────────────────────
// 终端输出
// ─────────────────────────────────────────────────────────────

const COLOR =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const paint = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text));

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
};

export const log = {
  step: (i, total, text) => process.stdout.write(`\n${c.cyan('▶')} ${c.dim(`${i}/${total}`)} ${c.bold(text)}\n`),
  info: (text) => process.stdout.write(`  ${text}\n`),
  ok: (text) => process.stdout.write(`  ${c.green('✓')} ${text}\n`),
  warn: (text) => process.stdout.write(`  ${c.yellow('!')} ${text}\n`),
  note: (text) => process.stdout.write(`  ${text}\n`),
  skip: (text) => process.stdout.write(`  ${c.dim(`— ${text}`)}\n`),
};

/** 报错退出。首行说清后果，后面几行给可执行的下一步。 */
export function die(headline, details = []) {
  process.stderr.write(`\n${c.red('✗')} ${c.bold(headline)}\n\n`);
  for (const line of details) process.stderr.write(`  ${line}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// 进程
// ─────────────────────────────────────────────────────────────

/**
 * 跑一条命令。
 *
 * npm 在 Windows 上是 `npm.cmd`（一个批处理壳），直接 spawn 会 ENOENT；
 * 但走 `shell: true` 又会把参数交给 cmd.exe 重新解析一遍。
 * 最稳的是绕开壳：`npm_execpath` 指向 npm 自己的 JS 入口，
 * 用「当前 node + 那个 js」来跑，参数怎么传就怎么到。
 */
function run(command, args, { capture = true, timeout = 120_000, env } = {}) {
  const result = spawnSync(command.cmd, [...command.prefix, ...args], {
    encoding: 'utf8',
    timeout,
    shell: command.shell === true,
    // 捕获时 stderr 拿回来看，不捕获时直接透传到终端（构建、测试要实时看）
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
  });

  if (result.error) {
    return { ok: false, status: -1, stdout: '', stderr: String(result.error.message) };
  }
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.signal === 'SIGTERM' || result.signal === 'SIGKILL',
  };
}

/**
 * 怎么调用 npm。
 *
 * 优先级是有讲究的：
 *
 * 1. `npm_execpath` —— 在 npm 脚本里跑时 npm 自己会设，最准。
 * 2. node 自带的那份 npm（`node_modules/npm/bin/npm-cli.js`）—— 直接 `node
 *    那个文件`，绕开 Windows 上的 `npm.cmd` 批处理壳。用壳的话参数要交给
 *    cmd.exe 重新解析一遍，`npm view pkg@1.2.3 versions` 这种带 `@` 和引号的
 *    参数会被它改得面目全非。
 * 3. 实在找不到，才退回去用命令名 + shell。
 */
export function npmCommand() {
  const execpath = process.env.npm_execpath;
  if (execpath && fs.existsSync(execpath)) {
    return { cmd: process.execPath, prefix: [execpath] };
  }

  const bundled = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  if (fs.existsSync(bundled)) {
    return { cmd: process.execPath, prefix: [bundled] };
  }

  return {
    cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefix: [],
    shell: process.platform === 'win32',
  };
}

export function npm(args, opts) {
  return run(npmCommand(), args, { timeout: 180_000, ...opts });
}

export function git(args, opts) {
  return run({ cmd: 'git', prefix: [] }, args, { timeout: 60_000, ...opts });
}

/** npm 的错误输出很长，取第一行有效信息就够定位了。 */
export function firstErrorLine(text) {
  const line = String(text)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('npm ERR!') && l.length > 10);
  return line ? line.replace(/^npm ERR!\s*/, '') : String(text).trim().split('\n')[0] ?? '';
}

// ─────────────────────────────────────────────────────────────
// npm 侧的事实
// ─────────────────────────────────────────────────────────────

export function npmVersion() {
  const r = npm(['--version']);
  return r.ok ? r.stdout.trim() : '未知';
}

/**
 * 查当前 npm 身份。
 *
 * 刻意区分「npm 说不行」和「问不出来」：
 *
 *   - `unauthenticated`：npm 明确回了 401/403 —— 这是真的认证问题，
 *     token 失效或类型不对，应当拦住发布。
 *   - `unknown`：超时、网络抖动、DNS 抽风 —— 这只是**我们没问出来**。
 *     拿它挡住一次发布是误伤：真要认证不行，npm 自己会在推包时报错。
 *
 * 一开始这里只判「有没有用户名」，结果在一次 registry 变慢时把发布挡了下来 ——
 * 而那次认证完全是好的。
 */
export function whoami() {
  const r = npm(['whoami'], { timeout: 60_000 });
  const output = `${r.stderr}${r.stdout}`;

  if (r.ok && r.stdout.trim()) return { status: 'ok', user: r.stdout.trim() };
  if (/E401|ENEEDAUTH|Unauthorized|E403|forbidden/i.test(output)) {
    return { status: 'unauthenticated', detail: firstErrorLine(output) };
  }
  return { status: 'unknown', detail: r.timedOut ? '请求超时' : firstErrorLine(output) };
}

/**
 * 查远端已发布的版本。
 *
 * 三种结果要分得清楚，它们的下一步完全不同：
 *   - 包还不存在（E404）→ 首次发布，不是错误
 *   - 网络/认证失败 → **必须停下来**，因为查不到远端就等于无法判断版本号是否被占用
 *   - 正常 → 返回版本列表
 */
export function queryRegistry(name, { registry } = {}) {
  const args = ['view', name, 'versions', 'dist-tags', '--json'];
  // publishConfig.registry 可以指向别处；问错 registry 等于没问
  if (registry) args.push('--registry', registry);
  const r = npm(args, { timeout: 60_000 });

  if (!r.ok) {
    const output = `${r.stderr}${r.stdout}`;
    if (/E404|Not found/i.test(output)) {
      return { reachable: true, exists: false, published: [], distTags: {} };
    }
    return { reachable: false, exists: null, published: [], distTags: {}, error: firstErrorLine(output) };
  }

  // npm 偶尔会在 JSON 前面带几行提示，从第一个 `{` 开始解析
  const text = r.stdout.trim();
  const start = text.indexOf('{');
  if (start < 0) {
    return { reachable: true, exists: false, published: [], distTags: {} };
  }

  let data;
  try {
    data = JSON.parse(text.slice(start));
  } catch (error) {
    return { reachable: false, exists: null, published: [], distTags: {}, error: `返回的不是 JSON：${error.message}` };
  }

  return {
    reachable: true,
    exists: true,
    published: normalizeVersions(data.versions),
    distTags: data['dist-tags'] ?? {},
  };
}

/**
 * 即将发出去的包里到底有什么。
 *
 * 这是唯一能回答「我到底发了什么」的手段，而且只有 `--dry-run` 能在
 * 真正发布前问出来。**不会**触发 prepack/prepare —— 实测 npm 9 上
 * `npm pack` 不跑它们，所以要保证 dist 已经被构建过（preflight 会先构建）。
 */
export function packSummary() {
  const r = npm(['pack', '--dry-run', '--json'], { timeout: 180_000 });
  if (!r.ok) return null;
  const text = r.stdout.trim();
  const start = text.indexOf('[');
  if (start < 0) return null;
  try {
    const [info] = JSON.parse(text.slice(start));
    return {
      filename: info.filename,
      entryCount: info.entryCount,
      size: info.size,
      unpackedSize: info.unpackedSize,
      files: (info.files ?? []).map((f) => f.path),
    };
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ─────────────────────────────────────────────────────────────
// git 侧的事实
// ─────────────────────────────────────────────────────────────

export function gitState() {
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    return { inRepo: false, hasCommits: false, clean: true, dirty: [], branch: null, remotes: [], lastTag: null };
  }

  const hasCommits = git(['rev-parse', '--verify', '--quiet', 'HEAD']).ok;

  const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchResult.ok ? branchResult.stdout.trim() : null;

  // --porcelain 天然不含 .gitignore 忽略的文件（dist/ 就在这里被排除），
  // 但也包含未跟踪文件 —— 它们同样进不了提交，却会进 tarball。
  const statusResult = git(['status', '--porcelain']);
  const dirty = statusResult.ok
    ? statusResult.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.replace(/^\S+\s+/, ''))
    : [];

  const remoteResult = git(['remote']);
  const remotes = remoteResult.ok ? remoteResult.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];

  const tagResult = git(['describe', '--tags', '--abbrev=0']);
  const lastTag = tagResult.ok ? tagResult.stdout.trim() : null;

  const upstreamResult = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = upstreamResult.ok ? upstreamResult.stdout.trim() : null;
  let behind = 0;
  if (upstream) {
    const behindResult = git(['rev-list', '--count', `HEAD..${upstream}`]);
    behind = behindResult.ok ? Number(behindResult.stdout.trim()) || 0 : 0;
  }

  return { inRepo: true, hasCommits, branch, dirty, clean: dirty.length === 0, remotes, lastTag, upstream, behind };
}

/**
 * 取提交记录。
 *
 * 用 \x1f / \x1e 做分隔符（见 lib.parseCommits 的说明）。
 * 没有 HEAD（全新仓库一次都没提交过）时返回空串而不是报错。
 */
export function gitLog(range = '') {
  const args = ['log', '--no-merges', '--pretty=format:%h%x1f%s%x1f%b%x1e'];
  if (range) args.push(range);
  const r = git(args);
  return r.ok ? r.stdout : '';
}

export function lastTagBeforeHead() {
  const r = git(['describe', '--tags', '--abbrev=0']);
  return r.ok ? r.stdout.trim() : null;
}

export function tagExists(tag) {
  return git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).ok;
}

/**
 * 暂存全部改动并提交。
 *
 * 调用方必须先做敏感文件检查 —— 这里只负责执行，不再二次猜测路径是否安全。
 */
export function commitAll(message) {
  const added = git(['add', '-A']);
  if (!added.ok) return added;
  return git(['commit', '-m', String(message)]);
}

// ─────────────────────────────────────────────────────────────
// 文件与快照
// ─────────────────────────────────────────────────────────────

export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

export function writeText(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

export function exists(file) {
  return fs.existsSync(file);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 状态文件放在 `.git/` 里：它天然不会被提交，也不会出现在 `git status` 里。 */
export function statePath(root) {
  const r = git(['rev-parse', '--git-dir']);
  const gitDir = r.ok ? r.stdout.trim() : '.git';
  return path.resolve(root, gitDir, 'fws-release-state.json');
}

export function saveState(root, state) {
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  return file;
}

export function readState(root) {
  const file = statePath(root);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function clearState(root) {
  const file = statePath(root);
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}

/**
 * 把 preflight 改过的文件还原回去。
 *
 * 只在**内容仍然是我们写进去的那份**时才还原：如果人在中间手工改过
 * （比如补写了一句发布说明），那这份改动比「工作区干净」重要得多，不能替他丢掉。
 */
export function restoreFiles(files) {
  const restored = [];
  const kept = [];
  for (const [file, content] of Object.entries(files)) {
    const written = content.written;
    const original = content.original;
    if (!fs.existsSync(file)) continue;
    if (written !== undefined && fs.readFileSync(file, 'utf8') !== written) {
      kept.push(file);
      continue;
    }
    fs.writeFileSync(file, original, 'utf8');
    restored.push(file);
  }
  return { restored, kept };
}

// ─────────────────────────────────────────────────────────────
// 交互
// ─────────────────────────────────────────────────────────────

/**
 * 发布前问一句。
 *
 * 只在真的是人在终端前面操作时才问：CI、管道、`--yes` 都直接放行 ——
 * 在没有终端的地方卡住等输入，只会让流水线挂到超时。
 */
export async function confirm(question, { yes = false } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\n${question} ${c.dim('(y/N)')} `)).trim().toLowerCase();
  // 只关掉我们这一层的监听，不 destroy stdin ——
  // npm 可能还要在同一个 stdin 上读 2FA 的一次性验证码。
  rl.close();
  process.stdin.pause();
  return answer === 'y' || answer === 'yes';
}
