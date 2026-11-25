import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editBidDraft } from '../src/core/bid/edit.js';
import type { BidLedger } from '../src/core/bid/project.js';
import { finalizeDocument } from '../src/core/docx/finalize-document.js';
import { readZip, sha256Hex, writeZip } from '../src/core/docx/zip.js';
import type { HostPort } from '../src/core/host.js';
import { visibleRunProperties } from '../src/core/docx/visible-surgery.js';
import { confirmPending } from '../src/core/bid/human-review.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import { finalizeDraftMarkers } from '../src/core/bid/finalize.js';
import { checkDraft } from '../src/core/bid/check.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';

test('finalizing restores original highlighting and preserves ordinary bookmarks', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const xml = '<w:document xmlns:w="word"><w:body><w:p><w:bookmarkStart w:id="7" w:name="original"/><w:r><w:rPr><w:highlight w:val="green"></w:highlight></w:rPr><w:t>原文</w:t></w:r><w:bookmarkEnd w:id="7"/></w:p></w:body></w:document>';
  const base = await writeZip(new Map([['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', encode(xml)]]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
  const result = await editBidDraft({ name: 'bid', old: base, ledger, operations: [{ op: 'mark_pending', at: 'p:0', find: '原文', pending: { category: '其他', note: '核对' } }], images: new Map(), markdownImages: new Map() });
  const item = ledger.pending[0];
  const final = await finalizeDocument(result.output, base, { draftSha256: sha256Hex(result.output), baseSha256: sha256Hex(base), marks: [{ id: item.id, state: 'confirmed', originalHighlights: item.originalHighlights }] }, {} as HostPort);
  const actual = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.match(actual, /w:name="original"/);
  assert.match(actual, /w:highlight w:val="green"/);
  assert.doesNotMatch(actual, /_Seal_/);
  assert.ok(visibleRunProperties(actual).every(properties => properties.includes('w:val="green"')));
});

test('finalization requires current signed confirmation and invalidates it after editing', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const xml = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>报价：____</w:t></w:r></w:p></w:body></w:document>';
  const base = await writeZip(new Map([['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', encode(xml)]]));
  const root = '/project', secret = new Uint8Array(32).fill(1), context = { root, vaultId: null, deadline: '2028-02-29' };
  const project = { format: 'seal-project-1' as const, name: 'bid', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {}, bases: { bid: sha256Hex(base) } };
  const edit = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, ledger, operations, images: new Map(), markdownImages: new Map() });
  const draft = (await edit(base, [{ op: 'replace', at: 'p:0', find: '____', value: '100' }])).output;
  await sealLedger(ledger, root, secret);
  const input = { name: 'bid', root, draft, base, ledger, anchor: ledger.integrity, project, secret };
  await assert.rejects(finalizeDraftMarkers({} as HostPort, input), /C04/);
  const draftXml = new TextDecoder().decode((await readZip(draft)).get('word/document.xml'));
  for (const broken of [draftXml.replace(/<w:bookmarkStart\b[^>]*\/>/g, '').replace(/<w:bookmarkEnd\b[^>]*\/>/g, ''), draftXml.replaceAll('w:val="yellow"', 'w:val="green"')]) {
    const parts = await readZip(draft);
    parts.set('word/document.xml', encode(broken));
    const report = await checkDraft({} as HostPort, { ...input, draft: await writeZip(parts) }) as { results: Record<string, unknown[]> };
    assert.equal(report.results.C10.length, 1);
    assert.ok(report.results.C15.length > 0);
  }
  await confirmPending(ledger, 'bid', ledger.pending[0].id, draftXml, context, secret);
  await sealLedger(ledger, root, secret);
  const finalized = await finalizeDraftMarkers({} as HostPort, { ...input, anchor: ledger.integrity });
  const finalXml = new TextDecoder().decode((await readZip(finalized)).get('word/document.xml'));
  assert.doesNotMatch(finalXml, /_Seal_/);
  assert.ok(visibleRunProperties(finalXml).every(properties => !properties.includes('yellow')));
  const changed = (await edit(draft, [{ op: 'replace', at: 'p:0', find: '100', value: '101' }])).output;
  await sealLedger(ledger, root, secret);
  const report = await checkDraft({} as HostPort, { ...input, draft: changed, anchor: ledger.integrity }) as { results: Record<string, unknown[]> };
  assert.equal(report.results.C04.length, 1);
  await assert.rejects(finalizeDraftMarkers({} as HostPort, { ...input, draft: changed, anchor: ledger.integrity }), /C04/);
});

