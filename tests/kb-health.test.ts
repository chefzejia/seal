import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { NodeHostPort } from '../src/shells/node-host.js';
import { KnowledgeBase } from '../src/core/kb/index.js';

test('KnowledgeBase.health distinguishes unknown, invalid, expired, imminent and holder attribution', async t => {
  const home = path.resolve('.tmp', `kb-health-${randomUUID()}`);
  await fs.mkdir(home, { recursive: true });
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous; await fs.rm(home, { recursive: true, force: true }); });
  const kb = new KnowledgeBase(new NodeHostPort(), path.join(home, 'vaults'));
  const vault = await kb.createVault({ vaultId: 'health-vault', name: '合成体检柜' });
  await kb.save(vault.vaultId, { action: 'update', kind: 'subject', fields: {
    legalName: '本企业合成主体', forbiddenAffiliates: ['禁用合成主体'], thirdPartyHolders: ['第三方合成主体'],
  } });
  await kb.verify(vault.vaultId, 'subject', 'subject', ['legalName', 'forbiddenAffiliates', 'thirdPartyHolders']);

  const create = async (title: string, fields: Record<string, string>) => kb.save(vault.vaultId, {
    action: 'create', kind: 'record', fields: { type: '其他', title, holder: '本企业合成主体', ...fields }, body: '',
  });
  const unknown = await create('缺省效期', { number: 'SYN-UNKNOWN' });
  const invalid = await create('非法效期', { number: 'SYN-INVALID', validUntil: '2026-02-28' });
  const expired = await create('已过期', { number: 'SYN-EXPIRED', validUntil: '2026-06-01' });
  const imminent = await create('即将到期', { number: 'SYN-IMMINENT', validUntil: '2026-12-20' });
  const notApplicable = await create('明确不适用', { number: 'SYN-NA', validUntil: '不适用' });
  const forbidden = await create('禁用持证方', { number: 'SYN-FORBIDDEN', holder: '禁用合成主体', validUntil: '长期' });
  const mismatch = await create('主体不符', { number: 'SYN-MISMATCH', holder: '其他合成主体', validUntil: '长期' });
  const thirdParty = await create('允许第三方', { number: 'SYN-THIRD', holder: '第三方合成主体', validUntil: '长期' });
  const personnel = await create('人员证书', { number: 'SYN-PERSON', type: '人员证书', holder: '合成人员', employer: '本企业合成主体', validUntil: '长期' });
  for (const record of [unknown, invalid, expired, imminent, notApplicable, forbidden, mismatch, thirdParty, personnel]) await kb.verify(vault.vaultId, 'record', record.id!, []);
  const invalidPath = path.join(home, 'vaults', vault.vaultId, 'records', `${invalid.id}.md`);
  const invalidMarkdown = await fs.readFile(invalidPath, 'utf8');
  await fs.writeFile(invalidPath, invalidMarkdown.replace('2026-02-28', '2026-02-30'));

  const report = await kb.health(vault.vaultId, '2026-11-19');
  const byTitle = new Map(report.records.map(record => [record.fields.title, record]));
  assert.equal(byTitle.get('缺省效期')?.validity, 'unknown');
  assert.equal(byTitle.get('非法效期')?.validity, 'unknown');
  assert.equal(byTitle.get('已过期')?.validity, 'expired');
  assert.equal(byTitle.get('即将到期')?.validity, 'expiring_soon');
  assert.equal(byTitle.get('明确不适用')?.validity, 'not_applicable');
  assert.equal(byTitle.get('禁用持证方')?.subject, 'forbidden');
  assert.equal(byTitle.get('主体不符')?.subject, 'mismatch');
  assert.equal(byTitle.get('允许第三方')?.subject, 'third_party');
  assert.equal(byTitle.get('人员证书')?.subject, 'self');
  assert.ok(report.issues.some(issue => issue.id === invalid.id && issue.code === 'date_invalid'));
  assert.ok(report.issues.some(issue => issue.id === expired.id && issue.code === 'expired'));
  assert.ok(report.issues.some(issue => issue.id === imminent.id && issue.code === 'expiring_soon'));
  await assert.rejects(kb.health(vault.vaultId, '2026-02-30'), /合法 YYYY-MM-DD/);
});

