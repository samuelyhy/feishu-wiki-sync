/**
 * 发布脚本的**纯逻辑层**：版本号、变更日志、提交记录。
 *
 * ## 为什么单独一层
 *
 * 发布是不可逆的（72 小时后不能撤回、版本号永久占用），所以这里的每条判断
 * 都必须能被单独验证。判断如果埋在 `spawnSync` 和 `fs.writeFileSync` 中间，
 * 就只能靠人手发一次版来测 —— 那等于没有测。
 *
 * 因此本文件**不碰文件系统、不碰 git、不碰 npm**，只做字符串和数字运算。
 * 副作用全在 `io.mjs`，编排在 `preflight.mjs` / `finalize.mjs`。
 */

// ─────────────────────────────────────────────────────────────
// 版本号
// ─────────────────────────────────────────────────────────────

const VERSION_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 拆开一个语义化版本号；不合法时返回 null（而不是抛错，方便当判据用）。 */
export function parseVersion(version) {
  const m = VERSION_RE.exec(String(version).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    // `null` 表示正式版。注意不能用空数组代替 —— 「正式版」比「预发布版」大，
    // 两者混同会让 1.0.0-beta < 1.0.0 的比较反过来。
    prerelease: m[4] ? m[4].split('.') : null,
  };
}

export function isValidVersion(version) {
  return parseVersion(version) !== null;
}

export function isPrerelease(version) {
  return parseVersion(version)?.prerelease !== null;
}

/**
 * 预发布版对应的 dist-tag（`1.2.0-beta.3` → `beta`）。
 *
 * npm 不允许在没有 `--tag` 的情况下发布预发布版，因为它会直接顶掉 `latest` ——
 * 别人 `npm i` 装到的就成了一份测试版。
 */
export function prereleaseTag(version) {
  const pre = parseVersion(version)?.prerelease;
  if (!pre) return null;
  // 纯数字的预发布段没有信息量（1.2.0-0），退回 `next`
  return /^\d+$/.test(pre[0]) ? 'next' : pre[0];
}

/** semver 比较。正式版大于同号预发布版，数字标识符小于字母标识符。 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) {
    throw new Error(`无法比较非语义化版本号：${!x ? JSON.stringify(a) : JSON.stringify(b)}`);
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }

  if (x.prerelease === null && y.prerelease === null) return 0;
  if (x.prerelease === null) return 1;
  if (y.prerelease === null) return -1;

  const len = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < len; i++) {
    const l = x.prerelease[i];
    const r = y.prerelease[i];
    if (l === undefined) return -1; // 短的更小：1.0.0-alpha < 1.0.0-alpha.1
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
    } else if (lNum !== rNum) {
      return lNum ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

export function maxVersion(versions) {
  if (!versions || versions.length === 0) return null;
  return versions.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
}

/**
 * 递增版本号。
 *
 * 各处行为刻意贴近 `npm version`，避免出现「脚本算出的号」和「人手动敲的号」
 * 不一致这种最难查的问题。
 */
export function incrementVersion(version, kind, preid = '') {
  const p = parseVersion(version);
  if (!p) throw new Error(`不是合法的语义化版本号：${JSON.stringify(version)}`);

  const preSuffix = (name) => (name ? `${name}.0` : '0');
  const hasPre = p.prerelease !== null;

  switch (kind) {
    case 'major':
      return `${p.major + 1}.0.0`;
    case 'minor':
      return `${p.major}.${p.minor + 1}.0`;
    case 'patch':
      // 预发布版的「补丁」是**去掉预发布后缀**（1.2.3-beta.1 → 1.2.3），
      // 与 `npm version patch` 一致。若在这里再 +1，一个已经定稿的 1.2.3
      // 就被永久跳过了。
      return hasPre
        ? `${p.major}.${p.minor}.${p.patch}`
        : `${p.major}.${p.minor}.${p.patch + 1}`;
    case 'prerelease': {
      if (!hasPre) return `${p.major}.${p.minor}.${p.patch + 1}-${preSuffix(preid)}`;
      const ids = [...p.prerelease];
      const last = ids[ids.length - 1];
      if (/^\d+$/.test(last)) ids[ids.length - 1] = String(Number(last) + 1);
      else ids.push('0');
      return `${p.major}.${p.minor}.${p.patch}-${ids.join('.')}`;
    }
    case 'premajor':
      return `${p.major + 1}.0.0-${preSuffix(preid)}`;
    case 'preminor':
      return `${p.major}.${p.minor + 1}.0-${preSuffix(preid)}`;
    case 'prepatch':
      return `${p.major}.${p.minor}.${p.patch + 1}-${preSuffix(preid)}`;
    case 'none':
      return version;
    default:
      throw new Error(
        `不认识的递增方式：${JSON.stringify(kind)}。` +
          `可用：major / minor / patch / prerelease / premajor / preminor / prepatch / none`,
      );
  }
}

