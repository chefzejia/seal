import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeHostPort } from '../src/shells/node-host.js';
import { KnowledgeBase } from '../src/core/kb/index.js';
import { isValidCreditCode } from '../src/core/kb/credit-code.js';

test('seal-kb-2 stores flat metadata, preserves unknown fields, and logs writes', async t => {
  const home = path.resolve('.tmp', `kb-storage-${randomUUID()}`);
  await fs.mkdir(home, { recursive: true });
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous; await fs.rm(home, { recursive: true, force: true }); });
  const kb = new KnowledgeBase(new NodeHostPort(), path.join(home, 'vaults'));
  const vault = await kb.createVault({ vaultId: 'test-knowledge-base', name: '测试资料柜' });
  assert.equal(vault.format, 'seal-kb-2');
  await assert.rejects(kb.save(vault.vaultId, { action: 'create', kind: 'record', fields: { title: '伪证', verified: true }, body: '' }), /不能设置核实字段/);
  await assert.rejects(kb.save(vault.vaultId, { action: 'update', kind: 'subject', fields: { creditCode: '91350100M000100Y44' } }), /统一社会信用代码/);

  const saved = await kb.save(vault.vaultId, {
    action: 'create', kind: 'record', fields: {
      type: '认证证书', title: '合成证书', number: 'SYNTH-001', holder: '合成主体',
      validUntil: '长期', tags: ['合成', '正控'], futureField: '未知元数据', futureList: ['甲', '乙'],
    }, body: '仅用于测试的合成说明。',
  });
  const id = saved.id!;
  const recordPath = path.join(home, 'vaults', vault.vaultId, 'records', `${id}.md`);
  const serialized = await fs.readFile(recordPath, 'utf8');
  assert.match(serialized, /futureField: "未知元数据"/);
  assert.match(serialized, /futureList:\n  - "甲"\n  - "乙"/);
  assert.match(serialized, /仅用于测试的合成说明/);

  await kb.verify(vault.vaultId, 'record', id, []);
  assert.equal((await kb.get(vault.vaultId, 'record', id)).verified, true);
  const verifiedSerialized = await fs.readFile(recordPath, 'utf8');
  await fs.writeFile(recordPath, verifiedSerialized.replace('futureField: "未知元数据"', 'futureField: "直接篡改"'));
  const tampered = await kb.get(vault.vaultId, 'record', id);
  assert.equal(tampered.verified, false);
  assert.match(tampered.issues.join('\n'), /签名无效/);

  const log = await fs.readFile(path.join(home, 'vaults', vault.vaultId, 'log.jsonl'), 'utf8');
  const events = log.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.object === `record:${id}` && event.actor === 'agent'));
  assert.ok(events.some(event => event.object === `record:${id}` && event.actor === 'human'));
});

test('GB 32100 credit code accepts its worked example and rejects invalid codes', () => {
  assert.equal(isValidCreditCode('91350100M000100Y43'), true);
  assert.equal(isValidCreditCode('91350100M000100Y44'), false);
  assert.equal(isValidCreditCode('I1350100M000100Y43'), false);
});

test('NodeHost validates and attaches PNG/JPEG originals while rejecting corrupt raster bytes', async t => {
  const home = path.resolve('.tmp', `kb-image-${randomUUID()}`);
  await fs.mkdir(home, { recursive: true });
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous; await fs.rm(home, { recursive: true, force: true }); });
  const host = new NodeHostPort(), kb = new KnowledgeBase(host, path.join(home, 'vaults'));
  const vault = await kb.createVault({ vaultId: 'image-evidence-vault', name: '合成图片柜' });
  const record = await kb.save(vault.vaultId, { action: 'create', kind: 'record', fields: { type: '其他', title: '有效图片证据' }, body: '' });
  const png = new Uint8Array(await fs.readFile(path.resolve('tests/fixtures/evidence-2x1.png')));
  const jpeg = new Uint8Array(await fs.readFile(path.resolve('tests/fixtures/evidence-2x1.jpeg')));
  await kb.save(vault.vaultId, { action: 'attach_file', kind: 'record', id: record.id, file: { fileName: 'original.png', bytes: png } });
  await kb.save(vault.vaultId, { action: 'attach_file', kind: 'record', id: record.id, file: { fileName: 'original.jpeg', bytes: jpeg } });
  const logBefore = await fs.readFile(path.join(home, 'vaults', vault.vaultId, 'log.jsonl'), 'utf8');
  await assert.rejects(kb.save(vault.vaultId, { action: 'attach_file', kind: 'record', id: record.id, file: { fileName: 'corrupt.png', bytes: new Uint8Array([1, 2, 3]) } }));
  assert.equal(await fs.stat(path.join(home, 'vaults', vault.vaultId, 'files', record.id!, 'original.png')).then(stat => stat.size), png.length);
  assert.equal(await fs.stat(path.join(home, 'vaults', vault.vaultId, 'files', record.id!, 'original.jpeg')).then(stat => stat.size), jpeg.length);
  await assert.rejects(fs.stat(path.join(home, 'vaults', vault.vaultId, 'files', record.id!, 'corrupt.png')));
  assert.equal(await fs.readFile(path.join(home, 'vaults', vault.vaultId, 'log.jsonl'), 'utf8'), logBefore, 'Invalid images do not append a write event');
});
