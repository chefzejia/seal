import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
