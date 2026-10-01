import fs from 'node:fs';
import path from 'node:path';
import {
  AmbiguousError,
  QuotaExhaustedError,
  SyncError,
  friendlyMessage,
} from '../errors.js';
import type { DocxApi } from '../feishu/docx.js';
import { BATCH_UPDATE_MAX, DESCENDANT_MAX, MAX_BLOCKS_PER_DOCUMENT } from '../feishu/docx.js';
import type { MediaApi } from '../feishu/media.js';
import type { WikiApi, WikiNode } from '../feishu/wiki.js';
import type { Logger } from '../logger.js';
import { matchesPathFilter } from '../paths.js';
import {
  align,
  isNoop,
  segmentsInWriteOrder,
  type AlignItem,
  type AlignResult,
} from './align.js';
import {
  blockStyleSignature,
  fingerprint,
  isUpdatableInPlace,
  stripMergeInfo,
} from './blocks.js';
import type { Mapping, SyncConfig } from './config.js';
import type { LedgerDoc, LedgerImage, LedgerStore } from './ledger.js';
import {
  assertNoOverlap,
  normalizeTitle,
  scanMapping,
  type ImageRef,
  type ScannedFile,
} from './scanner.js';
import {
  assignByPosition,
  buildTreeFromConvert,
  collectSubtree,
  imageBlockIdsInOrder,
  textElementsOf,
  treeFromRemote,
} from './tree.js';

export type FileAction =
  | 'up-to-date'
  | 'created'
  | 'updated'
  | 'planned'
  | 'drift'
  | 'conflict'
  | 'ambiguous'
  | 'failed';

export interface FileResult {
  relPath: string;
  action: FileAction;
  message?: string;
  stats?: AlignResult['stats'];
  nodeToken?: string;
  /** 是否发生了远端写入 */
  wrote?: boolean;
}

export interface SyncDeps {
  cwd: string;
  config: SyncConfig;
  ledger: LedgerStore;
  wiki: WikiApi;
  docx: DocxApi;
  media: MediaApi;
  logger: Logger;
}

export interface SyncOptions {
  dryRun?: boolean;
  force?: boolean;
  reclaim?: boolean;
  /** 显式授权破坏性变更（清空远端、大规模删除、首次纳管非空文档） */
  allowDestructive?: boolean;
  /** 路径白名单（工程相对）；空表示全部 */
  paths?: string[];
}

interface Claim {
  node: WikiNode;
  claimedBy: LedgerDoc['claimed_by'];
  isNew: boolean;
  /** dry-run 下需要新建的节点：只报告，不真的创建 */
  wouldCreate?: boolean;
}

export class Syncer {
  /** 每个父节点的子节点列表只拉一次 —— 认领是「列举 + 匹配」，不列举就没法匹配。 */
  private readonly childrenCache = new Map<string, WikiNode[]>();
  /** 本次运行已被占用的节点，防止两个本地文件认领同一个远端节点。 */
  private readonly taken = new Set<string>();

  constructor(private readonly deps: SyncDeps) {}

  async run(options: SyncOptions = {}): Promise<FileResult[]> {
    // 每次 run 都从干净的缓存开始。
    //
    // 缓存只在**一次运行内**有效：跨运行复用会让第二次看到「父节点下没有子节点」
    // 这类陈旧快照，进而重复创建节点。CLI 每次进程都新建实例所以碰不到，
    // 但只要有人把 Syncer 复用（长驻服务、批处理脚本），这就是个静默的重复建节点 bug。
    this.childrenCache.clear();
    this.taken.clear();

    // 先确认没有文件被两个 mapping 同时匹配 —— 那会建出两份远端文档，
    // 而且之后每次同步都在两者之间来回覆盖。宁可现在失败。
    assertNoOverlap(this.deps.cwd, this.deps.config.mappings);

    // 预置「已被占用的节点」，防止两个本地文件认领同一节点。
    //
    // `--reclaim` 时**跳过**这一步：reclaim 的语义正是「忽略账本，重新按标题认领」。
    // 若仍把账本里的节点标为已占用，按标题匹配时它们会被排除 →
    // 命中数为 0 → 对每一篇已同步的文档都新建一份重复文档，与 reclaim 的目的相反。
    if (!options.reclaim) {
      for (const p of this.deps.ledger.paths()) {
        const doc = this.deps.ledger.get(p);
        if (doc) this.taken.add(doc.node_token);
      }
    }

    const results: FileResult[] = [];

    for (const mapping of this.deps.config.mappings) {
      const files = this.filterPaths(scanMapping(this.deps.cwd, mapping), options.paths);
      if (files.length === 0) continue;

      this.deps.logger.debug(`[${mapping.source}] 扫描到 ${files.length} 个文件`);

      for (const file of files) {
        const result = await this.syncOne(file, mapping, options);
        results.push(result);
        this.report(result);
      }
    }

    return results;
  }

