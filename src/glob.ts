/**
 * 极简 glob 匹配（`**`、`*`、`?`）。
 *
 * 不引第三方 glob 库有两个理由：一是本工具只需要「相对路径是否命中」这一个
 * 判断，不需要遍历文件系统；二是 glob 库的语义差异（尤其是 `**` 是否跨目录）
 * 常常成为「exclude 没生效」这类隐性 bug 的来源，自己实现反而更可预测。
 *
 * 约定：`*` 不跨 `/`，`**` 跨任意层级。路径统一用 `/` 分隔。
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];

    if (ch === '*') {
      const isDouble = glob[i + 1] === '*';
      if (isDouble) {
        // `**/` 匹配「零个或多个目录层级」，因此要连同后面的 `/` 一起吞掉
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }

    re += ch !== undefined ? escapeRegExp(ch) : '';
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** 任一模式命中即返回 true。空模式列表按「不命中」处理。 */
export function matchesAny(relPath: string, patterns: readonly string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return patterns.some((p) => globToRegExp(p).test(normalized));
}

/**
 * 判断路径是否应被处理。
 *
 * `exclude` 优先于 `include` —— 排除规则是「无论如何都不要碰」的强意图，
 * 被 include 命中不该使它失效。
 */
export function shouldInclude(
  relPath: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  if (matchesAny(relPath, exclude)) return false;
  if (include.length === 0) return true;
  return matchesAny(relPath, include);
}