test('editing a marked mixed-color range restores each inherited color', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const xml = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:t>A</w:t></w:r><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>B</w:t></w:r></w:p></w:body></w:document>';
  const base = await writeZip(new Map([['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', encode(xml)]]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
  const edit = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, ledger, operations, images: new Map(), markdownImages: new Map() });
  const first = await edit(base, [{ op: 'mark_pending', at: 'p:0', find: 'AB', pending: { category: '其他', note: '核对' } }]);
  const second = await edit(first.output, [{ op: 'replace', at: 'p:0', find: 'B', value: 'CD' }]);
  const item = ledger.pending[0], marks = [{ id: item.id, state: 'confirmed' as const, originalHighlights: item.originalHighlights }];
  const output = await finalizeDocument(second.output, base, { draftSha256: sha256Hex(second.output), baseSha256: sha256Hex(base), marks }, {} as HostPort);
  const result = new TextDecoder().decode((await readZip(output)).get('word/document.xml'));
  const properties = visibleRunProperties(result);
  assert.match(properties[0], /w:val="red"/);
  assert.ok(properties.slice(1).every(value => /w:val="green"/.test(value)));
  await assert.rejects(finalizeDocument(second.output, base, { draftSha256: sha256Hex(second.output), baseSha256: sha256Hex(base), marks: [{ ...marks[0], originalHighlights: [] }] }, {} as HostPort), /原始高亮/);
});

test('finalization fails closed for missing markers, unsigned marks and stale bytes', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const xml = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>原黄</w:t></w:r></w:p></w:body></w:document>';
  const base = await writeZip(new Map([['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', encode(xml)]]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
  const edited = await editBidDraft({ name: 'bid', old: base, ledger, operations: [{ op: 'mark_pending', at: 'p:0', find: '原黄', pending: { category: '其他', note: '核对' } }], images: new Map(), markdownImages: new Map() });
  const item = ledger.pending[0], mark = { id: item.id, state: 'confirmed' as const, originalHighlights: item.originalHighlights };
  const context = { draftSha256: sha256Hex(edited.output), baseSha256: sha256Hex(base), marks: [mark] };
  await assert.rejects(finalizeDocument(edited.output, base, { ...context, draftSha256: 'stale' }, {} as HostPort), /摘要/);
  await assert.rejects(finalizeDocument(edited.output, base, { ...context, marks: [] }, {} as HostPort), /无台账/);
  await assert.rejects(finalizeDocument(edited.output, base, { ...context, marks: [{ ...mark, state: 'unconfirmed' }] }, {} as HostPort), /尚未/);
  const output = await finalizeDocument(edited.output, base, context, {} as HostPort);
  const outputXml = new TextDecoder().decode((await readZip(output)).get('word/document.xml'));
  assert.ok(visibleRunProperties(outputXml).every(properties => properties.includes('w:val="yellow"')));
});

test('cross-paragraph pending ranges can be confirmed and finalized', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')],
  ]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const edited = await editBidDraft({ name: 'bid', old: base, base, ledger, operations: [{ op: 'mark_pending', at: 't:0/r:0/c:0', find: '甲乙', pending: { category: '其他', note: '跨段核对' } }], images: new Map(), markdownImages: new Map() });
  const item = ledger.pending[0], draftXml = new TextDecoder().decode((await readZip(edited.output)).get('word/document.xml'));
  assert.deepEqual(sealRanges(draftXml).map(range => [range.start, range.end, range.text]), [[0, 2, '甲乙']]);
  const finalized = await finalizeDocument(edited.output, base, { draftSha256: sha256Hex(edited.output), baseSha256: sha256Hex(base), marks: [{ id: item.id, state: 'confirmed', originalHighlights: item.originalHighlights }] }, {} as HostPort);
  const finalXml = new TextDecoder().decode((await readZip(finalized)).get('word/document.xml'));
  assert.doesNotMatch(finalXml, /_Seal_/);
  assert.equal(visibleRunProperties(finalXml).filter(properties => /w:highlight w:val="yellow"/.test(properties)).length, 0);
});