/**
 * 定出这次要发布的版本号。
 *
 * 规则只有两条，但顺序很关键：
 *
 * 1. **本地版本没发布过 → 原样发布，不递增。** 版本号和 CHANGELOG 都是人写好
 *    的，多数时候脚本不该去猜人想要哪个号；人已经决定的事，脚本照做就行。
 * 2. **本地版本发布过了 → 递增。** 递增的基准取「本地」与「远端最新」中更大的
 *    那个：从一份落后的本地副本上递增（本地 0.1.0、远端已经 0.3.0），算出来的
 *    0.1.1 很可能也已经被占用了。
 */
export function resolveTargetVersion({ localVersion, published = [], bump = 'patch', preid = '' }) {
  if (!isValidVersion(localVersion)) {
    throw new Error(
      `package.json 里的 version 不是合法的语义化版本号：${JSON.stringify(localVersion)}`,
    );
  }

  const seen = new Set(published);
  const latest = maxVersion(published);

  if (!seen.has(localVersion)) {
    return {
      target: localVersion,
      base: localVersion,
      bumped: false,
      latest,
      reason: latest
        ? `本地 ${localVersion} 尚未发布（远端最新 ${latest}）`
        : '远端还没有任何版本，这是首次发布',
    };
  }

  if (bump === 'none') {
    throw new Error(
      `版本 ${localVersion} 已经发布过，而当前不允许递增（bump=none）。` +
        `请先手工改 package.json 的 version，或去掉 --no-bump 重新执行`,
    );
  }

  const base = latest && compareVersions(latest, localVersion) > 0 ? latest : localVersion;
  let target = base;
  let hops = 0;
  do {
    target = incrementVersion(target, bump, preid);
    if (++hops > 1000) throw new Error(`从 ${base} 按 ${bump} 递增 1000 次仍未找到未占用的版本号`);
  } while (seen.has(target));

  return {
    target,
    base,
    bumped: true,
    latest,
    reason: `${base} 已发布 → 递增为 ${target}（${bump}）`,
  };
}

// ─────────────────────────────────────────────────────────────
// package.json
// ─────────────────────────────────────────────────────────────

/**
 * 只改 `version` 的值，其余一个字节都不动。
 *
 * 不用 `JSON.parse` + `JSON.stringify`：那会把整个文件按 JSON.stringify 的
 * 排版重写一遍，于是发布提交里混进几千行格式变动，真正改了什么反而看不见。
 */
export function setPackageVersion(text, version) {
  const re = /^([ \t]*"version"[ \t]*:[ \t]*")[^"]*(")/m;
  if (!re.test(text)) {
    throw new Error('package.json 里找不到 "version" 字段，无法写入版本号');
  }
  return text.replace(re, `$1${version}$2`);
}

// ─────────────────────────────────────────────────────────────
// 变更日志
// ─────────────────────────────────────────────────────────────

const HEADING_RE = /^##\s+\[([^\]]+)\]\s*(.*)$/;
const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/** 本机时区的 YYYY-MM-DD。CHANGELOG 是人看的，不该按 UTC 走。 */
export function todayISO(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 切出所有 `## [x.y.z]` 段落。返回顺序与文件顺序一致（新版本在前）。 */
export function parseChangelog(md) {
  const lines = md.split('\n');
  const heads = [];
  lines.forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) heads.push({ version: m[1].trim(), rest: m[2].trim(), line: i });
  });

  return heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].line : lines.length;
    const slice = lines.slice(head.line + 1, end);
    // 段落之间用 `---` 分隔。只剥掉首尾的分隔线与空行，
    // 正文中间出现的 `---`（如果有人拿它当分隔线用）保持原样。
    while (slice.length && (/^\s*$/.test(slice[0]) || /^-{3,}\s*$/.test(slice[0]))) slice.shift();
    while (slice.length && (/^\s*$/.test(slice.at(-1)) || /^-{3,}\s*$/.test(slice.at(-1)))) slice.pop();
    const date = DATE_RE.exec(head.rest);
    return {
      version: head.version,
      line: head.line,
      date: date ? date[1] : null,
      body: slice.join('\n').trim(),
    };
  });
}