  private filterPaths(files: ScannedFile[], paths?: string[]): ScannedFile[] {
    return files.filter((f) => matchesPathFilter(f.relPath, paths ?? []));
  }

  private async syncOne(
    file: ScannedFile,
    mapping: Mapping,
    options: SyncOptions,
  ): Promise<FileResult> {
    try {
      const claim = await this.resolveNode(file, mapping, options);
      return await this.syncDocument(file, claim, options);
    } catch (err) {
      // 配额耗尽是全局性的，必须中止整轮而不是逐篇失败 ——
      // 继续跑只会把配额耗尽的事实淹没在几十条失败记录里。
      if (err instanceof QuotaExhaustedError) throw err;

      if (err instanceof AmbiguousError) {
        const candidates =
          err.candidates.length > 0 ? `\n  候选节点: ${err.candidates.join(', ')}` : '';
        return {
          relPath: file.relPath,
          action: 'ambiguous',
          message: `${err.message}${candidates}`,
        };
      }
      return { relPath: file.relPath, action: 'failed', message: friendlyMessage(err) };
    }
  }

  // ─────────────────────────── 认领 ───────────────────────────

  /**
   * 把本地文件对应到知识库节点。
   *
   * **账本优先，标题匹配只用于首次认领。** 这条纪律不能松：
   * 标题匹配失败时是静默的（会新建一篇重复文档），或者更糟 ——
   * 匹配到同名但属于别人的文档并覆盖它。一旦认领成功就写进账本，
   * 之后一律以账本为准。
   */
  private async resolveNode(
    file: ScannedFile,
    mapping: Mapping,
    options: SyncOptions,
  ): Promise<Claim> {
    if (!options.reclaim) {
      const led = this.deps.ledger.get(file.relPath);
      if (led) {
        this.taken.add(led.node_token);
        return {
          node: {
            node_token: led.node_token,
            obj_token: led.obj_token,
            obj_type: 'docx',
            title: led.title,
          },
          claimedBy: led.claimed_by,
          isNew: false,
        };
      }

      // 本地重命名：靠 aliases 找回原节点，避免「新建 + 旧文档废弃」的噪音
      const aliasToken = this.deps.ledger.resolveAlias(file.relPath);
      if (aliasToken) {
        const node = await this.deps.wiki.getNode(aliasToken);
        if (node) {
          this.taken.add(node.node_token);
          return { node, claimedBy: 'manual', isNew: false };
        }
      }
    }

    const children = await this.childrenOf(mapping);
    const want = normalizeTitle(file.title);
    const matches = children.filter(
      (n) => normalizeTitle(n.title) === want && !this.taken.has(n.node_token),
    );

    if (matches.length === 1) {
      const node = matches[0]!;
      this.taken.add(node.node_token);
      this.deps.logger.debug(`认领 ${file.relPath} → ${node.title} (${node.node_token})`);
      return { node, claimedBy: 'title', isNew: false };
    }

    if (matches.length === 0) {
      if (mapping.onMissing === 'fail') {
        throw new SyncError(
          `知识库中未找到标题为「${file.title}」的文档，且 on_missing=fail`,
          file.relPath,
        );
      }
      // dry-run 承诺「不写入任何内容」，建节点也是写操作。
      // 这里只做标记，等 syncDocument 报告「将创建新文档」。
      if (options.dryRun) {
        return {
          node: { node_token: '', obj_token: '', obj_type: 'docx', title: file.title },
          claimedBy: 'title',
          isNew: true,
          wouldCreate: true,
        };
      }

      const node = await this.deps.wiki.createNode({
        spaceId: this.deps.config.spaceId,
        objType: 'docx',
        parentNodeToken: mapping.parentNodeToken,
        title: file.title,
      });
      this.taken.add(node.node_token);
      children.push(node);
      return { node, claimedBy: 'title', isNew: true };
    }

    // 同名多个时**一律**停下来问人。
    //
    // 曾经有过一个 `on_ambiguous: newest` 选项，但它只是取 API 返回顺序的最后一个
    // —— WikiNode 里根本没有时间字段。一个不按自己名字行事的选项会静默覆盖
    // 别人的文档，比没有这个选项更糟，所以已经删掉并改为配置加载时拒绝。
    throw new AmbiguousError(
      `「${file.relPath}」在知识库中命中 ${matches.length} 个标题为「${file.title}」的文档，无法自动认领`,
      matches.map((n) => n.node_token),
    );
  }

