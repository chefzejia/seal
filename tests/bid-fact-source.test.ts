import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPort } from '../src/core/host.js';
import type { BidLedger } from '../src/core/bid/project.js';
import { checkDraft } from '../src/core/bid/check.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import { wrapVisibleRange } from '../src/core/docx/visible-surgery.js';
import { sha256Hex, writeZip } from '../src/core/docx/zip.js';

test('verified fact ranges report changed, missing or unregistered content as C05', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const make = (xml: string) => writeZip(new Map([['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', encode(xml)]]));
  const body = (text: string) => `<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  const root = '/project', secret = new Uint8Array(32).fill(4);
  const project = { format: 'seal-project-1' as const, name: 'test', deadline: '2028-02-29', vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const xml = wrapVisibleRange(body('名称：甲公司'), 3, 6, '_Seal_F_a', 9), base = await make(xml);
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [{ id: 'a', draft: 'bid', operation: 'replace', reference: 'subject.name', resolvedValue: '甲公司', verified: true }], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const check = async (draft: Uint8Array) => {
    ledger.drafts.bid = sha256Hex(draft);
    await sealLedger(ledger, root, secret);
    return await checkDraft({} as HostPort, { name: 'bid', root, draft, base, ledger, project, secret }) as { results: Record<string, unknown[]> };
  };
  assert.equal((await check(base)).results.C05.length, 0);
  assert.equal((await check(await make(xml.replace('甲公司', '乙公司')))).results.C05.length, 1);
  assert.equal((await check(await make(body('名称：甲公司')))).results.C05.length, 1);
  ledger.fills = [];
  assert.equal((await check(base)).results.C05.length, 1);
});

test('C05 and C08 recheck live fact state and C09 scans forbidden names and credit-code-shaped values', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const make = (xml: string) => writeZip(new Map([['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', encode(xml)]]));
  const code = (digit: string) => digit.repeat(18);
  const xml = wrapVisibleRange(`<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>${code('1')} 禁用关联主体 已过期证据</w:t></w:r></w:p></w:body></w:document>`, 0, code('1').length, '_Seal_F_fact', 4);
  const draft = await make(xml), root = '/project', secret = new Uint8Array(32).fill(8);
  const project = { format: 'seal-project-1' as const, name: 'test', deadline: '2028-02-29', vaultId: 'test-vault', tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [{ id: 'fact', draft: 'bid', operation: 'replace', reference: '{{record:record-1.number}}', sources: [{ reference: '{{record:record-1.number}}', resolvedValue: code('1'), verified: true, recordId: 'record-1', validity: 'valid', subject: 'self' }], resolvedValue: code('1'), verified: true }], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(draft) }, bases: { bid: sha256Hex(draft) } };
  await sealLedger(ledger, root, secret);
  const report = await checkDraft({} as HostPort, {
    name: 'bid', root, draft, base: draft, ledger, project, secret,
    factStates: [{ id: 'fact', verified: false, issues: ['引用资料已过期', '持证主体已禁用'], evidenceDates: [{ recordId: 'record', validity: 'expired' }] }],
    identity: { creditCode: code('9'), forbiddenAffiliates: ['禁用关联主体'], thirdPartyCreditCodes: [] },
  }) as { results: Record<string, Array<{ reason?: string; value?: string }>> };
  assert.ok(report.results.C05.some(item => /过期/.test(item.reason ?? '')));
  assert.ok(report.results.C08.some(item => /过期/.test(item.reason ?? '')));
  assert.ok(report.results.C09.some(item => item.value === '禁用关联主体'));
  assert.ok(report.results.C09.some(item => item.value === code('1')));

  const allowed = await checkDraft({} as HostPort, {
    name: 'bid', root, draft, base: draft, ledger, project, secret,
    factStates: [{ id: 'fact', verified: true, issues: [], evidenceDates: [] }],
    identity: { creditCode: code('9'), forbiddenAffiliates: [], thirdPartyCreditCodes: [code('1')] },
  }) as { results: Record<string, unknown[]> };
  assert.equal(allowed.results.C09.length, 0);
});
