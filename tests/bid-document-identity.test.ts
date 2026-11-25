import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { readZip, writeZip } from '../src/core/docx/zip.js';
import { editBidDraft } from '../src/core/bid/edit.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';
import type { BidLedger } from '../src/core/bid/project.js';
import { editableText } from '../src/core/docx/visible-surgery.js';
import { currentHints } from '../src/core/bid/dismissals.js';

const run = promisify(execFile);
const encode = (value: string) => new TextEncoder().encode(value);
const document = (text: string) => writeZip(new Map([
  ['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
  ['word/document.xml', encode(`<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`)],
]));

test('CLI invalidates a dismissed hint after its block changes and stores pending identity in Word', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/document-identity-'));
  const cli = async (...args: string[]) => JSON.parse((await run(process.execPath, ['--import', 'tsx', 'src/shells/cli/index.ts', ...args], { env: { ...process.env, SEAL_HOME: path.join(sandbox, 'home') } })).stdout);
  try {
    const source = path.join(sandbox, 'original.docx'), root = path.join(sandbox, 'project');
    const original = await document('前缀甲（报价金额）（报价金额）（报价金额）后缀乙');
    await writeFile(source, original);
    await cli('project', 'init', '--root', root, '--name', '测试', '--deadline', '2028-02-29', '--tender', source);
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', '商务', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:0' }]));
    await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'dismiss_hint', at: 'p:0', blank: 2, reason: '保留第三项' }]));
    await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([
      { op: 'replace', at: 'p:0', find: '前缀甲', value: '序言变更' },
      { op: 'replace', at: 'p:0', blank: 0, value: '100' },
      { op: 'replace', at: 'p:0', find: '后缀乙', value: '结尾变更' },
    ]));
    const report = await cli('check', '--project', root, '--draft', '商务');
    assert.equal(report.counts.C02, 2);
    assert.equal(report.counts.C03, 0);
    const ledger = JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8'));
    assert.ok(Array.isArray(ledger.dismissals));
    assert.equal(ledger.hints, undefined);
    assert.ok(ledger.pending.some((item: { reasons: Array<{ source: string }> }) => item.reasons.some(reason => reason.source === 'keyword') && !item.reasons.some(reason => reason.source === 'unverified')));
    const parts = await readZip(await readFile(path.join(root, 'draft', '商务.docx')));
    const xml = new TextDecoder().decode(parts.get('word/document.xml'));
    assert.match(xml, /w:name="_Seal_P_[^"]+"/);
    assert.deepEqual(await readFile(source), Buffer.from(original));
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test('inserted pending text receives a document-owned range', async () => {
  const old = await document('原文');
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
  const operation = { op: 'insert' as const, at: 'p:0', position: 'after' as const, markdown: '新承诺', pending: { category: '承诺' as const, note: '待确认' } };
  const result = await editBidDraft({ name: 'bid', old, ledger, operations: [operation], images: new Map(), markdownImages: new Map() });
  const parts = await readZip(result.output);
  const ranges = sealRanges(new TextDecoder().decode(parts.get('word/document.xml')));
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].text, '新承诺');
  assert.equal(result.ledger.pending[0].id, ranges[0].name.slice('_Seal_P_'.length));
});

test('existing pending ranges follow exact edits and never transfer to repeated text', async () => {
  const original = '前缀甲（报价金额）（报价金额）（报价金额）后缀乙';
  for (const selected of [0, 2]) {
    const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
    const old = await document(original);
    const apply = (bytes: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old: bytes, ledger, operations, images: new Map(), markdownImages: new Map() });
    const first = await apply(old, [{ op: 'mark_pending', at: 'p:0', blank: selected, pending: { category: '报价', note: '待确认' } }]);
    const id = ledger.pending[0].id;
    const edited = await apply(first.output, [{ op: 'replace', at: 'p:0', find: '前缀甲', value: '序言变更' }, { op: 'replace', at: 'p:0', blank: 0, value: '100' }, { op: 'replace', at: 'p:0', find: '后缀乙', value: '结尾变更' }]);
    const xml = new TextDecoder().decode((await readZip(edited.output)).get('word/document.xml'));
    assert.equal(editableText(xml), '序言变更100（报价金额）（报价金额）结尾变更');
    const range = sealRanges(xml).find(item => item.name === `_Seal_P_${id}`);
    assert.equal(range?.text, selected === 0 ? '100' : '（报价金额）');
    assert.equal(range?.start, selected === 0 ? '序言变更'.length : '序言变更100（报价金额）'.length);
  }
});