export function findSection(md, version) {
  return parseChangelog(md).find((s) => s.version === version) ?? null;
}

/** 取某个版本的发布说明；没有就返回 null。 */
export function extractNotes(md, version) {
  return findSection(md, version)?.body ?? null;
}

/**
 * 给 `## [x.y.z]` 补上日期。
 *
 * 日期不是装饰：CHANGELOG 是「哪个版本什么时候出去」的记录，
 * 缺了日期的段落三个月后没人分得清前后。
 */
export function stampDate(md, version, date) {
  const section = findSection(md, version);
  if (!section || section.date) return { md, changed: false };

  const lines = md.split('\n');
  const heading = HEADING_RE.exec(lines[section.line]);
  const rest = heading[2] ? `${heading[2]} ` : '';
  lines[section.line] = `## [${version}] ${rest}— ${date}`.replace(/\s+$/, '');
  return { md: lines.join('\n'), changed: true };
}

/** 把 `## [Unreleased]` 改名成正式版本号 —— Keep a Changelog 的标准动作。 */
export function renameSection(md, from, to, date) {
  const section = findSection(md, from);
  if (!section) return { md, changed: false };
  const lines = md.split('\n');
  lines[section.line] = `## [${to}] — ${date}`;
  return { md: lines.join('\n'), changed: true };
}

/**
 * 插一个新版本段落，位置在**所有历史版本之上**。
 *
 * 段落之间用 `---` 分隔；新段落插在第一条分隔线之后，因此不会多出一条
 * 悬空的分隔线，也不会把上一条吞进正文。
 */
export function insertSection(md, { version, date, body }) {
  const sections = parseChangelog(md);
  const block = `## [${version}] — ${date}\n\n${body.trim()}\n\n---`;

  if (sections.length === 0) {
    // 还没有任何历史版本：直接接到文件末尾
    return `${md.replace(/\s+$/, '')}\n\n---\n\n${block.replace(/\n\n---$/, '')}\n`;
  }

  const lines = md.split('\n');
  const insertAt = sections[0].line;
  const before = lines.slice(0, insertAt).join('\n').replace(/\s+$/, '');
  const lastLine = before.split('\n').at(-1) ?? '';
  const needsRule = !/^-{3,}$/.test(lastLine.trim());

  return `${before}\n\n${needsRule ? '---\n\n' : ''}${block}\n\n${lines.slice(insertAt).join('\n')}`;
}

// ─────────────────────────────────────────────────────────────
// 提交记录 → 发布说明
// ─────────────────────────────────────────────────────────────

/** 章节顺序即重要性顺序：破坏性变更必须最先被看到。`match` 先命中者胜。 */
export const CATEGORIES = [
  { key: 'breaking', title: '破坏性变更', match: (c) => c.breaking },
  { key: 'feat', title: '新增', match: (c) => c.type === 'feat' },
  { key: 'fix', title: '修复', match: (c) => c.type === 'fix' },
  { key: 'perf', title: '性能', match: (c) => c.type === 'perf' },
  { key: 'refactor', title: '变更', match: (c) => ['refactor', 'change', 'style'].includes(c.type) },
  { key: 'docs', title: '文档', match: (c) => c.type === 'docs' },
  { key: 'test', title: '测试', match: (c) => c.type === 'test' },
  { key: 'other', title: '其他', match: () => true },
];

/** 发版自身产生的提交不该出现在发布说明里 —— 它对使用者毫无信息量。 */
export function isReleaseChore(commit) {
  return /^(chore|release|build)(\(release\))?!?:\s*(v?\d+\.\d+\.\d+|release)/i.test(commit.subject);
}

/**
 * 解析 `git log --pretty=format:%h%x1f%s%x1f%b%x1e` 的输出。
 *
 * 用 \x1f（字段）/ \x1e（记录）而不是换行：提交正文本身是跨行的，
 * 按换行切会把一条提交切成好几条。
 */
