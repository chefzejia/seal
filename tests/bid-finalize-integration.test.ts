import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPort } from '../src/core/host.js';
import { editBidDraft } from '../src/core/bid/edit.js';
import { finalizeDraftMarkers } from '../src/core/bid/finalize.js';
import { confirmPending } from '../src/core/bid/human-review.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import type { BidLedger, ProjectMetadata } from '../src/core/bid/project.js';
import { readZip, sha256Hex, writeZip } from '../src/core/docx/zip.js';
import { editableText, visibleRunProperties } from '../src/core/docx/visible-surgery.js';

async function confirmAll(ledger: BidLedger, draft: Uint8Array, context: { root: string; vaultId: string | null; deadline: string }, secret: Uint8Array): Promise<void> {
  const xml = new TextDecoder().decode((await readZip(draft)).get('word/document.xml'));
  for (const item of ledger.pending.filter(item => item.status !== 'removed')) await confirmPending(ledger, 'bid', item.id, xml, context, secret);
}

test('human-reviewed draft clears only its authenticated pending mark', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>姓名：____</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const edited = await editBidDraft({ name: 'bid', old: base, base, ledger, operations: [{ op: 'replace', at: 'p:0', find: '____', value: '张三', pending: { category: '其他', note: '核对' } }], images: new Map(), markdownImages: new Map() });
  const secret = new Uint8Array(32).fill(17), host = {} as HostPort;
  await confirmAll(ledger, edited.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const input = { name: 'bid', root: context.root, draft: edited.output, base, ledger, anchor: ledger.integrity, project, secret };
  const final = await finalizeDraftMarkers(host, input);
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.ok(xml.includes('张三')); assert.ok(visibleRunProperties(xml).every(properties => !properties.includes('w:val="yellow"')));
  assert.ok(new TextDecoder().decode((await readZip(edited.output)).get('word/document.xml')).includes('w:highlight w:val="yellow"'));
  ledger.pending[0].confirmation = undefined;
  await assert.rejects(finalizeDraftMarkers(host, input));
  await sealLedger(ledger, context.root, secret);
  await assert.rejects(finalizeDraftMarkers(host, { ...input, anchor: ledger.integrity }));
});

test('marked mixed colors retain source segments through a partial replacement', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:p><w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:t>A</w:t></w:r><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>B</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const run = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, base, ledger, operations, images: new Map(), markdownImages: new Map() });
  const marked = await run(base, [{ op: 'mark_pending', at: 'p:0', find: 'AB', pending: { category: '其他', note: '待核验' } }]);
  const secret = new Uint8Array(32).fill(21), host = {} as HostPort;
  await confirmAll(ledger, marked.output, context, secret);
  const changed = await run(marked.output, [{ op: 'replace', at: 'p:0', find: 'B', value: 'X' }]);
  await confirmAll(ledger, changed.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const final = await finalizeDraftMarkers(host, { name: 'bid', root: context.root, draft: changed.output, base, ledger, anchor: ledger.integrity, project, secret });
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.match(xml, /w:val="red"[^]*?<w:t[^>]*>A<\/w:t>/);
  assert.match(xml, /w:val="green"[^]*?<w:t[^>]*>X<\/w:t>/);
  for (const run of xml.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) ?? []) {
    if (/<w:t(?:\s[^>]*)?>[^<]+<\/w:t>/.test(run)) assert.ok(!run.includes('w:highlight w:val="yellow"'));
  }
});

test('confirmed checkbox restores its original highlight', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:p><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>□</w:t></w:r><w:r><w:t>选项</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const edited = await editBidDraft({ name: 'bid', old: base, base, ledger, operations: [{ op: 'check', at: 'p:0', option: '选项', checked: true, pending: { category: '其他', note: '待核验' } }], images: new Map(), markdownImages: new Map() });
  const secret = new Uint8Array(32).fill(22);
  await confirmAll(ledger, edited.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft: edited.output, base, ledger, anchor: ledger.integrity, project, secret });
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.match(xml, /w:val="green"[^]*?<w:t[^>]*>☑<\/w:t>/);
});

test('confirmed empty cell fill restores inherited neighbor highlight', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>标签</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const edited = await editBidDraft({ name: 'bid', old: base, base, ledger, operations: [{ op: 'set_cell', at: 't:0/r:0/c:1', value: '填写', pending: { category: '其他', note: '核对' } }], images: new Map(), markdownImages: new Map() });
  const secret = new Uint8Array(32).fill(23);
  await confirmAll(ledger, edited.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft: edited.output, base, ledger, anchor: ledger.integrity, project, secret });
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.match(xml, /w:val="green"[^]*?<w:t[^>]*>填写<\/w:t>/);
});