test('partial overlap rejects the batch without mutating its ledger; full cover removes identity', async () => {
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
  const old = await document('前甲乙后');
  const apply = (bytes: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old: bytes, ledger, operations, images: new Map(), markdownImages: new Map() });
  const first = await apply(old, [{ op: 'mark_pending', at: 'p:0', find: '甲乙', pending: { category: '其他', note: '待定' } }]);
  const before = structuredClone(ledger), original = first.output.slice();
  await assert.rejects(apply(first.output, [{ op: 'replace', at: 'p:0', find: '前甲', value: '新文' }]), /部分交叉/);
  assert.deepEqual(ledger, before);
  assert.deepEqual(first.output, original);
  const second = await apply(first.output, [{ op: 'replace', at: 'p:0', find: '前甲乙', value: '新文', pending: { category: '其他', note: '新待定' } }]);
  assert.equal(ledger.pending[0].status, 'removed');
  const ranges = sealRanges(new TextDecoder().decode((await readZip(second.output)).get('word/document.xml')));
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].text, '新文');
});

test('parent-cell replacement identifies hints from its current two-leaf content', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const xml = '<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>前缀甲（报价金额）后缀甲</w:t></w:r></w:p><w:p><w:r><w:t>前缀乙（报价金额）后缀乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const old = await writeZip(new Map([['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', encode(xml)]]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
  const result = await editBidDraft({ name: 'bid', old, ledger, operations: [{ op: 'replace', at: 't:0/r:0/c:0', find: '前缀甲（报价金额）后缀甲前缀乙（报价金额）后缀乙', value: '变化甲（报价金额）尾甲变化乙（报价金额）尾乙' }], images: new Map(), markdownImages: new Map() });
  const edited = new TextDecoder().decode((await readZip(result.output)).get('word/document.xml'));
  assert.equal(currentHints(edited, 'bid').filter(hint => hint.hintText === '（报价金额）').length, 2);
  const marked = await editBidDraft({ name: 'bid', old, ledger: { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} }, operations: [
    { op: 'mark_pending', at: 't:0/r:0/c:0/p:0', find: '（报价金额）', pending: { category: '报价', note: '待定' } },
    { op: 'mark_pending', at: 't:0/r:0/c:0/p:1', find: '（报价金额）', pending: { category: '报价', note: '待定' } },
  ], images: new Map(), markdownImages: new Map() });
  const replaced = await editBidDraft({ name: 'bid', old: marked.output, ledger: marked.ledger, operations: [{ op: 'replace', at: 't:0/r:0/c:0', find: '前缀甲（报价金额）后缀甲前缀乙（报价金额）后缀乙', value: '变化甲（报价金额）尾甲变化乙（报价金额）尾乙' }], images: new Map(), markdownImages: new Map() });
  assert.equal(replaced.ledger.pending.filter(item => item.status === 'removed').length, 2);
  const markedXml = new TextDecoder().decode((await readZip(replaced.output)).get('word/document.xml'));
  assert.equal(currentHints(markedXml, 'bid').filter(hint => hint.hintText === '（报价金额）').length, 2);
});

test('copying a row with a pending range creates an independent pending identity', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const xml = '<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>旧值</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const old = await writeZip(new Map([['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', encode(xml)]]));
  const ledger: BidLedger = { format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: {} };
  const apply = (bytes: Uint8Array, operations: Parameters<typeof editBidDraft>[0]['operations']) => editBidDraft({ name: 'bid', old: bytes, ledger, operations, images: new Map(), markdownImages: new Map() });
  const first = await apply(old, [{ op: 'mark_pending', at: 't:0/r:0/c:0/p:0', find: '旧值', pending: { category: '其他', note: '核对' } }]);
  const second = await apply(first.output, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['新值']], pending: { category: '其他', note: '新行核对' } }]);
  const ranges = sealRanges(new TextDecoder().decode((await readZip(second.output)).get('word/document.xml')));
  assert.deepEqual(ranges.map(range => range.text), ['旧值', '新值']);
  assert.notEqual(ranges[0].name, ranges[1].name);
  assert.equal(ledger.pending.length, 2);
});
