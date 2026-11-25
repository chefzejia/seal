import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editBidDraft, type AgentEdit } from '../src/core/bid/edit.js';
import { checkDraft } from '../src/core/bid/check.js';
import { confirmPending } from '../src/core/bid/human-review.js';
import { finalizeDraftMarkers } from '../src/core/bid/finalize.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import type { BidLedger, ProjectMetadata } from '../src/core/bid/project.js';
import type { HostPort } from '../src/core/host.js';
import { compareDocuments } from '../src/core/docx/package-compare.js';
import { validatePackageStructure } from '../src/core/docx/package-structure.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';
import { readZip, sha256Hex, writeZip } from '../src/core/docx/zip.js';
import { visibleRunProperties } from '../src/core/docx/visible-surgery.js';

const root = '/synthetic-project', name = 'bid', deadline = '2028-12-31', vaultId = null;
const context = { root, deadline, vaultId };
const project: ProjectMetadata = { format: 'seal-project-1', name, deadline, vaultId, tenders: [], drafts: [name], createdAt: '2028-01-01' };
const secret = new Uint8Array(32).fill(96), host = {} as HostPort;
const enc = (s: string) => new TextEncoder().encode(s);
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const make = (body: string, extras: Array<[string,string]> = []) => writeZip(new Map([
  ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
  ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
  ['word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr/></w:body></w:document>`],
  ...extras,
].map(([k,v]) => [k, enc(v)])));
const xml = async (bytes: Uint8Array) => new TextDecoder().decode((await readZip(bytes)).get('word/document.xml'));
const ledgerFor = (base: Uint8Array): BidLedger => ({ format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { [name]: sha256Hex(base) }, bases: { [name]: sha256Hex(base) } });
const edit = (old: Uint8Array, ledger: BidLedger, operations: AgentEdit[]) => editBidDraft({ name, old, ledger, operations, images: new Map(), markdownImages: new Map() });
const check = async (base: Uint8Array, draft: Uint8Array, ledger: BidLedger) => {
  await sealLedger(ledger, root, secret);
  return (await checkDraft(host, { name, root, base, draft, ledger, project, secret, anchor: ledger.integrity })) as { results: Record<string, unknown[]> };
};
const tbl = (...cells: string[]) => `<w:tbl><w:tblPr/><w:tblGrid>${cells.map(() => '<w:gridCol w:w="2000"/>').join('')}</w:tblGrid><w:tr>${cells.map(cell => `<w:tc>${cell}</w:tc>`).join('')}</w:tr></w:tbl>`;
const c = 't:0/r:0/c:0';
const pending = { category: '\u5176\u4ed6', note: 'synthetic open range' } as const;



test('customXml body and nested content controls are compared and reported as C06', async () => {
  for (const inner of [(s: string) => p(s), (s: string) => `<w:sdt><w:sdtContent>${p(s)}</w:sdtContent></w:sdt>`]) {
    const wrap = (s: string) => `<w:customXml w:uri="urn:test" w:element="Section">${inner(s)}</w:customXml>`;
    const base = await make(wrap('ORIGINAL')), changed = await make(wrap('CHANGED'));
    assert.deepEqual(await compareDocuments(base, base), []);
    assert.equal((await compareDocuments(base, changed))[0]?.kind, 'modified');
    const report = await check(base, changed, ledgerFor(base));
    assert.equal(report.results.C06.length, 1);
  }
});

test('insert inside existing cross paragraph pending reopens and restores styles; outside preserves confirmation', async () => {
  const base = await make(tbl(p('FIRST') + p('SECOND'))), ledger = ledgerFor(base);
  const marked = await edit(base, ledger, [{ op: 'mark_pending', at: c, find: 'FIRSTSECOND', pending }]);
  const before = await xml(marked.output), id = ledger.pending[0].id;
  await confirmPending(ledger, name, id, before, context, secret);
  for (const [at, position, inside] of [[`${c}/p:0`, 'before', false], [`${c}/p:0`, 'after', true], [`${c}/p:1`, 'before', true], [`${c}/p:1`, 'after', false]] as const) {
    const result = await edit(marked.output, structuredClone(ledger), [{ op: 'insert', at, position, markdown: 'INSERTED' }]);
    const document = await xml(result.output), range = sealRanges(document)[0], item = result.ledger.pending[0];
    assert.equal(item.id, id);
    assert.equal(range.text.includes('INSERTED'), inside);
    assert.equal(item.status, inside ? 'open' : 'confirmed');
    assert.equal(!!item.confirmation, !inside);
    const report = (await check(base, result.output, result.ledger)).results;
    assert.equal(report.C10.length, 0);
    assert.equal(report.C04.length, inside ? 1 : 0);
    if (inside) {
      await confirmPending(result.ledger, name, id, document, context, secret);
      await sealLedger(result.ledger, root, secret);
      const final = await finalizeDraftMarkers(host, { name, root, draft: result.output, base, ledger: result.ledger, anchor: result.ledger.integrity, project, secret });
      assert.ok(visibleRunProperties(await xml(final)).every(pr => !pr.includes('yellow')));
    }
  }
});

test('nested and top-level copied rows retain corresponding cell colors after real confirmation', async () => {
  const colorP = (text: string, color: string) => `<w:p><w:r><w:rPr><w:highlight w:val="${color}"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  const colored = tbl(colorP('A', 'red'), colorP('B', 'darkGreen'));
  for (const nested of [false, true]) {
    const base = await make(nested ? tbl(colored + '<w:p/>') : colored), ledger = ledgerFor(base);
    const at = nested ? 't:0/r:0/c:0/t:0/r:0' : 't:0/r:0';
    const edited = await edit(base, ledger, [{ op: 'insert_rows', at, mode: 'after', rows: [['X', 'Y']] }]);
    const doc = await xml(edited.output);
    for (const item of ledger.pending) await confirmPending(ledger, name, item.id, doc, context, secret);
    await sealLedger(ledger, root, secret);
    const final = await finalizeDraftMarkers(host, { name, root, draft: edited.output, base, ledger, anchor: ledger.integrity, project, secret });
    assert.deepEqual(visibleRunProperties(await xml(final)).map(pr => /w:val="([^"]+)"/.exec(pr)?.[1]), ['red', 'darkGreen', 'red', 'darkGreen']);
  }
});

for (const layout of ['row', 'column']) for (const op of ['set_cell', 'blank']) test(`same ${layout} style survives real confirmation for ${op}`, async () => {
  const colored = '<w:p><w:r><w:rPr><w:highlight w:val="darkGreen"/></w:rPr><w:t>SOURCE</w:t></w:r></w:p>';
  const row = (...cells: string[]) => `<w:tr>${cells.map(cell => `<w:tc>${cell}</w:tc>`).join('')}</w:tr>`;
    const base = await make(`<w:tbl>${layout === 'row' ? row(colored, '<w:p/>') : row(colored) + row('<w:p/>')}</w:tbl>`), ledger = ledgerFor(base);
    const at = layout === 'row' ? 't:0/r:0/c:1' : 't:0/r:1/c:0';
    const operation: AgentEdit = op === 'set_cell' ? { op, at, value: 'FILL' } : { op: 'replace', at, blank: 0, value: 'FILL' };
    const result = await edit(base, ledger, [operation]), doc = await xml(result.output);
    for (const item of ledger.pending) await confirmPending(ledger, name, item.id, doc, context, secret);
    await sealLedger(ledger, root, secret);
    const final = await finalizeDraftMarkers(host, { name, root, draft: result.output, base, ledger, anchor: ledger.integrity, project, secret });
    const props = visibleRunProperties(await xml(final));
    assert.equal(props.length, 'SOURCEFILL'.length);
    assert.ok(props.slice(6).every(pr => pr.includes('darkGreen')), `${layout} ${op}`);
});

test('inserting inside a fact range preserves its identity and C05 detects changed value', async () => {
  const body = `<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_fact1"/><w:r><w:t>FIRST</w:t></w:r></w:p><w:p><w:r><w:t>SECOND</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>`;
  const base = await make(tbl(body)), ledger = ledgerFor(base);
  ledger.fills.push({ id: 'fact1', draft: name, operation: 'replace', reference: 'test', resolvedValue: 'FIRSTSECOND', verified: true });
  assert.equal((await check(base, base, ledger)).results.C05.length, 0);
  const edited = await edit(base, ledger, [{ op: 'insert', at: `${c}/p:0`, position: 'after', markdown: 'INSERTED' }]);
  assert.equal(sealRanges(await xml(edited.output))[0].name, '_Seal_F_fact1');
  assert.equal((await check(base, edited.output, ledger)).results.C05.length, 1);
});
