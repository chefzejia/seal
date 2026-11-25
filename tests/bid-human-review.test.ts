import { test } from 'node:test';

import assert from 'node:assert/strict';

import type { HostPort } from '../src/core/host.js';

import { checkDraft } from '../src/core/bid/check.js';

import { editBidDraft } from '../src/core/bid/edit.js';

import { sealLedger } from '../src/core/bid/ledger-integrity.js';

import { acceptChange, markCoverage } from '../src/core/bid/human-review.js';

import type { BidLedger, ProjectMetadata } from '../src/core/bid/project.js';

import { compareDocuments } from '../src/core/docx/package-compare.js';

import { resolveAddress } from '../src/core/docx/addresses.js';

import { sealRanges } from '../src/core/docx/seal-ranges.js';

import { readZip, sha256Hex, writeZip } from '../src/core/docx/zip.js';

const secret = new Uint8Array(32).fill(13);

const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };

const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };

async function document(second: string, extra = ''): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  return writeZip(new Map([
    ['[Content_Types].xml', encoder.encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encoder.encode(`<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>姓名：____</w:t></w:r></w:p><w:p><w:r><w:t>${second}</w:t></w:r>${extra}</w:p><w:sectPr/></w:body></w:document>`)],
  ]));
}

test('edit results report post-batch addresses and views after paragraph insertion', async () => {
  const base = await document('尾部____');
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const result = await editBidDraft({ name: 'bid', old: base, base, ledger, images: new Map(), markdownImages: new Map(), operations: [
    { op: 'insert', at: 'p:0', position: 'after', markdown: '新增段落' },
    { op: 'replace', at: 'p:1', find: '____', value: '填写' },
  ] });
  assert.deepEqual(result.results[0].views.map(view => [view.address, view.text]), [['p:1', '新增段落']]);
  assert.deepEqual(result.results[1].views.map(view => [view.address, view.text]), [['p:2', '尾部填写']]);
});

test('edit results distinguish inserted and original identical paragraphs', async () => {
  const base = await document('重复');
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const result = await editBidDraft({ name: 'bid', old: base, base, ledger, images: new Map(), markdownImages: new Map(), operations: [
    { op: 'insert', at: 'p:0', position: 'after', markdown: '重复' },
    { op: 'mark_pending', at: 'p:1', find: '重复', pending: { category: '其他', note: '核对' } },
  ] });
  assert.equal(result.results[0].views[0].address, 'p:1');
  assert.equal(result.results[1].views[0].address, 'p:2');
  const xml = new TextDecoder().decode((await readZip(result.output)).get('word/document.xml'));
  assert.equal(sealRanges(resolveAddress(xml, 'p:1').xml).length, 0);
  assert.equal(sealRanges(resolveAddress(xml, 'p:2').xml)[0].name, `_Seal_P_${result.pending[0].id}`);
});

test('nested paragraph insert results retain their cell-relative addresses', async () => {
  const encoder = new TextEncoder();
  const base = await writeZip(new Map([
    ['[Content_Types].xml', encoder.encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encoder.encode('<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>锚点</w:t></w:r></w:p><w:p><w:r><w:t>尾文</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>')],
  ]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const result = await editBidDraft({ name: 'bid', old: base, base, ledger, images: new Map(), markdownImages: new Map(), operations: [
    { op: 'insert', at: 't:0/r:0/c:0/p:0', position: 'after', markdown: '新增' },
    { op: 'replace', at: 't:0/r:0/c:0/p:1', find: '尾文', value: '填写' },
  ] });
  assert.deepEqual(result.results[0].views.map(view => [view.address, view.text]), [['t:0/r:0/c:0/p:1', '新增']]);
  assert.deepEqual(result.results[1].views.map(view => [view.address, view.text]), [['t:0/r:0/c:0/p:2', '填写']]);
});

test('one sensitive insert can add a paragraph and nested table with trackable pending items', async () => {
  const encoder = new TextEncoder();
  const base = await writeZip(new Map([
    ['[Content_Types].xml', encoder.encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encoder.encode('<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>报价说明</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>')],
  ]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const result = await editBidDraft({ name: 'bid', old: base, base, ledger, images: new Map(), markdownImages: new Map(), operations: [
    { op: 'insert', at: 't:0/r:0/c:0/p:0', position: 'after', markdown: '报价内容\n\n| 项目 | 金额 |\n| --- | --- |\n| 测试 | 100 |', pending: { category: '报价', note: '报价清单待确认' } },
  ] });
  const xml = new TextDecoder().decode((await readZip(result.output)).get('word/document.xml'));
  assert.equal(sealRanges(resolveAddress(xml, 't:0/r:0/c:0/p:1').xml)[0].text, '报价内容');
  assert.equal(sealRanges(resolveAddress(xml, 't:0/r:0/c:0/t:0/r:1/c:1/p:0').xml)[0].text, '100');
  await sealLedger(ledger, context.root, secret);
  const report = await checkDraft({} as HostPort, { name: 'bid', root: context.root, draft: result.output, base, ledger, project, secret }) as any;
  assert.deepEqual(report.results.C10, []);
});

test('content loss can be accepted only with a current human signature', async () => {
  const base = await document('固定文字', '<w:bookmarkStart w:id="1" w:name="mark"/><w:bookmarkEnd w:id="1"/>');
  const draft = await document('固定文字');
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(draft) }, bases: { bid: sha256Hex(base) } };
  const check = async () => await checkDraft({} as HostPort, { name: 'bid', root: context.root, draft, base, ledger, project, secret }) as any;
  const difference = (await compareDocuments(base, draft)).find(item => item.kind === 'objectLost');
  assert.ok(difference);
  await sealLedger(ledger, context.root, secret);
  assert.ok((await check()).results.C07.some((item: { id: string }) => item.id === difference.id));
  await acceptChange(ledger, 'bid', difference, context, secret);
  await sealLedger(ledger, context.root, secret);
  assert.ok(!(await check()).results.C07.some((item: { id: string }) => item.id === difference.id));
  (ledger.acceptedChanges[0] as { authorization: { signature: string } }).authorization.signature = '0'.repeat(64);
  await sealLedger(ledger, context.root, secret);
  const forged = await check();
  assert.ok(forged.results.C07.some((item: { id: string }) => item.id === difference.id));
  assert.equal(forged.results.C15.length, 1);
});

test('coverage marks are signed against their requirement and current response', async () => {
  const base = await document('响应内容');
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const check = async () => await checkDraft({} as HostPort, { name: 'bid', root: context.root, draft: base, base, ledger, project, secret }) as any;
  await markCoverage(ledger, { id: 'requirement', draft: 'bid', address: 'p:1', requirement: '响应招标要求', response: '响应内容' }, context, secret);
  await sealLedger(ledger, context.root, secret);
  assert.deepEqual((await check()).results.C15, []);
  (ledger.requirements[0] as { requirement: string }).requirement = '伪造要求';
  assert.equal((await check()).results.C15.length, 1);
});
