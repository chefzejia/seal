import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPort } from '../src/core/host.js';
import type { BidLedger } from '../src/core/bid/project.js';
import { checkDraft } from '../src/core/bid/check.js';
import { editBidDraft, type AgentEdit } from '../src/core/bid/edit.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import { confirmPending } from '../src/core/bid/human-review.js';
import { readZip, sha256Hex, writeZip } from '../src/core/docx/zip.js';
import { editableText } from '../src/core/docx/visible-surgery.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';

const encoder = new TextEncoder();
const makeDocument = (text: string) => writeZip(new Map([
  ['[Content_Types].xml', encoder.encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
  ['word/document.xml', encoder.encode(`<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) ],
]));
const xmlOf = async (bytes: Uint8Array) => new TextDecoder().decode((await readZip(bytes)).get('word/document.xml'));
const freshLedger = (base: Uint8Array): BidLedger => ({ format: 'seal-ledger-1', fills: [], pending: [], dismissals: [], acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) }, bases: { bid: sha256Hex(base) } });
const context = { root: '/project', vaultId: null, deadline: '2028-02-29' }, secret = new Uint8Array(32).fill(6);
const project = { format: 'seal-project-1' as const, name: 'test', deadline: context.deadline, vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01' };

test('R4 batch and separate edits agree on current hints and pending content', async () => {
  const base = await makeDocument('前缀甲（报价金额）（报价金额）（报价金额）后缀乙');
  const operations: AgentEdit[] = [
    { op: 'replace', at: 'p:0', find: '前缀甲', value: '序言变更' },
    { op: 'replace', at: 'p:0', blank: 0, value: '100' },
    { op: 'replace', at: 'p:0', find: '后缀乙', value: '结尾变更' },
  ];
  const run = async (separate: boolean) => {
    const ledger = freshLedger(base);
    const edit = (old: Uint8Array, edits: AgentEdit[]) => editBidDraft({ name: 'bid', old, ledger, operations: edits, images: new Map(), markdownImages: new Map() });
    let draft = (await edit(base, [{ op: 'dismiss_hint', at: 'p:0', blank: 2, reason: '跳过第三项' }])).output;
    if (separate) for (const operation of operations) draft = (await edit(draft, [operation])).output;
    else draft = (await edit(draft, operations)).output;
    await sealLedger(ledger, context.root, secret);
    const report = await checkDraft({} as HostPort, { name: 'bid', root: context.root, draft, base, ledger, project, secret }) as { results: Record<string, unknown[]> };
    const xml = await xmlOf(draft);
    assert.equal(editableText(xml), '序言变更100（报价金额）（报价金额）结尾变更');
    assert.equal(report.results.C02.length, 2);
    assert.equal(report.results.C03.length, 0);
    assert.equal(report.results.C10.length, 0);
    const range = sealRanges(xml).find(item => item.text === '100');
    assert.ok(range);
    const item = ledger.pending.find(pending => `_Seal_P_${pending.id}` === range.name);
    assert.ok(item?.reasons.some(reason => reason.source === 'keyword'));
    assert.ok(!item?.reasons.some(reason => reason.source === 'unverified'));
    return sealRanges(xml).map(range => range.text);
  };
  assert.deepEqual(await run(false), await run(true));
});

test('changing text inside a confirmed range preserves its id and reopens it', async () => {
  const base = await makeDocument('报价：____'), ledger = freshLedger(base);
  const edit = (old: Uint8Array, edits: AgentEdit[]) => editBidDraft({ name: 'bid', old, ledger, operations: edits, images: new Map(), markdownImages: new Map() });
  const draft = (await edit(base, [{ op: 'replace', at: 'p:0', find: '____', value: '100万元' }])).output;
  const id = ledger.pending[0].id;
  await confirmPending(ledger, 'bid', id, await xmlOf(draft), context, secret);
  const changed = (await edit(draft, [{ op: 'replace', at: 'p:0', find: '100', value: '200' }])).output;
  assert.equal(ledger.pending.find(item => item.id === id)?.status, 'open');
  assert.equal(sealRanges(await xmlOf(changed)).find(range => range.name === `_Seal_P_${id}`)?.text, '200万元');
  await sealLedger(ledger, context.root, secret);
  const report = await checkDraft({} as HostPort, { name: 'bid', root: context.root, draft: changed, base, ledger, project, secret }) as { results: Record<string, unknown[]> };
  assert.equal(report.results.C04.length, 1);
  assert.equal(report.results.C10.length, 0);
});