  private async childrenOf(mapping: Mapping): Promise<WikiNode[]> {
    const key = mapping.parentNodeToken;
    const cached = this.childrenCache.get(key);
    if (cached) return cached;

    const list = await this.deps.wiki.listChildren(this.deps.config.spaceId, key);
    this.childrenCache.set(key, list);
    return list;
  }

  // ─────────────────────────── 同步 ───────────────────────────

  private async syncDocument(
    file: ScannedFile,
    claim: Claim,
    options: SyncOptions,
  ): Promise<FileResult> {
    const { docx } = this.deps;

    if (claim.wouldCreate) {
      return {
        relPath: file.relPath,
        action: 'planned',
        message: `将新建知识库文档「${file.title}」`,
        wrote: false,
      };
    }

    const documentId = claim.node.obj_token;
    const led = this.deps.ledger.get(file.relPath);

    // 用 bundleSha256 而不是 sha256：图片内容变化时正文一字未动，
    // 只看正文哈希会被判为「无变化」而静默漏同步。
    const info = await docx.getDocument(documentId);
    const localChanged = !led || led.local_sha256 !== file.bundleSha256;
    const remoteChanged = led !== undefined && info.revision_id !== led.remote_revision_id;

    // 快路径：两侧都没变，只花了 1 次读
    if (!localChanged && !remoteChanged && !options.force) {
      return {
        relPath: file.relPath,
        action: 'up-to-date',
        nodeToken: claim.node.node_token,
        wrote: false,
      };
    }

    // 漂移保护：远端被人改过就不要覆盖。
    // 没有这道闸，同步工具会静默吃掉同事在知识库里的手工修正 ——
    // 不报错、不告警，等发现时已经无从追溯。
    //
    // 例外：账本标着 needs_resync 时，revision 变化是**我们自己上次写了一半**
    // 造成的，不是人工修改。此时必须放行，否则失败一次就永久卡死。
    if (remoteChanged && !options.force && !led?.needs_resync) {
      const both = localChanged;
      return {
        relPath: file.relPath,
        action: both ? 'conflict' : 'drift',
        message: both
          ? `本地与远端都被修改过（远端 revision ${info.revision_id} ≠ 账本 ${led?.remote_revision_id}）。` +
            `请人工合并，或确认要覆盖时加 --force`
          : `远端被人工修改过（revision ${info.revision_id} ≠ 账本 ${led?.remote_revision_id}）。本地未改动，跳过`,
        nodeToken: claim.node.node_token,
        wrote: false,
      };
    }

    const remoteBlocks = await docx.listBlocks(documentId);
    const remoteTree = treeFromRemote(remoteBlocks, documentId);

    const converted = await docx.convertMarkdown(file.content);
    // 超过上限时飞书会截断或报 1770004。本地先拦下来 ——
    // 让失败发生在我们能说清原因的地方，而不是在远端写入一半之后。
    if (converted.blocks.length > MAX_BLOCKS_PER_DOCUMENT) {
      throw new SyncError(
        `文档块数 ${converted.blocks.length} 超过飞书单文档上限 ${MAX_BLOCKS_PER_DOCUMENT}，请拆分后再同步`,
        file.relPath,
      );
    }
    const localTree = buildTreeFromConvert(converted.blocks, converted.firstLevelBlockIds);

    // 图片按位置配对。远端侧用账本记录的哈希（即上次上传的内容），
    // 本地侧用当前文件哈希 —— 两者不等即表示图片内容变了，块会被重建并重新上传。
    const pairRefs = this.selectImagePairing(file, localTree);

    // 远端侧的哈希取自账本 —— 账本记的是「上次实际上传的内容哈希」。
    // 从未上传过的本地图在远端侧为 'missing'，与本地侧的真实哈希必然不同，
    // 于是该 Image 块会被重建并触发上传；这是期望行为。
    const remoteImageRefs: ImageRef[] = pairRefs.map((img) =>
      img.local && img.relPath
        ? { ...img, sha256: led?.images?.[img.relPath]?.sha256 ?? 'missing' }
        : img,
    );
    const remoteImageMap = assignByPosition(remoteTree, remoteImageRefs);
    const localImageMap = assignByPosition(localTree, pairRefs);

    // 指纹用的键：原始引用串 + 内容哈希。两侧都只用这两个量，
    // 因此「远程图」「本地图内容变了」都能被稳定区分。
    const sourceKey = (m: Map<string, ImageRef>) => (blockId: string): string | undefined => {
      const ref = m.get(blockId);
      return ref ? `${ref.src}#${ref.sha256}` : undefined;
    };

    const remoteItems = this.toItems(remoteTree, sourceKey(remoteImageMap));
    const localItems = this.toItems(localTree, sourceKey(localImageMap));

    const result = align(remoteItems, localItems);

    if (isNoop(result)) {
      // 本地文件变了，但归一化后的块完全一致（例如只改了空白或行尾）。
      // 仍要更新账本的本地哈希，否则以后每次都会重复走完整流程。
      this.persist(file, claim, info.revision_id, led?.images ?? {}, options, false);
      return {
        relPath: file.relPath,
        action: 'up-to-date',
        message: '归一化后内容无变化',
        nodeToken: claim.node.node_token,
        wrote: false,
      };
    }

    const destructive = assessDestructive({
      stats: result.stats,
      remoteCount: remoteItems.length,
      // 账本里没有这个路径的记录，而远端已经有内容 —— 说明这是一篇
      // **别人写的**文档被我们纳管。这是「误删同事文档」的唯一入口。
      firstAdoption: led === undefined && remoteItems.length > 0,
    });

    if (options.dryRun) {
      return {
        relPath: file.relPath,
        action: 'planned',
        stats: result.stats,
        ...(destructive ? { message: `⚠ ${destructive.message}` } : {}),
        nodeToken: claim.node.node_token,
        wrote: false,
      };
    }

    // 破坏性变更必须显式授权。
    //
    // 没有这道闸时，一次误操作就会静默抹掉远端内容：本地文件被清空、
    // 被截断、或者本地文件恰好与同事手工维护的文档重名 —— 三者都表现为
    // 「大量删除」，而工具会把它们报告成一次成功的 `updated`。
    if (destructive && !options.allowDestructive) {
      throw new SyncError(destructive.message, file.relPath);
    }

    let images: Record<string, LedgerImage>;
    try {
      images = await this.applyChanges(
        documentId,
        remoteItems,
        localItems,
        localTree,
        file,
        result,
        led,
        pairRefs,
      );
    } catch (err) {
      // 写入中途失败：远端可能已经改了一部分，但我们拿不到新的 revision_id。
      // 打上 needs_resync，让下次运行知道「这个 revision 差异是我自己造成的」，
      // 从而继续续传，而不是把它误判成人工修改后拒绝同步。
      this.markNeedsResync(file, claim, led);
      throw err;
    }

    const after = await docx.getDocument(documentId);
    this.persist(file, claim, after.revision_id, images, options, true, result);

    return {
      relPath: file.relPath,
      action: claim.isNew ? 'created' : 'updated',
      stats: result.stats,
      nodeToken: claim.node.node_token,
      wrote: true,
    };
  }

