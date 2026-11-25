import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewHint } from '../src/core/bid/human-review.js';
import { currentHints } from '../src/core/bid/dismissals.js';
import type { BidLedger } from '../src/core/bid/project.js';
import type { HostPort } from '../src/core/host.js';
import { checkDraft } from '../src/core/bid/check.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { sha256Hex, writeZip } from '../src/core/docx/zip.js';

test('failed human authorization does not create a dismissal', async () => {
  const xml = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>（报价金额）</w:t></w:r></w:p></w:body></w:document>';
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
  const hint = currentHints(xml, 'draft')[0];
  assert.ok(hint);
  await assert.rejects(reviewHint(ledger, 'draft', hint.id, xml, { root: 'project', vaultId: null, deadline: '2028-02-29' }, new Uint8Array(1)), /密钥长度不足/);
  assert.deepEqual(ledger.dismissals, []);
});

test('human acknowledgement applies only while the dismissed block is unchanged', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const xml = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>备注：（报价金额）</w:t></w:r></w:p></w:body></w:document>';
  const base = await writeZip(new Map([['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', encode(xml)]]));
  const hint = currentHints(xml, 'draft')[0], context = { root: '/project', vaultId: null, deadline: '2028-02-29' }, secret = new Uint8Array(32).fill(3);
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [{ draft: 'draft', address: hint.address, blockFingerprint: hint.blockFingerprint, hintText: hint.hintText, hintIndex: hint.hintIndex, reason: '不适用', actor: 'agent' }], acceptedChanges: [], requirements: [], drafts: { draft: sha256Hex(base) }, bases: { draft: sha256Hex(base) } };
  const project = { format: 'seal-project-1' as const, name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['draft'], createdAt: '2028-01-01' };
  const check = (draft: Uint8Array) => checkDraft({} as HostPort, { name: 'draft', root: context.root, base, draft, ledger, project, secret }) as Promise<{ results: Record<string, unknown[]> }>;
  await sealLedger(ledger, context.root, secret);
  assert.equal((await check(base)).results.C03.length, 1);
  await reviewHint(ledger, 'draft', hint.id, xml, context, secret);
  await sealLedger(ledger, context.root, secret);
  assert.equal((await check(base)).results.C03.length, 0);
  const changed = await editTextDocument(base, [{ op: 'replace', at: 'p:0', find: '备注', value: '说明' }]);
  ledger.drafts.draft = sha256Hex(changed);
  await sealLedger(ledger, context.root, secret);
  const report = await check(changed);
  assert.equal(report.results.C02.length, 1);
  assert.equal(report.results.C03.length, 0);
});
