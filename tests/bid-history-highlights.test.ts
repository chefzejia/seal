import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editBidDraft, type AgentEdit } from '../src/core/bid/edit.js';
import { checkDraft } from '../src/core/bid/check.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import type { BidLedger, ProjectMetadata } from '../src/core/bid/project.js';
import { finalizeDocument } from '../src/core/docx/finalize-document.js';
import { readZip, sha256Hex, writeZip } from '../src/core/docx/zip.js';
import { editableText, visibleRunProperties } from '../src/core/docx/visible-surgery.js';
import { xmlElements } from '../src/core/docx/xml.js';
import type { HostPort } from '../src/core/host.js';

const enc = (value: string) => new TextEncoder().encode(value);
const dec = new TextDecoder();
const docXml = async (bytes: Uint8Array) => dec.decode((await readZip(bytes)).get('word/document.xml'));
const historyElements = (xml: string) => xmlElements(xml).filter(element => element.name === 'w:rPrChange').map(element => xml.slice(element.start, element.end));
const directHighlight = (properties: string) => {
  const elements = xmlElements(properties), root = elements.findIndex(element => element.name === 'w:rPr' && element.parent === null);
  const item = elements.find(element => element.parent === root && element.name === 'w:highlight');
  return item ? properties.slice(item.start, item.end) : null;
};

for (const historical of ['green', 'yellow'] as const) for (const direct of [null, 'green', 'yellow'] as const) test(`history survives mark and finalize historical=${historical} direct=${direct}`, async () => {
  const history = `<w:rPrChange w:id="1" w:author="Reviewer" w:date="2025-01-01T00:00:00Z"><w:rPr><w:highlight w:val="${historical}"/></w:rPr></w:rPrChange>`;
  const property = `<w:rPr><w:b/>${direct ? `<w:highlight w:val="${direct}"/>` : ''}${history}</w:rPr>`;
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc(`<w:document xmlns:w="word"><w:body><w:p><w:r>${property}<w:t>待审核文字</w:t></w:r></w:p></w:body></w:document>`) ],
  ]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const edited = await editBidDraft({ name: 'bid', old: base, base, ledger, operations: [{ op: 'mark_pending', at: 'p:0', find: '待审核文字', pending: { category: '其他', note: '复核' } }], images: new Map(), markdownImages: new Map() });
  const xml = await docXml(edited.output), highlights = visibleRunProperties(xml).map(directHighlight);
  assert.ok(highlights.every(value => value?.includes('w:val="yellow"')));
  assert.ok(visibleRunProperties(xml).every(value => value.indexOf('<w:highlight') < value.indexOf('<w:rPrChange')));
  assert.ok(historyElements(xml).length > 0 && historyElements(xml).every(value => value === history));
  const root = '/project', secret = new Uint8Array(32).fill(29);
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: '2028-12-31', vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  await sealLedger(ledger, root, secret);
  const report = await checkDraft({} as HostPort, { name: 'bid', root, draft: edited.output, base, ledger, project, secret, anchor: ledger.integrity }) as { results: Record<string, unknown[]> };
  assert.deepEqual(report.results.C10, []);
  const mark = ledger.pending[0];
  const final = await finalizeDocument(edited.output, base, { draftSha256: sha256Hex(edited.output), baseSha256: sha256Hex(base), marks: [{ id: mark.id, state: 'confirmed', originalHighlights: mark.originalHighlights }] }, {} as HostPort);
  const finalXml = await docXml(final), finalProperties = visibleRunProperties(finalXml).map(directHighlight);
  assert.ok(finalProperties.every(value => direct ? value?.includes(`w:val="${direct}"`) : value === null));
  assert.ok(historyElements(finalXml).length > 0 && historyElements(finalXml).every(value => value === history));
});

for (const operation of ['replace', 'set_cell', 'blank', 'insert_rows', 'insert'] as const) test(`history survives ${operation} editing and finalization`, async () => {
  const history = '<w:rPrChange w:id="1" w:author="Reviewer" w:date="2025-01-01T00:00:00Z"><w:rPr><w:highlight w:val="green"/></w:rPr></w:rPrChange>';
  const paragraph = `<w:p><w:r><w:rPr><w:b/>${history}</w:rPr><w:t>原文</w:t></w:r></w:p>`;
  const table = `<w:tbl><w:tr><w:tc>${paragraph}</w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>`;
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc(`<w:document xmlns:w="word"><w:body>${table}</w:body></w:document>`) ],
  ]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const pending = { category: '其他' as const, note: '复核' };
  const operations: Record<typeof operation, AgentEdit> = {
    replace: { op: 'replace', at: 't:0/r:0/c:0/p:0', find: '原文', value: '填写', pending },
    set_cell: { op: 'set_cell', at: 't:0/r:0/c:1', value: '填写', pending },
    blank: { op: 'replace', at: 't:0/r:0/c:1', blank: 0, value: '填写', pending },
    insert_rows: { op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['填写', '']], pending },
    insert: { op: 'insert', at: 't:0', position: 'after', markdown: '填写', pending },
  };
  const edited = await editBidDraft({ name: 'bid', old: base, base, ledger, operations: [operations[operation]], images: new Map(), markdownImages: new Map() });
  const xml = await docXml(edited.output);
  assert.ok(historyElements(xml).length > 0 && historyElements(xml).every(value => value === history), operation);
  const root = '/project', secret = new Uint8Array(32).fill(30);
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: '2028-12-31', vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  await sealLedger(ledger, root, secret);
  const report = await checkDraft({} as HostPort, { name: 'bid', root, draft: edited.output, base, ledger, project, secret, anchor: ledger.integrity }) as { results: Record<string, unknown[]> };
  assert.deepEqual(report.results.C10, [], operation);
  const marks = ledger.pending.filter(item => item.status !== 'removed').map(item => ({ id: item.id, state: 'confirmed' as const, originalHighlights: item.originalHighlights }));
  assert.ok(marks.length > 0, operation);
  const final = await finalizeDocument(edited.output, base, { draftSha256: sha256Hex(edited.output), baseSha256: sha256Hex(base), marks }, {} as HostPort);
  const finalXml = await docXml(final);
  assert.ok(editableText(finalXml).includes('填写'));
  assert.ok(historyElements(finalXml).length > 0 && historyElements(finalXml).every(value => value === history), operation);
  assert.equal(visibleRunProperties(finalXml).some(value => directHighlight(value)?.includes('yellow')), false, operation);
});