export function parseCommits(raw) {
  return String(raw)
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [hash = '', subject = '', body = ''] = record.split('\x1f');
      const clean = subject.trim();
      const m = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(clean);
      return {
        hash: hash.trim(),
        subject: clean,
        type: m ? m[1].toLowerCase() : '',
        scope: m?.[2] ?? '',
        text: m ? m[4].trim() : clean,
        breaking: Boolean(m?.[3]) || /(^|\n)BREAKING[ -]CHANGE:/.test(body),
        conventional: Boolean(m),
      };
    });
}

/**
 * 由提交记录渲染发布说明草稿。
 *
 * 生成的是**草稿**，不是成品 —— 手写的 CHANGELOG 有「为什么这么改」，
 * 提交标题里没有。所以开头明确写着它可以改写，免得有人以为它不能动。
 *
 * 返回 null 表示提不出任何内容（例如仓库还没有提交），
 * 此时调用方应当拒绝发布，而不是塞一段空话进 CHANGELOG。
 */
export function renderReleaseNotes(commits, { range = '' } = {}) {
  const usable = commits.filter((c) => !isReleaseChore(c) && !/^Merge\b/.test(c.subject));
  if (usable.length === 0) return null;

  const lines = [
    `> 本节由发布脚本依据 git 提交自动生成（${range || '全部提交'}，${usable.length} 条），` +
      '可以直接改写 —— 提交标题里没有「为什么这么改」，补上它比什么都重要。',
  ];

  for (const category of CATEGORIES) {
    const hits = usable.filter(category.match);
    if (hits.length === 0) continue;

    lines.push('', `### ${category.title}`, '');
    const seen = new Set();
    for (const c of hits) {
      const text = c.scope ? `**${c.scope}**：${c.text}` : c.text;
      if (seen.has(text)) continue;
      seen.add(text);
      lines.push(`- ${text}`);
    }
  }

  return lines.join('\n').trim();
}

// ─────────────────────────────────────────────────────────────
// 远端版本数据的归一化
// ─────────────────────────────────────────────────────────────

/**
 * `npm view <pkg> versions --json` 的返回值不总是数组。
 *
 * 只有一个版本时 npm 会把它**压成字符串**（`"0.1.0"`），而不是 `["0.1.0"]`。
 * 不归一化的话，`published.length` 会变成 5（字符数），
 * `published.has(...)` 永远为假 —— 于是脚本会认为「本地版本没发布过」，
 * 直接拿一个已存在的版本去发，最后撞在 EPUBLISHCONFLICT 上。
 */
export function normalizeVersions(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return Object.keys(value);
}

// ─────────────────────────────────────────────────────────────
// 发布前自动提交：敏感路径
// ─────────────────────────────────────────────────────────────

/** 脏工作区自动提交时的默认说明；可用 --commit-message / FWS_RELEASE_COMMIT_MSG 覆盖。 */
export const DEFAULT_PRE_RELEASE_COMMIT_MSG = 'chore: commit workspace before release';

const SENSITIVE_BASENAME_EXACT = new Set(['.env', 'id_rsa', 'id_ed25519']);
const SENSITIVE_EXT = /\.(pem|key|p12|pfx)$/i;
const SENSITIVE_NAME = /(^|[^a-z0-9])(credentials|secret)([^a-z0-9]|$)/i;

/**
 * 判断相对路径是否像密钥/凭证文件。
 *
 * 命中则拒绝自动 `git add -A`：一键发布时最容易误提交的就是这类文件，
 * 拦在提交前比事后从历史里挖出来便宜得多。`.env.example` 是模板，放过。
 */
export function isSensitivePath(relPath) {
  const normalized = String(relPath).replaceAll('\\', '/');
  const base = normalized.split('/').pop() ?? normalized;
  if (/^\.env\.example$/i.test(base)) return false;
  if (SENSITIVE_BASENAME_EXACT.has(base.toLowerCase())) return true;
  if (/^\.env(\.|$)/i.test(base)) return true;
  if (SENSITIVE_EXT.test(base)) return true;
  if (SENSITIVE_NAME.test(base)) return true;
  return false;
}

export function findSensitivePaths(paths) {
  return paths.filter((p) => isSensitivePath(p));
}