test('a later empty-cell pending mark does not inherit a prior pending yellow', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const edit = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, base, ledger, operations, images: new Map(), markdownImages: new Map() });
  const first = await edit(base, [{ op: 'set_cell', at: 't:0/r:0/c:0', value: '第一项', pending: { category: '其他', note: '核对' } }]);
  const second = await edit(first.output, [{ op: 'set_cell', at: 't:0/r:0/c:1', value: '第二项', pending: { category: '其他', note: '核对' } }]);
  const secret = new Uint8Array(32).fill(26);
  await confirmAll(ledger, second.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft: second.output, base, ledger, anchor: ledger.integrity, project, secret });
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.equal(visibleRunProperties(xml).some(properties => properties.includes('w:val="yellow"')), false);
});

for (const color of ['yellow', 'green', 'red', null] as const) for (const pendingSource of [false, true]) for (const useBlank of [false, true]) test(`empty-cell style source=${color} pending=${pendingSource} blank=${useBlank}`, async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const cell = 't:0/r:0/c:1';
    const style = color ? `<w:rPr><w:highlight w:val="${color}"/></w:rPr>` : '';
    const source = `<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r>${style}<w:t>来源</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`;
    const base = await writeZip(new Map([['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', enc(source)]]));
    const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
    const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
    const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
    const edit = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, base, ledger, operations, images: new Map(), markdownImages: new Map() });
    const initial = pendingSource ? (await edit(base, [{ op: 'mark_pending', at: 't:0/r:0/c:0', find: '来源', pending: { category: '其他', note: '核对' } }])).output : base;
    const draft = (await edit(initial, [useBlank ? { op: 'replace', at: cell, blank: 0, value: '填写', pending: { category: '其他', note: '核对' } } : { op: 'set_cell', at: cell, value: '填写', pending: { category: '其他', note: '核对' } }])).output;
    const mark = ledger.pending.at(-1)!;
    assert.ok(mark.originalHighlights.every(value => color ? value?.includes(`w:val="${color}"`) : value === null), `${color} pending=${pendingSource} blank=${useBlank}`);
    const secret = new Uint8Array(32).fill(27);
    await confirmAll(ledger, draft, context, secret);
    await sealLedger(ledger, context.root, secret);
    const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft, base, ledger, anchor: ledger.integrity, project, secret });
    const finalXml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
    const properties = visibleRunProperties(finalXml).slice(-2);
    assert.ok(properties.every(value => color ? value.includes(`w:val="${color}"`) : !value.includes('w:highlight')), `${color} pending=${pendingSource} blank=${useBlank}`);
});

test('confirmed copied row restores styles from both populated and empty cells', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>模板</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:rPr><w:highlight w:val="red"/></w:rPr></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const edited = await editBidDraft({ name: 'bid', old: base, base, ledger, operations: [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['甲', '乙']], pending: { category: '其他', note: '核对' } }], images: new Map(), markdownImages: new Map() });
  const secret = new Uint8Array(32).fill(24);
  await confirmAll(ledger, edited.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft: edited.output, base, ledger, anchor: ledger.integrity, project, secret });
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.match(xml, /w:val="green"[^]*?<w:t[^>]*>甲<\/w:t>/);
  assert.match(xml, /w:val="red"[^]*?<w:t[^>]*>乙<\/w:t>/);
});

test('copied row resolves its first source character through a prior pending range', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  for (const color of ['yellow', 'green', 'red', null] as const) for (const pendingSource of [false, true]) {
    const style = color ? `<w:rPr><w:highlight w:val="${color}"/></w:rPr>` : '';
    const base = await writeZip(new Map([
      ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
      ['word/document.xml', enc(`<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r>${style}<w:t>模板</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`) ],
    ]));
    const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
    const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
    const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
    const edit = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, base, ledger, operations, images: new Map(), markdownImages: new Map() });
    const initial = pendingSource ? (await edit(base, [{ op: 'mark_pending', at: 't:0/r:0/c:0', find: '模板', pending: { category: '其他', note: '核对' } }])).output : base;
    const draft = (await edit(initial, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['填写']], pending: { category: '其他', note: '核对' } }])).output;
    const secret = new Uint8Array(32).fill(28);
    await confirmAll(ledger, draft, context, secret);
    await sealLedger(ledger, context.root, secret);
    const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft, base, ledger, anchor: ledger.integrity, project, secret });
    const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
    const properties = visibleRunProperties(xml).slice(-2);
    assert.ok(properties.every(value => color ? value.includes(`w:val="${color}"`) : !value.includes('w:highlight')), `${color} pending=${pendingSource}`);
  }
});

test('a replacement that retains a prefix still inherits the first character style for its entire range', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:p><w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:t>A</w:t></w:r><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>B</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const run = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, base, ledger, operations, images: new Map(), markdownImages: new Map() });
  const marked = await run(base, [{ op: 'mark_pending', at: 'p:0', find: 'AB', pending: { category: '其他', note: '待核验' } }]);
  const changed = await run(marked.output, [{ op: 'replace', at: 'p:0', find: 'AB', value: 'AX' }]);
  const secret = new Uint8Array(32).fill(25);
  await confirmAll(ledger, changed.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft: changed.output, base, ledger, anchor: ledger.integrity, project, secret });
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.equal(editableText(xml), 'AX');
  assert.ok(visibleRunProperties(xml).every(properties => /w:highlight w:val="red"/.test(properties)));
});

