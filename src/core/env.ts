import fs from 'node:fs';
import path from 'node:path';

export const ENV_FILE_NAME = '.ai-sync.env';

/**
 * `.ai-sync.env` 的读写。
 *
 * 刻意不引入 dotenv：格式就是 KEY=VALUE，多一个依赖不划算，
 * 而且我们**需要写回**（`init` 会生成文件），自己实现更可控。
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // 去掉成对的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFile(cwd: string): Record<string, string> {
  const file = path.join(cwd, ENV_FILE_NAME);
  if (!fs.existsSync(file)) return {};
  return parseEnvFile(fs.readFileSync(file, 'utf8'));
}

/**
 * 写入 env 文件。已有键保留顺序，新键追加。
 *
 * 权限设为 0600：文件里是应用密钥，同机器上的其他用户不该读到。
 * Windows 上 chmod 基本无效，但设置它不会有副作用，且能保护 Linux/macOS 用户。
 */
export function writeEnvFile(cwd: string, values: Record<string, string>): string {
  const file = path.join(cwd, ENV_FILE_NAME);
  const existing = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : {};
  const merged = { ...existing, ...values };

  const lines = [
    '# 飞书知识库同步凭证 —— 此文件绝不入库（已在 .gitignore 中）',
    '',
    ...Object.entries(merged).map(([k, v]) => `${k}=${v}`),
    '',
  ];

  fs.writeFileSync(file, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  return file;
}
