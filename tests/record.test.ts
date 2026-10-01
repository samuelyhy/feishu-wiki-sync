import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ApiRecorder, redact } from '../src/record.js';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-rec-'));
  tmpDirs.push(dir);
  return path.join(dir, 'run.jsonl');
}

function readLines(file: string): unknown[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);
}

describe('redact', () => {
  it('替换敏感字段的值，保留结构', () => {
    const out = redact({
      code: 0,
      msg: 'ok',
      tenant_access_token: 't-abcdef',
      expire: 7200,
    }) as Record<string, unknown>;

    assert.equal(out.tenant_access_token, '<redacted>');
    assert.equal(out.expire, 7200, '非敏感字段必须原样保留');
    assert.equal(out.code, 0);
  });

  it('递归处理嵌套结构与数组', () => {
    const out = redact({ data: { items: [{ token: 'x', name: 'y' }] } }) as any;
    assert.equal(out.data.items[0].token, '<redacted>');
    assert.equal(out.data.items[0].name, 'y');
  });

  it('不会因为深度异常而崩', () => {
    let deep: Record<string, unknown> = { token: 'x' };
    for (let i = 0; i < 100; i++) deep = { child: deep };
    assert.doesNotThrow(() => redact(deep));
  });

  it('原值不被修改', () => {
    const input = { tenant_access_token: 'secret' };
    redact(input);
    assert.equal(input.tenant_access_token, 'secret');
  });
});

describe('ApiRecorder', () => {
  it('首次写入时带一行表头，说明这份文件是什么', () => {
    const file = tmpFile();
    ApiRecorder.open(file).record({ method: 'GET', path: '/x', status: 200, durationMs: 1 });

    const lines = readLines(file) as Array<Record<string, unknown>>;
    assert.equal(lines[0]!.kind, 'fws-record-header');
    assert.match(String(lines[0]!.note), /脱敏/);
    assert.equal(lines[1]!.method, 'GET');
  });

  it('追加到已有文件时不重复写表头', () => {
    const file = tmpFile();
    const a = ApiRecorder.open(file);
    a.record({ method: 'GET', path: '/1', status: 200, durationMs: 1 });

    const b = ApiRecorder.open(file);
    b.record({ method: 'GET', path: '/2', status: 200, durationMs: 1 });

    const headers = (readLines(file) as Array<Record<string, unknown>>).filter(
      (l) => l.kind === 'fws-record-header',
    );
    assert.equal(headers.length, 1);
  });

  it('记录里永远不含请求头 —— 那里有 Bearer token', () => {
    const file = tmpFile();
    const r = ApiRecorder.open(file);
    r.record({
      method: 'POST',
      path: '/x',
      status: 200,
      durationMs: 5,
      requestBody: { app_id: 'cli_x', app_secret: 'super-secret' },
      responseBody: { code: 0, tenant_access_token: 't-real-token', expire: 7200 },
    });

    const raw = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(raw, /Bearer/);
    assert.doesNotMatch(raw, /super-secret/, 'app_secret 必须脱敏');
    assert.doesNotMatch(raw, /t-real-token/, 'tenant_access_token 必须脱敏');

    const entry = (readLines(file) as any[])[1];
    assert.equal(entry.requestBody.app_secret, '<redacted>');
    assert.equal(entry.responseBody.tenant_access_token, '<redacted>');
    assert.equal(entry.responseBody.expire, 7200, '结构仍在，可当夹具用');
  });

  it('超大响应体被截断并标注原始长度', () => {
    const file = tmpFile();
    const r = ApiRecorder.open(file);
    r.record({
      method: 'GET',
      path: '/big',
      status: 200,
      durationMs: 5,
      responseBody: { content: 'x'.repeat(3 * 1024 * 1024) },
    });

    const entry = (readLines(file) as any[])[1];
    assert.equal(entry.responseBody.__truncated, true);
    assert.ok(entry.responseBody.originalChars > 3 * 1024 * 1024);
  });

  it('写盘失败不影响调用方，但如实计数', () => {
    // 把一个**目录**当作文件来写 —— 必然失败，且不受平台权限差异影响
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-rec-dir-'));
    tmpDirs.push(dir);

    const r = ApiRecorder.open(dir);
    assert.doesNotThrow(() =>
      r.record({ method: 'GET', path: '/x', status: 200, durationMs: 1 }),
    );
    assert.equal(r.written, 0, '写失败时不该谎报成功');
    assert.equal(r.failureCount, 1);
  });

  it('seq 单调递增，便于还原调用顺序', () => {
    const file = tmpFile();
    const r = ApiRecorder.open(file);
    for (let i = 0; i < 3; i++) {
      r.record({ method: 'GET', path: `/x${i}`, status: 200, durationMs: 1 });
    }
    const entries = (readLines(file) as any[]).filter((l) => l.kind !== 'fws-record-header');
    assert.deepEqual(
      entries.map((e) => e.seq),
      [1, 2, 3],
    );
  });
});