  /**
   * 挑出用于「按位置配对」的图片引用列表。
   *
   * `convert` 会不会为**远程 URL 图片**也生成 Image 块，官方文档没有明说
   * （`fws doctor` 会在真机上测出是哪一种）。两种情形代码都能正确处理：
   *
   * - 生成 → 配对列表用**全部**引用
   * - 不生成 → 配对列表只用**本地**引用
   *
   * 只有当两者都对不上时才报错 —— 那意味着存在我们没识别出的图片写法
   * （HTML `<img>` 标签之类）。此时按位置硬配会把图片挂到错误的块上
   * 且**不会报错**，所以宁可失败。
   */
  private selectImagePairing(
    file: ScannedFile,
    localTree: ReturnType<typeof buildTreeFromConvert>,
  ): ImageRef[] {
    const blockCount = imageBlockIdsInOrder(localTree).length;
    const localOnly = file.images.filter((i) => i.local);

    if (blockCount === file.images.length) return file.images;
    if (blockCount === localOnly.length) return localOnly;

    throw new SyncError(
      `正文中抽到 ${file.images.length} 个图片引用（其中本地 ${localOnly.length} 个），` +
        `但飞书转换出 ${blockCount} 个图片块，两种配对方式都对不上，无法安全配对。` +
        `请检查是否使用了 HTML <img> 标签等不被支持的写法`,
      file.relPath,
    );
  }