test('covering a pending range replaces its identity and restores inherited format', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:p><w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:t>甲</w:t></w:r><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>（报价金额）</w:t></w:r><w:r><w:t>中</w:t></w:r><w:r><w:rPr><w:highlight w:val="blue"/></w:rPr><w:t>（报价金额）</w:t></w:r><w:r><w:t>尾</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const run = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, base, ledger, operations, images: new Map(), markdownImages: new Map() });
  const filled = await run(base, [{ op: 'replace', at: 'p:0', blank: 0, value: '100' }, { op: 'replace', at: 'p:0', blank: 1, value: '100' }]);
  const prior = ledger.pending.map(item => item.id);
  const changed = await run(filled.output, [{ op: 'replace', at: 'p:0', find: '甲100', value: '甲101' }]);
  assert.equal(ledger.pending.find(item => item.id === prior[0])?.status, 'removed');
  assert.equal(ledger.pending.find(item => item.id === prior[1])?.status, 'open');
  const secret = new Uint8Array(32).fill(25);
  await confirmAll(ledger, changed.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft: changed.output, base, ledger, anchor: ledger.integrity, project, secret });
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  const properties = visibleRunProperties(xml);
  assert.equal(editableText(xml), '甲101中100尾');
  assert.ok(properties.slice(0, 4).every(value => /w:highlight w:val="red"/.test(value)));
  assert.ok(properties.slice(5, 8).every(value => /w:highlight w:val="blue"/.test(value)));
});

test('partial cross-leaf replacement rejects without changing the ledger', async () => {
  const enc = (text: string) => new TextEncoder().encode(text), cell = 't:0/r:0/c:0', first = `${cell}/p:0`;
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:t>前</w:t></w:r><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>（报价金额）</w:t></w:r><w:r><w:rPr><w:highlight w:val="cyan"/></w:rPr><w:t>后</w:t></w:r></w:p><w:p><w:r><w:rPr><w:highlight w:val="blue"/></w:rPr><w:t>尾文</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const run = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, base, ledger, operations, images: new Map(), markdownImages: new Map() });
  const filled = await run(base, [{ op: 'replace', at: first, blank: 0, value: '100' }]);
  const before = structuredClone(ledger);
  await assert.rejects(run(filled.output, [{ op: 'replace', at: cell, find: '00后尾文', value: '01后尾文' }]), /部分交叉/);
  assert.deepEqual(ledger, before);
});

test('marking across a prior fill and untouched text restores their original styles', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:p><w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:t>甲</w:t></w:r><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>____</w:t></w:r><w:r><w:rPr><w:highlight w:val="blue"/></w:rPr><w:t>乙</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const run = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, base, ledger, operations, images: new Map(), markdownImages: new Map() });
  const filled = await run(base, [{ op: 'replace', at: 'p:0', find: '____', value: '张三' }]);
  const marked = await run(filled.output, [{ op: 'mark_pending', at: 'p:0', find: '甲张三乙', pending: { category: '其他', note: '待核验' } }]);
  const changed = await run(marked.output, [{ op: 'replace', at: 'p:0', find: '张三', value: '李四' }]);
  const secret = new Uint8Array(32).fill(26);
  await confirmAll(ledger, changed.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft: changed.output, base, ledger, anchor: ledger.integrity, project, secret });
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.match(xml, /w:val="red"[^]*?<w:t[^>]*>甲<\/w:t>/);
  assert.match(xml, /w:val="green"[^]*?<w:t[^>]*>李四<\/w:t>/);
  assert.match(xml, /w:val="blue"[^]*?<w:t[^>]*>乙<\/w:t>/);
});

test('ordinary inserted text can later be marked, confirmed and finalized', async () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', enc('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>原文</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = { format: 'seal-project-1', name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } };
  const run = (old: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old, base, ledger, operations, images: new Map(), markdownImages: new Map() });
  const inserted = await run(base, [{ op: 'insert', at: 'p:0', position: 'after', markdown: '新增文字' }]);
  assert.equal(ledger.pending.length, 0);
  const marked = await run(inserted.output, [{ op: 'mark_pending', at: 'p:1', find: '新增文字', pending: { category: '其他', note: '待核验' } }]);
  const secret = new Uint8Array(32).fill(27);
  await confirmAll(ledger, marked.output, context, secret);
  await sealLedger(ledger, context.root, secret);
  const final = await finalizeDraftMarkers({} as HostPort, { name: 'bid', root: context.root, draft: marked.output, base, ledger, anchor: ledger.integrity, project, secret });
  const xml = new TextDecoder().decode((await readZip(final)).get('word/document.xml'));
  assert.match(xml, /新增文字/);
  assert.ok(visibleRunProperties(xml).every(properties => !properties.includes('w:val="yellow"')));
});
