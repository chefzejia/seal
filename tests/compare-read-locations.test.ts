import { test } from 'node:test';
import { checkDraft } from '../src/core/bid/check.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import type { BidLedger, ProjectMetadata } from '../src/core/bid/project.js';
import type { HostPort } from '../src/core/host.js';
import assert from 'node:assert/strict';
import { compareDocuments } from '../src/core/docx/package-compare.js';
import { readDocument } from '../src/core/docx/read-document.js';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { sha256Hex, writeZip } from '../src/core/docx/zip.js';

const enc = (s: string) => new TextEncoder().encode(s);
const p = (s: string) => `<w:p><w:r><w:t>${s}</w:t></w:r></w:p>`;
const wrap = (type: string, s: string) => type === 'custom' ? `<w:customXml w:uri="urn:test" w:element="x">${s}</w:customXml>` : `<w:sdt><w:sdtContent>${s}</w:sdtContent></w:sdt>`;
const make = (body: string) => writeZip(new Map([
  ['[Content_Types].xml', enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')],
  ['word/document.xml', enc(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`)],
]));

for (const type of ['custom', 'sdt', 'nested']) test(`${type} wrapped content and siblings use readable locations`, async () => {
  const w = (s: string) => type === 'nested' ? wrap('custom', wrap('sdt', s)) : wrap(type, s);
  const base = await make(p('前锚点') + w(p('包装原文')) + p('后锚点'));
  assert.deepEqual(await compareDocuments(base, base), []);
  const changedOutside = await editTextDocument(base, [{ op: 'replace', at: 'p:1', find: '后锚点', value: '后段变更' }]);
  const diffOutside = (await compareDocuments(base, changedOutside)).find(d => d.kind === 'modified')!;
  assert.equal(diffOutside.address, 'p:1');
  assert.equal((await readDocument(changedOutside, { mode: 'blocks', from: diffOutside.address, limit: 1 })).items[0].text, '后段变更');
  const changedInside = await make(p('前锚点') + w(p('包装变更')) + p('后锚点'));
  const diffInside = (await compareDocuments(base, changedInside)).find(d => d.kind === 'modified')!;
  const view = await readDocument(changedInside, { mode: 'blocks' });
  const inside = view.items.find(item => item.text === '包装变更')!;
  assert.equal(inside.editable, false);
  assert.equal(diffInside.address, inside.location);
  const root = '/test-project', secret = new Uint8Array(32).fill(17);
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(changedInside) }, bases: { bid: sha256Hex(base) } };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'bid', deadline: '2028-12-31', vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  await sealLedger(ledger, root, secret);
  const checked = await checkDraft({} as HostPort, { name: 'bid', root, draft: changedInside, base, ledger, project, secret, anchor: ledger.integrity }) as { results: { C06: Array<{ address: string }> } };
  assert.equal(checked.results.C06[0].address, inside.location);
  assert.equal((await readDocument(changedInside, { mode: 'blocks', from: diffInside.address, limit: 1 })).items[0].text, '包装变更');
  await assert.rejects(editTextDocument(changedInside, [{ op: 'replace', at: diffInside.address, find: '包装变更', value: '非法编辑' }]));
});

test('wrapped rows cells and nested tables do not affect editable table addresses', async () => {
  const cell = (s: string) => `<w:tc>${p(s)}</w:tc>`;
  const row = (s: string) => `<w:tr>${s}</w:tr>`;
  const inner = (v: string) => `<w:tbl>${row(cell('内首') + wrap('sdt', cell('只读内格')) + cell(v))}</w:tbl>`;
  const body = (v: string) => `<w:tbl>${row(cell('首行'))}${wrap('custom', row(cell('只读行')))}${row(`<w:tc>${p('格前') + wrap('custom', p('格内只读')) + p(v) + inner('内尾')}</w:tc>`)}</w:tbl>`;
  const base = await make(body('格尾'));
  const after = await editTextDocument(base, [{ op: 'replace', at: 't:0/r:1/c:0/p:1', find: '格尾', value: '格后改动' }]);
  const diff = (await compareDocuments(base, after)).find(d => d.kind === 'modified' && d.before === '格尾')!;
  assert.equal(diff.address, 't:0/r:1/c:0/p:1');
  assert.equal((await readDocument(after, { mode: 'blocks', from: diff.address, limit: 1 })).items[0].text, '格后改动');
  for (const text of ['只读行', '格内只读', '只读内格']) {
    const changed = await make(body('格尾').replace(text, `${text}变更`));
    const difference = (await compareDocuments(base, changed)).find(d => d.kind === 'modified' && d.before === text)!;
    const read = await readDocument(changed, { mode: 'blocks' });
    const item = read.items.find(entry => entry.text === `${text}变更`)!;
    assert.equal(difference.address, item.location);
    assert.equal((await readDocument(changed, { mode: 'blocks', from: difference.address, limit: 1 })).items[0].text, `${text}变更`);
  }
});

test('difference ID uses baseline address while report location follows a moved changed paragraph', async () => {
  const base = await make(p('原文内容') + p('尾部'));
  const simple = await make(p('改写内容') + p('尾部'));
  const shifted = await make(p('新增段落') + p('改写内容') + p('尾部'));
  const direct = (await compareDocuments(base, simple)).find(d => d.kind === 'modified')!;
  const changed = (await compareDocuments(base, shifted)).find(d => d.kind === 'modified')!;
  assert.equal(direct.address, 'p:0');
  assert.equal(changed.address, 'p:1');
  assert.equal(changed.id, direct.id);
  assert.equal((await readDocument(shifted, { mode: 'blocks', from: changed.address, limit: 1 })).items[0].text, '改写内容');
});

test('wrapped difference ID stays tied to baseline location while report follows the shifted read location', async () => {
  for (const type of ['custom', 'sdt', 'nested']) {
    const wrapped = (value: string) => type === 'nested' ? wrap('custom', wrap('sdt', p(value))) : wrap(type, p(value));
    const version = (prefix: string, value: string) => make(prefix + wrapped(value) + p('尾部'));
    const base = await version('', '包装原文');
    const simple = await version('', '包装改写');
    const shifted = await version(wrapped('独立新段'), '包装改写');
    const direct = (await compareDocuments(base, simple)).find(d => d.kind === 'modified')!;
    const moved = (await compareDocuments(base, shifted)).find(d => d.kind === 'modified')!;
    assert.equal(moved.id, direct.id, type);
    assert.notEqual(moved.address, direct.address, type);
    const item = (await readDocument(shifted, { mode: 'blocks', from: moved.address, limit: 1 })).items[0];
    assert.equal(item.text, '包装改写', type);
    assert.equal(item.editable, false, type);
  }
});