  private toItems(
    tree: ReturnType<typeof treeFromRemote>,
    imageSource: (blockId: string) => string | undefined,
  ): AlignItem[] {
    return tree.topLevel.map((id) => {
      const block = tree.byId.get(id);
      if (!block) {
        return { id, type: 0, fp: 'MISSING', styleSig: '', updatable: false };
      }
      return {
        id,
        type: block.block_type,
        fp: fingerprint(block, tree.byId, { imageSource }),
        styleSig: blockStyleSignature(block),
        updatable: isUpdatableInPlace(block),
      };
    });
  }

  /**
   * 落地变更。
   *
   * ## 顺序是这里唯一重要的事
   *
   * 1. **先做全部 update** —— `batch_update` 按 block_id 定位，不改索引；
   *    而且它保 block_id，评论随之保留，是代价最低的一种变更。
   * 2. **变化段倒序处理，段内先删后插** —— `batch_delete` 用索引范围、
   *    `descendant` 用插入位置，两者都会挪动后续块。先处理靠后的段，
   *    靠前段的索引才仍然有效。
   *
   * 顺序反了不会报错，只会把内容写到错误的位置上 —— 这是最难排查的一类 bug。
   */
  private async applyChanges(
    documentId: string,
    remoteItems: AlignItem[],
    localItems: AlignItem[],
    localTree: ReturnType<typeof buildTreeFromConvert>,
    file: ScannedFile,
    result: AlignResult,
    led: LedgerDoc | undefined,
    pairRefs: readonly ImageRef[],
  ): Promise<Record<string, LedgerImage>> {
    const { docx } = this.deps;

    // 内部不变量：统计里的删除数，必须等于所有变化段的范围之和。
    //
    // 破坏性护栏是拿 `stats.remove` 判断的 —— 一旦它与真正要删的块数对不上，
    // 护栏就形同虚设，而删除照常发生。这里 fail-closed，宁可中止也不要「护栏看着过了、内容照样没了」。
    const aboutToDelete = result.segments.reduce((n, s) => n + (s.rEnd - s.rStart), 0);
    if (aboutToDelete !== result.stats.remove) {
      throw new SyncError(
        `内部错误：统计的删除数（${result.stats.remove}）与实际变化段（${aboutToDelete}）不一致，已中止以免误删`,
        file.relPath,
      );
    }

    // ── 1) 原地更新 ──
    const updateRequests: unknown[] = [];
    for (const op of result.ops) {
      if (op.kind !== 'update') continue;
      const remote = remoteItems[op.r];
      const local = localItems[op.l];
      if (!remote || !local) continue;
      updateRequests.push({
        block_id: remote.id,
        update_text_elements: { elements: textElementsOf(localTree.byId.get(local.id)) },
      });
    }
    for (const chunk of chunkBy(updateRequests, BATCH_UPDATE_MAX)) {
      await docx.batchUpdate({ documentId, requests: chunk });
    }

    // ── 2) 变化段：倒序，段内先删后插 ──
    const imageTokens: Record<string, LedgerImage> = { ...(led?.images ?? {}) };
    const localImageMap = assignByPosition(localTree, pairRefs);

    for (const seg of segmentsInWriteOrder(result.segments)) {
      if (seg.rEnd > seg.rStart) {
        await docx.deleteChildren({
          documentId,
          parentBlockId: documentId,
          startIndex: seg.rStart,
          endIndex: seg.rEnd,
        });
      }
      if (seg.lEnd <= seg.lStart) continue;

      const rootIds = localTree.topLevel.slice(seg.lStart, seg.lEnd);
      const { childrenId, descendants } = collectSubtree(localTree.byId, rootIds);
      if (childrenId.length === 0) continue;
      if (descendants.length > DESCENDANT_MAX) {
        throw new SyncError(
          `单次插入 ${descendants.length} 个块，超过 descendant 接口上限 ${DESCENDANT_MAX}，` +
            `请把该文档拆小`,
          file.relPath,
        );
      }

      const relations = await docx.createDescendant({
        documentId,
        parentBlockId: documentId,
        childrenId,
        // merge_info 是只读字段，原样传回会直接报错 —— 必须剥掉
        descendants: stripMergeInfo(descendants),
        index: seg.rStart,
      });

      // 图片三步链的第三步：插入拿到真实 Image BlockID 之后，才轮到上传素材
      const replacements: unknown[] = [];
      for (const rel of relations) {
        const imgRef = localImageMap.get(rel.temporary_block_id);
        // 远程图、以及本地文件读不到的图，不上传也不替换 ——
        // 它们没有可上传的内容，块保持为空是唯一合理的降级
        if (!imgRef?.local || !imgRef.relPath || !imgRef.absPath) continue;
        if (imgRef.sha256 === 'missing') continue;

        const cached = imageTokens[imgRef.relPath];
        let token = cached && cached.sha256 === imgRef.sha256 ? cached.token : undefined;

        if (!token) {
          // 素材上传有 10000 次/天 的硬限，账本命中时必须跳过上传
          const bytes = fs.readFileSync(imgRef.absPath);
          token = await this.deps.media.uploadImage({
            fileName: path.basename(imgRef.relPath),
            parentNode: rel.block_id,
            content: bytes,
            documentId,
          });
          imageTokens[imgRef.relPath] = { sha256: imgRef.sha256, token };
        }

        replacements.push({ block_id: rel.block_id, replace_image: { token } });
      }
      for (const chunk of chunkBy(replacements, BATCH_UPDATE_MAX)) {
        await docx.batchUpdate({ documentId, requests: chunk });
      }
    }

    return imageTokens;
  }

