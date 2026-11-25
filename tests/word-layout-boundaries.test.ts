import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { layoutBox, auditImageLayout } from '../src/core/docx/layout.js';
import { packageDocument, paragraph } from './fixtures/layout-matrix.js';
import { readZip, writeZip, sha256Hex } from '../src/core/docx/zip.js';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { finalizeDocument } from '../src/core/docx/finalize-document.js';
import { finalizeDraftMarkers } from '../src/core/bid/finalize.js';
import { checkDraft } from '../src/core/bid/check.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import type { BidLedger, ProjectMetadata } from '../src/core/bid/project.js';
import type { HostPort } from '../src/core/host.js';

const enc = (s: string) => new TextEncoder().encode(s);
const decode = (parts: Map<string, Uint8Array>) => new TextDecoder().decode(parts.get('word/document.xml'));
const edge = (name: string, width: number) => `<w:${name} w:w="${width}" w:type="dxa"/>`;
const style = (id: string, margins: string, extra = '') => `<w:style w:type="table" w:styleId="${id}" ${extra}><w:tblPr><w:tblCellMar>${margins}</w:tblCellMar></w:tblPr></w:style>`;

test('per-edge cell margins override table, basedOn style and document default style', async () => {
  const styles = `<w:styles xmlns:w="word">${style('default', edge('left', 500) + edge('right', 600), 'w:default="1"')}${style('base', edge('left', 300))}<w:style w:type="table" w:styleId="specific"><w:basedOn w:val="base"/><w:tblPr><w:tblCellMar>${edge('right', 400)}</w:tblCellMar></w:tblPr></w:style></w:styles>`;
  for (const [name, tableMargins, cellMargins, expected] of [
    ['style', '', '', 2300], ['table-left', edge('left', 200), '', 2400],
    ['cell-right', edge('left', 200), edge('right', 50), 2750], ['cell-zero', '', '<w:left w:type="nil"/><w:right w:w="0" w:type="dxa"/>', 3000],
    ['default-style', '', '', 1900],
  ] as const) {
    const tblStyle = name === 'default-style' ? '' : '<w:tblStyle w:val="specific"/>';
    const document = await packageDocument(`<w:tbl><w:tblPr>${tblStyle}<w:tblCellMar>${tableMargins}</w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcMar>${cellMargins}</w:tcMar></w:tcPr>${paragraph('定位')}</w:tc></w:tr></w:tbl>`, '', styles);
    const xml = decode(await readZip(document));
    assert.equal(layoutBox(xml, xml.indexOf('定位'), { stylesXml: styles }).width, expected * 635, name);
    const output = await editTextDocument(document, [{ op: 'insert', at: 't:0/r:0/c:0/p:0', position: 'after', markdown: '| A | B |\n| --- | --- |\n| C | D |' }]);
    assert.match(decode(await readZip(output)), new RegExp(`<w:tblW w:w="${expected}" w:type="dxa"`), name);
  }
});

test('section boundaries are exact and unequal columns use a safe lower bound despite explicit breaks', async () => {
  const body = `<w:p><w:pPr><w:sectPr><w:pgSz w:w="16000" w:h="12000"/><w:pgMar w:left="1000" w:right="1000" w:top="1000" w:bottom="1000"/></w:sectPr></w:pPr><w:r><w:t>横向</w:t></w:r></w:p>${paragraph('栏一')}<w:p><w:r><w:br w:type="column"/></w:r></w:p>${paragraph('栏二')}`;
  const xml = decode(await readZip(await packageDocument(body, '<w:cols w:num="2" w:equalWidth="0"><w:col w:w="3000" w:space="600"/><w:col w:w="5760"/></w:cols>')));
  assert.equal(layoutBox(xml, xml.indexOf('横向')).width, 14000 * 635);
  assert.equal(layoutBox(xml, xml.indexOf('栏一')).width, 3000 * 635);
  assert.equal(layoutBox(xml, xml.indexOf('栏二')).width, 3000 * 635);
});

test('zero-width grids split the row including spans and gridBefore; tcW only narrows', async () => {
  const body = `<w:tbl><w:tblGrid><w:gridCol w:w="0"/><w:gridCol/></w:tblGrid><w:tr><w:trPr><w:gridBefore w:val="1"/><w:gridAfter w:val="1"/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:tcW w:w="9000" w:type="dxa"/></w:tcPr>${paragraph('定位')}</w:tc><w:tc>${paragraph('邻格')}</w:tc></w:tr></w:tbl>`;
  const xml = decode(await readZip(await packageDocument(body)));
  assert.equal(layoutBox(xml, xml.indexOf('定位')).width, (3744 - 240) * 635);
  assert.equal(layoutBox(xml.replace('w:w="9000"', 'w:w="1000"'), xml.indexOf('定位')).width, 760 * 635);
});

test('C16 sees a one-EMU overflow, ignores original pictures and blocks both final gates', async () => {
  const base = await packageDocument(paragraph('定位'));
  const draft = await editTextDocument(base, [{ op: 'insert_image', at: 'p:0', image: await readFile('tests/fixtures/evidence-1600x1200.png') }]);
  const parts = await readZip(draft), xml = decode(parts);
  assert.deepEqual(auditImageLayout(xml), []);
  const box = layoutBox(xml, xml.indexOf('<w:drawing'));
  const broken = xml.replace(/(<wp:extent cx=")\d+/, `$1${box.width + 1}`);
  assert.equal(auditImageLayout(broken).length, 1);
  assert.equal(auditImageLayout(xml.replace(/(<wp:extent cx="\d+" cy=")\d+/, `$1${box.height + 1}`)).length, 1);
  assert.equal(auditImageLayout(xml.replace(/(<wp:extent cx=")\d+/, '$10')).length, 1);
  const exact = xml.replace(/<wp:extent cx="\d+" cy="\d+"/, `<wp:extent cx="${box.width}" cy="${box.height}"`);
  assert.deepEqual(auditImageLayout(exact), []);
  assert.deepEqual(auditImageLayout(broken.replace(/name="Seal image \d+"/, 'name="Original image"')), []);
  parts.set('word/document.xml', enc(broken));
  const overflow = await writeZip(parts), root = '/layout', secret = new Uint8Array(32).fill(29), host = {} as HostPort;
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'layout', vaultId: null, deadline: '2028-12-31', tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const input = async (bytes: Uint8Array) => {
    const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(bytes) }, bases: { bid: sha256Hex(base) } };
    await sealLedger(ledger, root, secret);
    return { name: 'bid', root, draft: bytes, base, ledger, anchor: ledger.integrity, project, secret };
  };
  const good = await input(draft), bad = await input(overflow);
  assert.deepEqual((await checkDraft(host, good) as { results: { C16: unknown[] } }).results.C16, []);
  const report = await checkDraft(host, bad) as { results: { C16: Array<{ address: string }>; C15: unknown[] } };
  assert.equal(report.results.C16.length, 1);
  assert.equal(report.results.C16[0].address, 'p:1');
  assert.deepEqual(report.results.C15, [], 'only geometry is broken; ledger prerequisites remain valid');
  await finalizeDraftMarkers(host, good);
  await assert.rejects(finalizeDraftMarkers(host, bad), /C16/);
  await assert.rejects(finalizeDocument(overflow, base, { draftSha256: sha256Hex(overflow), baseSha256: sha256Hex(base), marks: [] }, host), /C16/);
});
