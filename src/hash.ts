import { createHash } from 'node:crypto';

/** 内容哈希，用于「本地文件是否变过」的判定与图片素材复用。 */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