  private persist(
    file: ScannedFile,
    claim: Claim,
    revisionId: number,
    images: Record<string, LedgerImage>,
    options: SyncOptions,
    wrote: boolean,
    result?: AlignResult,
  ): void {
    if (options.dryRun) return;

    // 注意这里重建了整个对象：没有带过来的字段（如 needs_resync）就此被清掉。
    this.deps.ledger.set(file.relPath, {
      node_token: claim.node.node_token,
      obj_token: claim.node.obj_token,
      title: file.title,
      claimed_by: claim.claimedBy,
      local_sha256: file.bundleSha256,
      remote_revision_id: revisionId,
      images,
      last_synced_at: new Date().toISOString(),
    });

    // 逐篇落盘：中途失败时不会丢掉已成功部分的记录，
    // 重跑才不会重复消耗配额。
    this.deps.ledger.save();

    if (wrote && result) {
      this.deps.logger.debug(
        `${file.relPath}: keep=${result.stats.keep} update=${result.stats.update} ` +
          `insert=${result.stats.insert} delete=${result.stats.remove}`,
      );
    }
  }

  /**
   * 记下「远端可能被改了一半」。
   *
   * 保留**旧的** `local_sha256` 与 `remote_revision_id` 是刻意的：
   * 下次运行应当重新算出 localChanged 与 remoteChanged，从而重跑完整 diff；
   * 真正需要改变的只是"这次 revision 差异是我自己造成的"这一条信息。
   */
  private markNeedsResync(
    file: ScannedFile,
    claim: Claim,
    led: LedgerDoc | undefined,
  ): void {
    // dry-run 的占位节点没有 obj_token，不该写进账本
    if (!claim.node.obj_token) return;

    this.deps.ledger.set(file.relPath, {
      node_token: claim.node.node_token,
      obj_token: claim.node.obj_token,
      title: file.title,
      claimed_by: claim.claimedBy,
      local_sha256: led?.local_sha256 ?? '',
      remote_revision_id: led?.remote_revision_id ?? -1,
      images: led?.images ?? {},
      last_synced_at: led?.last_synced_at ?? new Date().toISOString(),
      needs_resync: true,
    });
    this.deps.ledger.save();
  }

