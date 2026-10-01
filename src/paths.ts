/**
 * 工程相对路径的归一化与过滤。
 *
 * 单独抽出来是因为 `status` 与 `sync` 必须**用同一套规则**判断
 * 「用户给的这个路径指的是哪个文件」。两边各写一份的后果是：
 * 同一条命令 `fws sync docs/specs` 能匹配上，`fws status docs/specs` 却
 * 报「无匹配文件」—— 而且是静默的，用户会以为自己没有待同步的文件。
 */

/** 统一成 `/` 分隔、无 `./` 前缀、无尾斜杠的形式。 */
export function normalizeRelPath(input: string): string {
  return input
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/**
 * 判断 `relPath` 是否落在用户给出的路径过滤器内。
 *
 * 匹配语义是**前缀**：给 `docs/specs` 会同时命中 `docs/specs/a.md`，
 * 但不会命中 `docs/specs-other/a.md`（所以比较时要带上分隔符）。
 */
export function matchesPathFilter(relPath: string, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  const target = normalizeRelPath(relPath);
  return filters.some((raw) => {
    const prefix = normalizeRelPath(raw);
    if (prefix === '') return true;
    return target === prefix || target.startsWith(`${prefix}/`);
  });
}
