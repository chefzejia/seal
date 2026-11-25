import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KbEntry } from '../src/core/kb/types.js';
import { recordFactSource, resolveFactReferences, type FactRecord } from '../src/core/bid/facts.js';

function record(overrides: Partial<FactRecord> = {}): FactRecord {
  const entry: KbEntry = { id: 'record-1', kind: 'record', fields: { type: '其他', title: '合成记录', number: 'SYN-01', holder: '本企业' }, body: '', verified: true, verifiedFields: [], issues: [] };
  return { ...entry, validity: 'valid', subject: 'self', ...overrides };
}

test('fact references resolve exact current fields and reject missing sources', () => {
  const subject: KbEntry = { id: 'subject', kind: 'subject', fields: { legalName: '本企业' }, body: '', verified: true, verifiedFields: ['legalName'], issues: [] };
  const context = { deadline: '2028-02-29', subject, records: new Map([['record-1', record()]]), quotes: new Map([['tender/quote.txt', '逐字原文片段']]) };
  const resolved = resolveFactReferences('主体 {{subject.legalName}}，编号 {{record:record-1.number}}', context);
  assert.equal(resolved.value, '主体 本企业，编号 SYN-01');
  assert.equal(resolved.verified, true);
  assert.equal(resolved.sources.length, 2);
  assert.equal(resolveFactReferences('{{quote:tender/quote.txt|逐字原文片段}}', context).verified, true);
  assert.throws(() => resolveFactReferences('{{record:missing.number}}', context), /不存在/);
  assert.throws(() => resolveFactReferences('{{record:record-1.missing}}', context), /字段不存在/);
  assert.throws(() => resolveFactReferences('{{quote:tender/quote.txt|不存在的文本}}', context), /不存在或不匹配/);
});

test('fact reference guards current evidence date and holder, including explicit third-party attribution', () => {
  const expired = record({ validity: 'expired' });
  const forbidden = record({ subject: 'forbidden' });
  const mismatch = record({ subject: 'mismatch' });
  const thirdParty = record({ fields: { type: '其他', title: '第三方证据', number: 'SYN-THIRD', holder: '第三方主体' }, subject: 'third_party' });
  assert.throws(() => recordFactSource(expired, '{{record:record-1.number}}'), /已过期/);
  assert.throws(() => recordFactSource(forbidden, '{{record:record-1.number}}'), /禁用/);
  assert.throws(() => recordFactSource(mismatch, '{{record:record-1.number}}'), /不符/);
  assert.throws(() => recordFactSource(thirdParty, '{{record:record-1.number}}'), /必须声明/);
  assert.equal(recordFactSource(thirdParty, '{{record:record-1.number}}', '第三方主体').verified, true);
  assert.throws(() => recordFactSource(record(), '{{record:record-1.number}}', '其他主体'), /声明的第三方/);
  assert.equal(recordFactSource(record({ validity: 'unknown', subject: 'unknown' }), '{{record:record-1.number}}').verified, false);
});