  private report(r: FileResult): void {
    const { logger } = this.deps;
    const icon: Record<FileAction, string> = {
      'up-to-date': '·',
      created: '+',
      updated: '~',
      planned: '?',
      drift: '!',
      conflict: '!',
      ambiguous: '!',
      failed: 'x',
    };

    const line = `${icon[r.action]} ${r.relPath}`;
    if (r.action === 'failed' || r.action === 'conflict' || r.action === 'drift' || r.action === 'ambiguous') {
      logger.warn(`${line}${r.message ? ` — ${r.message}` : ''}`);
      return;
    }
    if (r.action === 'up-to-date') {
      logger.debug(line);
      return;
    }

    const stats = r.stats
      ? ` (保留 ${r.stats.keep} / 更新 ${r.stats.update} / 新增 ${r.stats.insert} / 删除 ${r.stats.remove})`
      : '';
    logger.info(`${line}${stats}`);

    // 带 🚩 的 message 是「这次变更很危险」的预告（dry-run 时会走到这里）。
    // 早先这个分支只打 stats 不打 message，于是 dry-run 里最该被看见的
    // 风险提示被静默吞掉了 —— 而 dry-run 恰恰是唯一该看它的时机。
    if (r.message) logger.warn(`    ${r.message}`);
  }
}

/**
 * 评估这次变更的破坏性，决定是否要人显式授权。
 *
 * ## 为什么需要它
 *
 * 没有这道闸时，三种很常见的意外会**静默抹掉远端内容**：
 *
 * 1. **本地文件被清空** —— 一次误操作、一次失败的生成脚本，远端整篇就没了
 * 2. **本地文件被截断** —— 内容还在但少了大半，远端跟着删
 * 3. **与同事手工维护的文档重名** —— 首次纳管时把人工内容整篇替换成本地版本
 *
 * 三者的共同表现都是「大量删除」，而工具原本会把它们报告成一次成功的 `updated`。
 * 远端文档**没有可用的回滚手段**（飞书没有确认存在的节点删除 API，
 * 历史版本能力也不在本工具的依赖里），所以这里必须 fail-closed。
 *
 * ## 判据是「结果缩水」，不是「删了多少」
 *
 * 一开始我用的是「删除数超过一半就拦」，结果把**正常编辑**也拦了：
 * 一篇只有 1 个块的文档，把那段话改一改就是「删 1 块」= 100% 删除比例。
 *
 * 真正刻画风险的是**结果相对远端缩水了多少**：
 *
 * | 情形 | 远端 | 结果 | 缩水 | 判定 |
 * |---|---|---|---|---|
 * | 本地被清空 | 5 | 0 | 100% | 拦 |
 * | 本地被截断 | 20 | 3 | 85% | 拦 |
 * | 误纳管同事文档 | 4 | 1 | 75% | 拦 |
 * | 全量重写 | 3 | 4 | 变大 | 放行 |
 * | 删掉一段 | 8 | 7 | 12% | 放行 |
 * | 改一段话 | 1 | 1 | 0% | 放行 |
 *
 * 因此判据是：远端块数 ≥ 3 且结果不到远端的一半，且有实际删除。
 * 另设 3 块的下限，避免小文档的正常编辑被反复打扰。
 */
function assessDestructive(params: {
  stats: AlignResult['stats'];
  remoteCount: number;
  /** 账本里没有记录、但远端已有内容 —— 即正在纳管一篇不是本工具建的文档 */
  firstAdoption: boolean;
}): { message: string } | null {
  const { stats, remoteCount, firstAdoption } = params;
  const reasons: string[] = [];

  // 结果里还剩多少块：保留的 + 原地更新的 + 新插入的
  const resultCount = stats.keep + stats.update + stats.insert;

  if (remoteCount >= 3 && stats.remove > 0 && resultCount < remoteCount * 0.5) {
    const pct = Math.round((1 - resultCount / remoteCount) * 100);
    reasons.push(
      `文档会从 ${remoteCount} 个块缩到 ${resultCount} 个块（少 ${pct}%）` +
        (resultCount === 0 ? '，即**整篇清空**' : ''),
    );
  }

  if (firstAdoption && stats.remove + stats.update > 0) {
    reasons.push(
      `这是首次纳管这篇已存在的远端文档（账本里没有它的记录），` +
        `本次会改写其中 ${stats.remove + stats.update} 个块` +
        `；如果它是同事手工维护的文档，那些内容会丢失`,
    );
  }

  if (reasons.length === 0) return null;

  return {
    message:
      `破坏性变更已拦截：${reasons.join('；')}。` +
      `请先确认本地文件内容是否正常（是否被清空/截断、是否与同事的文档重名）；` +
      `确认无误要强制执行，加 --allow-destructive`,
  };
}

function chunkBy<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
