import type { FeishuClient } from './client.js';

/**
 * 素材上传。
 *
 * `parent_type = docx_image`，且 **`parent_node` 必须是目标 Image 块的 block_id**。
 * 这意味着上传**必须发生在块插入之后** —— 先传图会因为没有 Image BlockID
 * 而报 1770013，图片全部丢失。完整顺序见 syncer。
 *
 * 硬限制：单文件 ≤20MB，**5 QPS 且 10000 次/天**。日限是硬约束，
 * 图多的知识库必须靠账本复用素材 token，否则会在某一天突然全量失败。
 */
export const PARENT_TYPE_DOCX_IMAGE = 'docx_image';
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

export class MediaApi {
  constructor(private readonly client: FeishuClient) {}

  /** 上传图片素材，返回可用于 `replace_image` 的 token。 */
  async uploadImage(params: {
    fileName: string;
    parentNode: string;
    content: Buffer;
    documentId: string;
  }): Promise<string> {
    if (params.content.byteLength > MEDIA_MAX_BYTES) {
      throw new Error(
        `图片 ${params.fileName} 大小 ${(params.content.byteLength / 1024 / 1024).toFixed(1)}MB ` +
          `超过 20MB 上限，需先压缩或走分片上传`,
      );
    }

    const form = new FormData();
    form.append('file_name', params.fileName);
    form.append('parent_type', PARENT_TYPE_DOCX_IMAGE);
    form.append('parent_node', params.parentNode);
    form.append('size', String(params.content.byteLength));
    form.append(
      'file',
      new Blob([new Uint8Array(params.content)], { type: guessMime(params.fileName) }),
      params.fileName,
    );

    const data = (await this.client.upload<{ file_token?: string }>(
      '/drive/v1/medias/upload_all',
      form,
      { docId: params.documentId },
    )) as { file_token?: string };

    if (!data.file_token) {
      throw new Error(`上传图片 ${params.fileName} 成功但未返回 file_token`);
    }
    return data.file_token;
  }

  /**
   * 按素材 token 下载图片。
   *
   * 权限上除了 `docs:document.media:download` 之类的 scope，还有一条容易漏的：
   * 文档权限面板里的「谁可以创建副本、打印和下载」必须允许应用 ——
   * 只把应用加为协作者是不够的。
   */
  async downloadImage(token: string): Promise<{ content: Buffer; ext: string }> {
    const { content, contentType } = await this.client.download(
      `/drive/v1/medias/${encodeURIComponent(token)}/download`,
    );
    return { content, ext: extFromMime(contentType) };
  }
}

/** 从 MIME 推扩展名；认不出就退回 `.png`（飞书素材绝大多数是图片）。 */
function extFromMime(contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (type) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'png';
  }
}

function guessMime(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}
