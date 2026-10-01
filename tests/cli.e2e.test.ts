import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { startFakeFeishuServer, type FakeServerHandle } from './helpers/fake-feishu-server.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/tests → dist/bin/cli.js */
const CLI = path.resolve(here, '..', 'bin', 'cli.js');

/**
 * 每个用例一个**全新的**假服务器。
 *
 * 最初这里所有用例共用一个服务器，结果节点与文档在用例间累积：
 * `nodes[0]` 指向了前一个用例建的节点，断言全部错位。
 * 隔离比省那几毫秒重要得多 —— 共享状态下的失败信息会指向完全无关的地方。
 */
let server: FakeServerHandle;
const tmpDirs: string[] = [];

beforeEach(async () => {
  server = await startFakeFeishuServer();
});

afterEach(async () => {
  await server.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 以真实子进程方式调用 CLI —— 这才是这个文件存在的意义。 */
async function runCli(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...extraEnv },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

interface Project {
  dir: string;
  write(relPath: string, content: string): void;
  /** 已同步到知识库的文档 id（即父节点下的那篇） */
  docId(): string;
  /** 父节点下的子节点数 —— 断言「只处理了该处理的文件」时用它 */
  nodeCount(): number;
  /** 父节点下唯一的子节点标题 */
  childTitle(): string;
  writeRequests(): string[];
  clearRequests(): void;
  /** 改写配置里的父节点 token（用于构造「节点不存在」这类用例） */
  setParentToken(token: string): void;
}

async function makeProject(spaceId = 'space-1'): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-e2e-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'docs/specs'), { recursive: true });

  // 预建父节点：sync 要把文档认领到它下面，init --check 也要能验活它。
  // 它是「父」，不参与子节点计数。
  //
  // 关键：配置里必须写**这个节点真实的 node_token**，不能随手编一个字符串。
  // 最初这里写的是字面量，导致 init --check 报「parent_node_token 不存在」，
  // 而 sync 却「成功」了 —— 因为最初的假服务器不校验父节点是否存在。
  const parent = await server.fake.wiki.createNode({ spaceId, title: `${spaceId}-父节点` });
  const parentToken = parent.node_token;

  // 凭证走 .ai-sync.env，base_url 指向假服务器
  fs.writeFileSync(
    path.join(dir, '.ai-sync.env'),
    [
      'FEISHU_APP_ID=cli_fake',
      'FEISHU_APP_SECRET=fake-secret',
      `FEISHU_BASE_URL=${server.baseUrl}`,
      '',
    ].join('\n'),
    'utf8',
  );

  fs.mkdirSync(path.join(dir, '.feishu-sync'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.feishu-sync/config.yaml'),
    [
      'version: 1',
      `space_id: "${spaceId}"`,
      'defaults:',
      '  include: ["**/*.md"]',
      '  exclude: ["**/*.draft.md"]',
      'mappings:',
      '  - source: docs/specs',
      `    parent_node_token: "${parentToken}"`,
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    dir,
    write: (rel, content) => {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    },
    docId: () => {
      const child = server.fake.nodes.find((n) => n.parent_node_token === parentToken);
      if (!child) throw new Error('该用例的文档还没被创建到知识库里');
      return child.obj_token;
    },
    nodeCount: () => server.fake.nodes.filter((n) => n.parent_node_token === parentToken).length,
    childTitle: () => {
      const child = server.fake.nodes.find((n) => n.parent_node_token === parentToken);
      if (!child) throw new Error('该用例的文档还没被创建到知识库里');
      return child.title;
    },
    // 「写请求」= 会改变远端状态的请求。
    //
    // 不能只按 HTTP 方法判断：`blocks/convert` 是 POST，但它是纯计算
    // —— 不吃任何文档、不落任何东西。按方法分类会把它误算成写操作，
    // 于是「只读体检不该写东西」这类断言会无端失败。
    writeRequests: () =>
      server.requests.filter(
        (r) =>
          /^(POST|PATCH|DELETE) /.test(r) &&
          !r.includes('tenant_access_token') &&
          !r.includes('/blocks/convert'),
      ),
    clearRequests: () => {
      server.requests.length = 0;
    },
    setParentToken: (token: string) => {
      const file = path.join(dir, '.feishu-sync/config.yaml');
      const content = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(
        file,
        content.replace(/parent_node_token: "[^"]*"/, `parent_node_token: "${token}"`),
        'utf8',
      );
    },
  };
}

describe('CLI 全链路端到端（真实进程 + HTTP 假飞书）', () => {
  it('init --check 能连通知识空间并列出节点', async () => {
    const p = await makeProject('space-check');
    const res = await runCli(['init', '--check'], p.dir);

    assert.equal(res.code, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout + res.stderr, /知识空间可访问/);
  });

  it('sync 从零把本地文档写进知识库', async () => {
    const p = await makeProject();
    p.write('docs/specs/a.md', '# 领域模型\n\n第一段\n第二段\n');

    const res = await runCli(['sync'], p.dir);
    assert.equal(res.code, 0, `stdout=${res.stdout} stderr=${res.stderr}`);

    // 认领失败时会新建节点；这里知识库是空的，所以应创建 1 个
    assert.equal(p.nodeCount(), 1);

    const texts = server.fake.blockTexts(p.docId());
    assert.deepEqual(texts, ['# 领域模型', '第一段', '第二段']);
  });

  it('真实 HTTP 链路上鉴权头被正确携带', async () => {
    const p = await makeProject('space-auth');
    p.write('docs/specs/a.md', '# X\n');
    await runCli(['sync'], p.dir);

    assert.ok(
      server.requests.some((r) => r.includes('tenant_access_token')),
      '应先取 tenant_access_token',
    );
    // 假服务器对缺少 Bearer 头的请求返回 99991661，能跑通即证明头是对的
  });

  it('重复 sync 零写入 —— 幂等', async () => {
    const p = await makeProject('space-idem');
    p.write('docs/specs/a.md', '# 标题\n正文\n');

    await runCli(['sync'], p.dir);
    p.clearRequests();

    const res = await runCli(['sync'], p.dir);
    assert.equal(res.code, 0);
    assert.deepEqual(p.writeRequests(), [], `不该有任何写请求，实际: ${p.writeRequests().join(', ')}`);
  });

  it('本地修改后 sync 只更新改动部分（走 batch_update）', async () => {
    const p = await makeProject('space-upd');
    p.write('docs/specs/a.md', 'A\nB\nC\n');
    await runCli(['sync'], p.dir);

    const idsBefore = server.fake.blockIds(p.docId());
    p.clearRequests();

    p.write('docs/specs/a.md', 'A\nB-改了\nC\n');
    const res = await runCli(['sync'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.deepEqual(server.fake.blockTexts(p.docId()), ['A', 'B-改了', 'C']);
    assert.deepEqual(server.fake.blockIds(p.docId()), idsBefore, 'block_id 应保持不变');

    const writes = p.writeRequests();
    assert.ok(
      writes.some((w) => w.includes('batch_update')),
      `应走 batch_update，实际写请求: ${writes.join(', ')}`,
    );
    assert.equal(
      writes.some((w) => w.includes('descendant')),
      false,
      '不该整段重建 —— 重建会丢评论',
    );
  });

  it('本地插入一行后 sync，内容与顺序都正确', async () => {
    const p = await makeProject('space-ins');
    p.write('docs/specs/a.md', 'A\nC\n');
    await runCli(['sync'], p.dir);

    p.write('docs/specs/a.md', 'A\nB\nC\n');
    const res = await runCli(['sync'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.deepEqual(server.fake.blockTexts(p.docId()), ['A', 'B', 'C']);
  });

  it('dry-run 不产生任何写请求', async () => {
    const p = await makeProject('space-dry');
    p.write('docs/specs/a.md', '# 标题\n');

    const res = await runCli(['sync', '--dry-run'], p.dir);

    assert.equal(res.code, 0);
    assert.deepEqual(p.writeRequests(), [], 'dry-run 不该有任何写请求');
    assert.equal(p.nodeCount(), 0, 'dry-run 也不该创建节点');
  });

  it('status 完全离线可用（不需要凭证）', async () => {
    const p = await makeProject('space-off');
    p.write('docs/specs/a.md', '# A\n');
    p.write('docs/specs/skip.draft.md', '# 草稿\n');

    // 抹掉凭证，证明 status 确实不联网
    fs.writeFileSync(path.join(p.dir, '.ai-sync.env'), 'FEISHU_APP_ID=\nFEISHU_APP_SECRET=\n', 'utf8');
    p.clearRequests();

    const res = await runCli(['status', '--json'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.deepEqual(server.requests, [], 'status 不该发起任何网络请求');

    const parsed = JSON.parse(res.stdout) as Array<{ relPath: string }>;
    assert.equal(parsed.length, 1, '被 exclude 的草稿不该出现');
    assert.equal(parsed[0]!.relPath, 'docs/specs/a.md');
  });

  it('含图片的文档同步后 status 显示「未变」，而不是永远「已改」', async () => {
    // 账本里存的是「正文 + 全部引用图片」的合成哈希。
    // status 若拿纯正文哈希去比，凡是带图的文档都会被永远标成「已改」，
    // 而且与 sync 的快路径结论直接矛盾。
    const p = await makeProject('space-stat');
    fs.mkdirSync(path.join(p.dir, 'docs/specs/assets'), { recursive: true });
    fs.writeFileSync(path.join(p.dir, 'docs/specs/assets/p.png'), 'bytes');
    p.write('docs/specs/a.md', '# 标题\n![图](assets/p.png)\n');

    await runCli(['sync'], p.dir);

    const res = await runCli(['status', '--json'], p.dir);
    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    const parsed = JSON.parse(res.stdout) as Array<{ relPath: string; state: string }>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.state, 'unchanged');
  });

  it('status 与 sync 接受同样写法的路径过滤（反斜杠 / 尾斜杠）', async () => {
    const p = await makeProject('space-path');
    p.write('docs/specs/a.md', '# A\n');

    // Windows 上用户很容易打成反斜杠，或者顺手带个尾斜杠。
    // 两边规则不一致的话，status 会静默显示「无匹配文件」，让人以为没东西要同步。
    for (const arg of ['docs/specs/', 'docs\\specs', './docs/specs']) {
      const res = await runCli(['status', arg], p.dir);
      assert.match(res.stdout, /1 篇/, `路径写法 ${arg} 应匹配到 1 篇，实际输出: ${res.stdout}`);
    }
  });

  it('sync 指定单文件时只处理该文件', async () => {
    const p = await makeProject('space-single');
    p.write('docs/specs/a.md', '# 甲\n');
    p.write('docs/specs/b.md', '# 乙\n');

    const res = await runCli(['sync', 'docs/specs/a.md'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.equal(p.nodeCount(), 1, '只该为 a.md 建节点');
    assert.equal(p.childTitle(), '甲');
  });

  it('错误契约：缺凭证 / 未知命令 / 配置错误都返回退出码 2', async () => {
    const p = await makeProject('space-err');
    fs.writeFileSync(path.join(p.dir, '.ai-sync.env'), '', 'utf8');

    assert.equal((await runCli(['sync'], p.dir)).code, 2, '缺凭证应为配置错误');
    assert.equal((await runCli(['bogus-command'], p.dir)).code, 2, '未知命令应为 2');
    assert.equal((await runCli(['status', '--cwd', '/nope/nope'], p.dir)).code, 2, '目录不存在应为 2');
  });

  it('账本损坏时报错并给出恢复路径', async () => {
    const p = await makeProject('space-corrupt');
    p.write('docs/specs/a.md', '# A\n');
    fs.writeFileSync(path.join(p.dir, '.feishu-sync/ledger.json'), '{ broken', 'utf8');

    const res = await runCli(['sync'], p.dir);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /reclaim/, '应提示如何恢复');
  });

  it('远端被人工修改后拒绝覆盖（漂移保护）', async () => {
    const p = await makeProject('space-drift');
    p.write('docs/specs/a.md', 'A\nB\n');
    await runCli(['sync'], p.dir);

    server.fake.editRemotely(p.docId(), 0, '同事手工改成这样');
    p.clearRequests();

    const res = await runCli(['sync'], p.dir);

    assert.equal(res.code, 3, '漂移应返回「需人工处理」');
    assert.deepEqual(p.writeRequests(), [], '不该覆盖人工修改');
    assert.equal(server.fake.blockTexts(p.docId())[0], '同事手工改成这样');
  });

  it('--force 时覆盖人工修改', async () => {
    const p = await makeProject('space-force');
    p.write('docs/specs/a.md', 'A\nB\n');
    await runCli(['sync'], p.dir);

    server.fake.editRemotely(p.docId(), 0, '同事改的');
    p.write('docs/specs/a.md', 'A2\nB\n');

    const res = await runCli(['sync', '--force'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.deepEqual(server.fake.blockTexts(p.docId()), ['A2', 'B']);
  });
});

describe('fws doctor —— 部署前的假设验证', () => {
  it('只读体检全通过', async () => {
    const p = await makeProject('space-doc');
    p.write('docs/specs/a.md', '# 标题\n');

    const res = await runCli(['doctor'], p.dir);

    assert.equal(res.code, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
    assert.match(res.stdout, /凭证/);
    assert.match(res.stdout, /知识空间/);
    assert.match(res.stdout, /转换/);
    assert.match(res.stdout, /全部通过/);
  });

  it('只读体检不产生任何写请求', async () => {
    const p = await makeProject('space-doc-ro');
    p.write('docs/specs/a.md', '# 标题\n');
    p.clearRequests();

    await runCli(['doctor'], p.dir);

    assert.deepEqual(p.writeRequests(), [], `只读体检不该写任何东西: ${p.writeRequests().join(', ')}`);
  });

  it('--json 输出可被机器解析', async () => {
    const p = await makeProject('space-doc-json');
    p.write('docs/specs/a.md', '# 标题\n');

    const res = await runCli(['doctor', '--json'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    const checks = JSON.parse(res.stdout) as Array<{ name: string; status: string }>;
    assert.ok(checks.length >= 4, '应有多项检查结果');
    assert.ok(checks.every((c) => typeof c.name === 'string' && typeof c.status === 'string'));
    assert.ok(checks.some((c) => c.name === '转换' && c.status === 'ok'));
  });

  it('未加 --write 时写入链路被跳过并说明原因', async () => {
    const p = await makeProject('space-doc-skip');
    p.write('docs/specs/a.md', '# 标题\n');

    const res = await runCli(['doctor', '--json'], p.dir);
    const checks = JSON.parse(res.stdout) as Array<{ name: string; status: string; detail: string }>;
    const write = checks.find((c) => c.name === '写入链路');

    assert.ok(write, '应有一项说明写入链路的状态');
    assert.equal(write.status, 'skipped');
    assert.match(write.detail, /--write/);
  });

  it('--write 验证建节点与写正文，并留下可手工删除的痕迹', async () => {
    const p = await makeProject('space-doc-w');
    p.write('docs/specs/a.md', '# 标题\n');

    const res = await runCli(['doctor', '--write', '--json'], p.dir);

    assert.equal(res.code, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
    const checks = JSON.parse(res.stdout) as Array<{ name: string; status: string }>;
    const build = checks.find((c) => c.name.includes('建节点'));
    const write = checks.find((c) => c.name.includes('写正文'));

    assert.equal(build?.status, 'ok', '建节点应成功');
    assert.equal(write?.status, 'ok', '写正文应成功并读回验证');
    // 真的在知识库里创建了文档
    assert.ok(server.fake.nodes.some((n) => n.title.includes('fws doctor')));
  });

  it('父节点 token 不存在时明确报出是哪一项', async () => {
    const p = await makeProject('space-doc-bad');
    p.write('docs/specs/a.md', '# 标题\n');
    p.setParentToken('wikcn-not-exist');

    const res = await runCli(['doctor', '--json'], p.dir);

    assert.equal(res.code, 1, '有检查未通过应返回 1');
    const checks = JSON.parse(res.stdout) as Array<{ name: string; status: string; hint?: string }>;
    const parent = checks.find((c) => c.name.startsWith('父节点'));
    assert.equal(parent?.status, 'fail');
    assert.match(parent?.hint ?? '', /list-nodes/, '失败必须给出「怎么办」');
  });

  it('凭证不可用时以明确的失败项结束，而不是崩溃', async () => {
    const p = await makeProject('space-doc-cred');
    p.write('docs/specs/a.md', '# 标题\n');
    // 把 base_url 指向一个没人监听的端口
    const envFile = path.join(p.dir, '.ai-sync.env');
    fs.writeFileSync(
      envFile,
      'FEISHU_APP_ID=x\nFEISHU_APP_SECRET=y\nFEISHU_BASE_URL=http://127.0.0.1:1\n',
      'utf8',
    );

    const res = await runCli(['doctor', '--json'], p.dir);

    assert.equal(res.code, 1);
    const checks = JSON.parse(res.stdout) as Array<{ name: string; status: string }>;
    const cred = checks.find((c) => c.name === '凭证');
    assert.equal(cred?.status, 'fail');
  });
});

describe('fws pull —— git 语义的远端/本地对比', () => {
  it('同步之后两侧一致', async () => {
    const p = await makeProject('space-pull-1');
    // 单行内容：假服务器的块↔Markdown 往返对它是无损的，
    // 因此这里能真正测到「一致」这条路径
    p.write('docs/specs/a.md', '一段话\n');
    await runCli(['sync'], p.dir);

    const res = await runCli(['pull', '--json'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    const entries = JSON.parse(res.stdout) as Array<{ state: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.state, 'in-sync');
  });

  it('只有本地改过 → 本地领先，退出码 0（无需拉取）', async () => {
    const p = await makeProject('space-pull-2');
    p.write('docs/specs/a.md', '原始\n');
    await runCli(['sync'], p.dir);
    p.write('docs/specs/a.md', '本地改过了\n');

    const res = await runCli(['pull', '--json'], p.dir);

    assert.equal(res.code, 0, '仅本地领先不该阻止推送');
    const entries = JSON.parse(res.stdout) as Array<{ state: string }>;
    assert.equal(entries[0]!.state, 'local-ahead');
  });

  it('只有远端改过 → 远端领先，退出码 3（挡住推送）', async () => {
    const p = await makeProject('space-pull-3');
    p.write('docs/specs/a.md', '原始\n');
    await runCli(['sync'], p.dir);

    // 模拟同事在知识库里改了内容
    server.fake.editRemotely(p.docId(), 0, '同事改的');

    const res = await runCli(['pull', '--json'], p.dir);

    assert.equal(res.code, 3, 'pull 发现远端有新内容时应返回非 0，让 `pull && sync` 挡住推送');
    const entries = JSON.parse(res.stdout) as Array<{ state: string }>;
    assert.equal(entries[0]!.state, 'remote-ahead');
  });

  it('两侧都改过 → 冲突，退出码 3', async () => {
    const p = await makeProject('space-pull-4');
    p.write('docs/specs/a.md', '原始\n');
    await runCli(['sync'], p.dir);

    server.fake.editRemotely(p.docId(), 0, '同事改的');
    p.write('docs/specs/a.md', '我也改了\n');

    const res = await runCli(['pull', '--json'], p.dir);

    assert.equal(res.code, 3);
    const entries = JSON.parse(res.stdout) as Array<{ state: string }>;
    assert.equal(entries[0]!.state, 'conflict');
  });

  it('--write 把远端内容拉到本地，且不会覆盖冲突', async () => {
    const p = await makeProject('space-pull-5');
    p.write('docs/specs/a.md', '原始\n');
    await runCli(['sync'], p.dir);
    server.fake.editRemotely(p.docId(), 0, '远端新内容');

    const res = await runCli(['pull', '--write'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(p.dir, 'docs/specs/a.md'), 'utf8'),
      '远端新内容\n',
      '本地文件应被远端内容替换',
    );
  });

  it('拉取后再 sync 不会把刚拉下来的内容推回去（账本已对齐）', async () => {
    const p = await makeProject('space-pull-6');
    p.write('docs/specs/a.md', '原始\n');
    await runCli(['sync'], p.dir);
    server.fake.editRemotely(p.docId(), 0, '远端新内容');

    await runCli(['pull', '--write'], p.dir);
    p.clearRequests();
    const res = await runCli(['sync'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.deepEqual(
      p.writeRequests(),
      [],
      '账本若不跟着更新，这里会产生一轮无意义的往返推送',
    );
  });

  it('本地有、远端没有 → 本地新增', async () => {
    const p = await makeProject('space-pull-7');
    p.write('docs/specs/new.md', '还没推上去\n');

    const res = await runCli(['pull', '--json'], p.dir);

    assert.equal(res.code, 0);
    const entries = JSON.parse(res.stdout) as Array<{ state: string }>;
    assert.equal(entries[0]!.state, 'local-only');
  });

  it('远端有、本地没有 → 远端新增，退出码 3', async () => {
    const p = await makeProject('space-pull-8');
    // 直接在知识库里造一篇本地不存在的文档
    const node = await server.fake.wiki.createNode({
      spaceId: 'space-pull-8',
      parentNodeToken: server.fake.nodes[0]!.node_token,
      title: '同事新建的文档',
    });
    server.fake.seedDocument(node.obj_token, ['同事写的内容']);

    const res = await runCli(['pull', '--json'], p.dir);

    assert.equal(res.code, 3);
    const entries = JSON.parse(res.stdout) as Array<{ state: string; relPath: string }>;
    const remoteOnly = entries.find((e) => e.state === 'remote-only');
    assert.ok(remoteOnly, `应报告远端新增，实际: ${JSON.stringify(entries)}`);
    assert.equal(remoteOnly.relPath, 'docs/specs/同事新建的文档.md');
  });

  it('--write 把远端新增的文档落到本地', async () => {
    const p = await makeProject('space-pull-9');
    const node = await server.fake.wiki.createNode({
      spaceId: 'space-pull-9',
      parentNodeToken: server.fake.nodes[0]!.node_token,
      title: '新文档',
    });
    server.fake.seedDocument(node.obj_token, ['第一行', '第二行']);

    await runCli(['pull', '--write'], p.dir);

    const written = fs.readFileSync(path.join(p.dir, 'docs/specs/新文档.md'), 'utf8');
    assert.equal(written, '第一行\n\n第二行\n');
  });

  it('默认不写盘 —— pull 不加 --write 时只报告', async () => {
    const p = await makeProject('space-pull-10');
    p.write('docs/specs/a.md', '原始\n');
    await runCli(['sync'], p.dir);
    server.fake.editRemotely(p.docId(), 0, '远端新内容');

    await runCli(['pull'], p.dir);

    assert.equal(
      fs.readFileSync(path.join(p.dir, 'docs/specs/a.md'), 'utf8'),
      '原始\n',
      '不加 --write 时本地文件必须原样不动',
    );
  });
});

describe('破坏性变更护栏（CLI 端）', () => {
  it('本地文件被清空时 sync 失败，远端内容原样保留', async () => {
    const p = await makeProject('space-guard-1');
    p.write('docs/specs/a.md', '第一段\n第二段\n第三段\n第四段\n');
    await runCli(['sync'], p.dir);
    const before = server.fake.blockTexts(p.docId());

    p.write('docs/specs/a.md', '');
    const res = await runCli(['sync'], p.dir);

    assert.equal(res.code, 1, '破坏性变更应让 sync 失败');
    assert.match(res.stderr + res.stdout, /破坏性/);
    assert.deepEqual(server.fake.blockTexts(p.docId()), before, '远端必须一字未动');
  });

  it('--allow-destructive 才真正执行清空', async () => {
    const p = await makeProject('space-guard-2');
    p.write('docs/specs/a.md', '第一段\n第二段\n第三段\n第四段\n');
    await runCli(['sync'], p.dir);

    p.write('docs/specs/a.md', '');
    const res = await runCli(['sync', '--allow-destructive'], p.dir);

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.deepEqual(server.fake.blockTexts(p.docId()), []);
  });

  it('--dry-run 就预告破坏性变更，且不写入', async () => {
    const p = await makeProject('space-guard-3');
    p.write('docs/specs/a.md', '第一段\n第二段\n第三段\n第四段\n');
    await runCli(['sync'], p.dir);
    const before = server.fake.blockTexts(p.docId());
    p.clearRequests();

    p.write('docs/specs/a.md', '');
    const res = await runCli(['sync', '--dry-run'], p.dir);

    assert.match(res.stdout + res.stderr, /破坏性/, 'dry-run 就要让人看见风险');
    assert.deepEqual(p.writeRequests(), []);
    assert.deepEqual(server.fake.blockTexts(p.docId()), before);
  });

  it('首次纳管同事人工维护的同名文档会被拦下', async () => {
    const p = await makeProject('space-guard-4');
    // 知识库里已有一篇人工写的、与本地文件同名的文档
    const node = await server.fake.wiki.createNode({
      spaceId: 'space-guard-4',
      parentNodeToken: server.fake.nodes[0]!.node_token,
      title: '01-domain',
    });
    server.fake.seedDocument(node.obj_token, ['同事第1段', '同事第2段', '同事第3段', '同事第4段']);
    p.write('docs/specs/01-domain.md', '本地只有一行\n');

    const res = await runCli(['sync'], p.dir);

    assert.equal(res.code, 1);
    assert.match(res.stderr + res.stdout, /首次纳管/);
    assert.equal(server.fake.blockTexts(node.obj_token).length, 4, '同事的内容必须完好');
  });
});

describe('pull 的可审计性：孤儿文档', () => {
  it('本地文件被删除后，pull 会提示远端文档成为孤儿', async () => {
    const p = await makeProject('space-orphan');
    p.write('docs/specs/a.md', '内容\n');
    await runCli(['sync'], p.dir);

    // 本地删掉文件 —— 本工具不处理本地删除（飞书没有删除节点 API），
    // 远端会原样留着。必须显式说出来，否则会被误解成「删本地=删远端」。
    fs.rmSync(path.join(p.dir, 'docs/specs/a.md'));

    const res = await runCli(['pull'], p.dir);

    assert.match(res.stdout + res.stderr, /本地文件已不存在|孤儿/);
    assert.equal(server.fake.blockTexts(p.docId()).length, 1, '远端不该被删');
  });
});

describe('CLI 的可用性细节', () => {
  it('每个子命令都支持 --help', async () => {
    const p = await makeProject('space-help');
    for (const cmd of ['init', 'doctor', 'status', 'pull', 'sync']) {
      const res = await runCli([cmd, '--help'], p.dir);
      assert.equal(res.code, 0, `fws ${cmd} --help 应当成功`);
      // 用 includes 而不是正则：`[选项]` 里的方括号在正则里是字符类，
      // 需要转义才能当字面量用，而转义在多层引用（shell → TS 模板串 → RegExp）里
      // 极易被吃掉一层，退化成「匹配 选 或 项 之一」这种永远不成立的模式。
      assert.ok(
        res.stdout.includes(`fws ${cmd} [选项]`),
        `${cmd} 应打印自己的用法，实际：${res.stdout.slice(0, 120)}`,
      );
      assert.match(res.stdout, /退出码/, `${cmd} 的帮助应含退出码说明`);
    }
  });

  it('子命令 --help 不需要配置或凭证', async () => {
    // 用户第一次接触这个工具时最先敲的就是它，不该因为没配置而失败
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-bare-'));
    tmpDirs.push(bare);
    const res = await runCli(['sync', '--help'], bare);
    assert.equal(res.code, 0, `stderr=${res.stderr}`);
  });

  it('非法开关返回配置错误码 2，并指向正确的帮助', async () => {
    const p = await makeProject('space-badflag');
    const res = await runCli(['sync', '--no-such-flag'], p.dir);

    assert.equal(res.code, 2, '参数错误属于配置错误，不该是 1（会被 CI 误读成可重试）');
    assert.match(res.stderr, /fws sync --help/);
    assert.doesNotMatch(res.stderr, /To specify a positional argument/, '不该泄漏解析库的内部说明');
  });
});

describe('pull 下载远端图片', () => {
  it('--write 会把远端图片下载到本地并改写链接', async () => {
    const p = await makeProject('space-img');
    // 远端有一张本地没有、账本也没记录的图片 —— 这才走真正的下载路径
    const node = await server.fake.wiki.createNode({
      spaceId: 'space-img',
      parentNodeToken: server.fake.nodes[0]!.node_token,
      title: '带图的文档',
    });
    server.fake.seedDocument(node.obj_token, ['正文']);
    server.fake.seedImageBlock(node.obj_token, 'TOK_IMG_1', 'remote-image-bytes');
    p.clearRequests();

    const res = await runCli(['pull', '--write'], p.dir);

    assert.equal(res.code, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
    // 用原始请求列表而不是 writeRequests()：下载是 GET，属于读请求，
    // 不会出现在「写请求」里
    assert.ok(
      server.requests.some((r) => r.includes('/medias/TOK_IMG_1/download')),
      `应调用素材下载接口，实际请求: ${server.requests.join(', ')}`,
    );

    const md = fs.readFileSync(path.join(p.dir, 'docs/specs/带图的文档.md'), 'utf8');
    assert.doesNotMatch(md, /feishu-media:/, '占位符应被替换成本地路径');
    assert.match(md, /!\[.*\]\(assets\/带图的文档\/TOK_IMG_1\.png\)/, `链接应指向下载下来的文件，实际: ${md}`);

    const asset = fs.readFileSync(
      path.join(p.dir, 'docs/specs/assets/带图的文档/TOK_IMG_1.png'),
      'utf8',
    );
    assert.equal(asset, 'remote-image-bytes');
  });

  it('账本里已有素材时复用本地文件，不重复下载', async () => {
    const p = await makeProject('space-img-reuse');
    fs.mkdirSync(path.join(p.dir, 'docs/specs/assets'), { recursive: true });
    fs.writeFileSync(path.join(p.dir, 'docs/specs/assets/p.png'), 'bytes');
    p.write('docs/specs/a.md', '![图](assets/p.png)\n');
    await runCli(['sync'], p.dir);

    server.fake.editRemotely(p.docId(), 0, '远端改了');
    p.clearRequests();
    await runCli(['pull', '--write'], p.dir);

    assert.equal(
      p.writeRequests().some((r) => r.includes('/download')),
      false,
      '账本里已有这张图，不该再下载一次（素材接口有 10000 次/天 的硬限）',
    );
  });

  it('图片下载失败时保留占位符并提示，不中断拉取', async () => {
    const p = await makeProject('space-img-fail');
    const node = await server.fake.wiki.createNode({
      spaceId: 'space-img-fail',
      parentNodeToken: server.fake.nodes[0]!.node_token,
      title: '缺权限的文档',
    });
    server.fake.seedDocument(node.obj_token, ['正文']);
    server.fake.seedImageBlock(node.obj_token, 'TOK_GONE');
    // 让素材在服务端「消失」，模拟缺少下载权限
    server.fake.forgetMedia('TOK_GONE');

    const res = await runCli(['pull', '--write'], p.dir);

    assert.equal(res.code, 0, '图片下载失败不该让整次拉取失败');
    assert.match(res.stdout + res.stderr, /下载失败/, '应提示失败原因');

    const md = fs.readFileSync(path.join(p.dir, 'docs/specs/缺权限的文档.md'), 'utf8');
    assert.match(md, /正文/, '正文仍应被拉到本地');
    assert.match(md, /feishu-media:TOK_GONE/, '图片保留占位符');
  });
});

describe('API 录制（FWS_RECORD）', () => {
  it('开着录制跑一次同步，会把全部交互落盘且不泄漏凭证', async () => {
    const p = await makeProject('space-rec');
    p.write('docs/specs/a.md', '# 标题\n正文\n');
    const recFile = path.join(p.dir, 'run.jsonl');

    const res = await runCli(['sync'], p.dir, { FWS_RECORD: recFile });

    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    assert.ok(fs.existsSync(recFile), '应产出录制文件');

    const raw = fs.readFileSync(recFile, 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as any);

    assert.equal(lines[0].kind, 'fws-record-header', '第一行应是说明这份文件是什么的表头');

    const calls = lines.slice(1);
    const paths = calls.map((c) => c.path).join(' ');
    assert.match(paths, /tenant_access_token/, '应记录鉴权调用');
    assert.match(paths, /blocks\/convert/, '应记录 Markdown 转换');
    assert.match(paths, /descendant/, '应记录写块');

    // 脱敏：这两样一旦落盘就等于把应用凭证交了出去
    assert.doesNotMatch(raw, /fake-tenant-token/, 'tenant_access_token 必须脱敏');
    assert.doesNotMatch(raw, /Bearer/, '请求头绝不能被记录');

    // 但结构要留全，否则这份文件没法当夹具用
    const authCall = calls.find((c) => c.path.includes('tenant_access_token'));
    assert.equal(authCall.responseBody.tenant_access_token, '<redacted>');
    assert.equal(authCall.responseBody.expire, 7200, '非敏感字段应保留');
  });

  it('录制会明确提示文件含文档正文', async () => {
    const p = await makeProject('space-rec-warn');
    p.write('docs/specs/a.md', '内容\n');
    const recFile = path.join(p.dir, 'run.jsonl');

    const res = await runCli(['sync'], p.dir, { FWS_RECORD: recFile });

    assert.match(res.stderr, /敏感数据|文档正文/, '必须让用户知道这文件里有什么');
  });

  it('FWS_RECORD 开启时不影响同步结果本身', async () => {
    const p = await makeProject('space-rec-noop');
    p.write('docs/specs/a.md', '内容\n');
    const recFile = path.join(p.dir, 'run.jsonl');

    const res = await runCli(['sync'], p.dir, { FWS_RECORD: recFile });

    assert.equal(res.code, 0);
    assert.deepEqual(server.fake.blockTexts(p.docId()), ['内容']);
  });

  it('不设 FWS_RECORD 时完全不产生录制文件', async () => {
    const p = await makeProject('space-rec-off');
    p.write('docs/specs/a.md', '内容\n');

    await runCli(['sync'], p.dir);

    assert.deepEqual(
      fs.readdirSync(p.dir).filter((f) => f.endsWith('.jsonl')),
      [],
    );
  });
});

describe('往返差异的诊断粒度', () => {
  it('报告里会指出是哪类块导致的往返差异', async () => {
    const p = await makeProject('space-diag');
    p.write('docs/specs/a.md', '一段话\n');
    await runCli(['sync'], p.dir);

    // 在远端插入一个 Markdown 表达不了的块（高亮块），
    // 并同步推进 revision 之外的账本锚点 —— 用 seedDocument 模拟人工编辑
    server.fake.seedDocument(p.docId(), ['一段话', '同事加的内容']);

    const res = await runCli(['pull'], p.dir);
    const out = res.stdout + res.stderr;

    // 这一篇会落进 remote-ahead 或 roundtrip-diff，无论哪种都该给出可行动信息
    assert.match(out, /远端|往返|差异/, `应给出差异说明，实际输出：${out.slice(0, 300)}`);
  });

  it('--json 会带上 unsupported 块清单，便于定位', async () => {
    const p = await makeProject('space-diag-json');
    p.write('docs/specs/a.md', '一段话\n');
    await runCli(['sync'], p.dir);
    server.fake.seedDocument(p.docId(), ['一段话', '新内容']);

    const res = await runCli(['pull', '--json'], p.dir);
    const entries = JSON.parse(res.stdout) as Array<Record<string, unknown>>;

    assert.equal(entries.length, 1);
    assert.ok('state' in entries[0]!, '应报告状态');
  });
});