test('KnowledgeBase.health checkImages modes avoid unnecessary image decodes and vault-wide scans while preserving full checks', async t => {
  const validPng = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 30, g: 120, b: 210, alpha: 1 } },
  }).png().toBuffer();
  const home = path.resolve('.tmp', `kb-health-modes-${randomUUID()}`);
  await fs.mkdir(home, { recursive: true });
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });

  const baseHost = new NodeHostPort();
  let validateImageCalls = 0;
  const listedDirs: string[] = [];
  const spyHost = Object.create(baseHost) as NodeHostPort;
  spyHost.validateImage = async (bytes: Uint8Array, mime: string) => {
    validateImageCalls += 1;
    return baseHost.validateImage(bytes, mime);
  };
  spyHost.listFiles = async (directory: string) => {
    listedDirs.push(directory);
    return baseHost.listFiles(directory);
  };

  const vaultsRoot = path.join(home, 'vaults');
  const kb = new KnowledgeBase(spyHost, vaultsRoot);
  const vault = await kb.createVault({ vaultId: 'mode-vault', name: '体检模式验证柜' });
  await kb.save(vault.vaultId, {
    action: 'update',
    kind: 'subject',
    fields: { legalName: '本企业合成主体' },
  });

  const vaultDir = path.join(vaultsRoot, vault.vaultId);
  await fs.mkdir(path.join(vaultDir, 'files'), { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'inbox', 'batch-1'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'files', 'shared.png'), validPng);
  await fs.writeFile(path.join(vaultDir, 'files', 'corrupt.png'), Buffer.from('not-a-real-png'));
  await fs.writeFile(path.join(vaultDir, 'inbox', 'batch-1', 'candidate-1.md'), '---\nprocessed: true\n---\n');

  const r1 = await kb.save(vault.vaultId, {
    action: 'create',
    kind: 'record',
    fields: { type: '其他', title: '共享图记录一', holder: '本企业合成主体', validUntil: '长期', files: ['files/shared.png'] },
    body: '',
  });
  const r2 = await kb.save(vault.vaultId, {
    action: 'create',
    kind: 'record',
    fields: { type: '其他', title: '共享图记录二', holder: '本企业合成主体', validUntil: '长期', files: ['files/shared.png'] },
    body: '',
  });
  const missingRecord = await kb.save(vault.vaultId, {
    action: 'create',
    kind: 'record',
    fields: { type: '其他', title: '缺文件记录', holder: '本企业合成主体', validUntil: '长期', files: ['files/shared.png'] },
    body: '',
  });
  const corruptRecord = await kb.save(vault.vaultId, {
    action: 'create',
    kind: 'record',
    fields: { type: '其他', title: '坏图记录', holder: '本企业合成主体', validUntil: '长期', files: ['files/shared.png'] },
    body: '',
  });

  // Bypass save-time validation to simulate on-disk drift (missing / corrupted file).
  const missingMd = path.join(vaultDir, 'records', `${missingRecord.id}.md`);
  await fs.writeFile(missingMd, (await fs.readFile(missingMd, 'utf8')).replace('files/shared.png', 'files/missing.png'));
  const corruptMd = path.join(vaultDir, 'records', `${corruptRecord.id}.md`);
  await fs.writeFile(corruptMd, (await fs.readFile(corruptMd, 'utf8')).replace('files/shared.png', 'files/corrupt.png'));

  validateImageCalls = 0;
  listedDirs.length = 0;
  const noneReport = await kb.health(vault.vaultId, '2026-11-19', { checkImages: 'none' });
  assert.equal(validateImageCalls, 0);
  assert.equal(noneReport.records.length, 4);
  assert.ok(!noneReport.issues.some(issue => issue.code === 'file_missing' || issue.code === 'image_invalid'));
  assert.ok(listedDirs.every(dir => dir !== vaultDir && !dir.includes(`${path.sep}files`) && !dir.includes(`${path.sep}inbox`)));

  validateImageCalls = 0;
  const existenceReport = await kb.health(vault.vaultId, '2026-11-19', { checkImages: 'existence' });
  assert.equal(validateImageCalls, 0);
  assert.ok(existenceReport.issues.some(issue => issue.id === missingRecord.id && issue.code === 'file_missing'));
  assert.ok(!existenceReport.issues.some(issue => issue.code === 'image_invalid'));

  validateImageCalls = 0;
  const fullReport = await kb.health(vault.vaultId, '2026-11-19');
  // shared.png is referenced by both r1 and r2, but must only be decoded once per health() call; corrupt.png is the 2nd call.
  assert.equal(validateImageCalls, 2);
  assert.ok(fullReport.issues.some(issue => issue.id === missingRecord.id && issue.code === 'file_missing'));
  assert.ok(fullReport.issues.some(issue => issue.id === corruptRecord.id && issue.code === 'image_invalid'));
  assert.ok(!fullReport.issues.some(issue => (issue.id === r1.id || issue.id === r2.id) && issue.code === 'image_invalid'));

  // NodeHostPort.validateImage caches valid images by content digest without masking corrupted bytes.
  await baseHost.validateImage(validPng, 'image/png');
  await baseHost.validateImage(validPng, 'image/png');
  const idatOffset = validPng.indexOf('IDAT');
  assert.ok(idatOffset > 0);
  const mutated = Buffer.from(validPng);
  mutated[idatOffset + 6] ^= 0xff;
  await assert.rejects(baseHost.validateImage(mutated, 'image/png'));
  await assert.rejects(baseHost.validateImage(validPng.subarray(0, 24), 'image/png'));
});
