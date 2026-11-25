import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDocument, type ReadDocumentOptions } from '../src/core/docx/read-document.js';
import { writeZip } from '../src/core/docx/zip.js';
import { editBidDraft } from '../src/core/bid/edit.js';
import { checkDraft } from '../src/core/bid/check.js';
import { finalizeDraftMarkers } from '../src/core/bid/finalize.js';
import { readProject } from '../src/core/bid/project.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import { readZip, sha256Hex } from '../src/core/docx/zip.js';
import { validatePackageStructure } from '../src/core/docx/package-structure.js';
import { patchRequirements, parseRequirements, type Requirement } from '../src/core/bid/requirements.js';
import { reviewHint, confirmPending } from '../src/core/bid/human-review.js';
import { currentHints } from '../src/core/bid/dismissals.js';
import { KnowledgeBase } from '../src/core/kb/index.js';
import { serializeEntry } from '../src/core/kb/markdown.js';
import type { HostPort } from '../src/core/host.js';
import { NodeHostPort } from '../src/shells/node-host.js';
import { runProject } from '../src/shells/cli/project-v2.js';
import { runKnowledgeBase } from '../src/shells/cli/kb.js';
import { SEAL_BID_SKILL } from '../src/shells/dsh/seal-bid-skill.js';
import { SEAL_KB_SKILL } from '../src/shells/dsh/seal-kb-skill.js';

const enc = new TextEncoder();
const p = (text: string, properties = '') =>
  `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const doc = (body: string) =>
  `<w:document xmlns:w="word" xmlns:r="relations" xmlns:a="drawing" xmlns:mc="compat"><w:body>${body}<w:sectPr/></w:body></w:document>`;

async function packageOf(body: string): Promise<Uint8Array> {
  return writeZip(new Map([
    ['[Content_Types].xml', enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>')],
    ['word/document.xml', enc.encode(doc(body))],
    ['word/_rels/document.xml.rels', enc.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>')],
  ]));
}

async function createSandbox(t: TestContext, prefix: string) {
  await fs.mkdir('.tmp', { recursive: true });
  const sandbox = await fs.mkdtemp(path.resolve('.tmp', prefix));
  const previousSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  t.after(async () => {
    if (previousSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previousSealHome;
    await fs.rm(sandbox, { recursive: true, force: true });
  });
  return sandbox;
}

test('readDocument supports to (with descendants) and onlyHints across blocks, outline and cursor fingerprint', async () => {
  const table =
    `<w:tbl><w:tr><w:tc>${p('表0格0（无空白）')}</w:tc><w:tc><w:p/></w:tc></w:tr>` +
    `<w:tr><w:tc>${p('嵌套前：____')}<w:tbl><w:tr><w:tc>${p('嵌套表无空')}</w:tc></w:tr></w:tbl></w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>`;
  const body = [
    p('第一章 总则', '<w:outlineLvl w:val="0"/>'),
    p('无空白引言段'),
    p('第二章 格式', '<w:outlineLvl w:val="0"/>'),
    p('2.1 子节', '<w:outlineLvl w:val="1"/>'),
    p('单位名称：____'),
    table,
    p('第三章 结束', '<w:outlineLvl w:val="0"/>'),
    p('尾段：____'),
  ].join('');
  const bytes = await packageOf(body);

  // 1. blocks with `to: "t:0"` includes t:0 and all descendants (rows, cells, nested table, paragraphs) and excludes p:5/p:6
  const slice = await readDocument(bytes, { mode: 'blocks', from: 'p:4', to: 't:0' } as ReadDocumentOptions);
  const addresses = slice.items.map(item => item.address);
  assert.equal(addresses[0], 'p:4');
  assert.ok(addresses.includes('t:0'));
  assert.ok(addresses.includes('t:0/r:1/c:0/t:0/r:0/c:0/p:0'));
  assert.ok(!addresses.includes('p:5'));
  assert.ok(!addresses.includes('p:6'));

  // 2. outline with `from` and `to`
  const outSlice = await readDocument(bytes, { mode: 'outline', from: 'p:2', to: 'p:3' } as ReadDocumentOptions);
  assert.deepEqual(outSlice.items.map(item => item.address), ['p:2', 'p:3']);

  // 3. onlyHints filters to blocks with hints > 0 within [from, to], keeping empty cells `⟦0:⟧`
  const hintsOnly = await readDocument(bytes, { mode: 'blocks', from: 'p:0', to: 't:0', onlyHints: true } as ReadDocumentOptions & { onlyHints: boolean });
  assert.deepEqual(
    hintsOnly.items.map(item => [item.address, item.text]),
    [
      ['p:4', '单位名称：⟦0:____⟧'],
      ['t:0/r:0/c:1', '⟦0:⟧'],
      ['t:0/r:1/c:0/p:0', '嵌套前：⟦0:____⟧'],
    ],
  );

  // 4. cursor fingerprint binds `to` and `onlyHints`
  const paged = await readDocument(bytes, { mode: 'blocks', from: 'p:0', to: 'p:6', onlyHints: true, limit: 1 } as ReadDocumentOptions);
  assert.ok(paged.next);
  const continued = await readDocument(bytes, paged.next!);
  assert.equal(continued.items[0].address, 't:0/r:0/c:1');
  await assert.rejects(readDocument(bytes, { ...paged.next!, to: 't:0' } as ReadDocumentOptions), /续读/);
  await assert.rejects(readDocument(bytes, { ...paged.next!, onlyHints: false } as ReadDocumentOptions), /续读/);

  // 5. negative controls: missing `to`, `to` before `from`, `to` in search, `onlyHints` in outline/search
  await assert.rejects(readDocument(bytes, { mode: 'blocks', to: 'p:999' } as ReadDocumentOptions), /结束地址/);
  await assert.rejects(readDocument(bytes, { mode: 'blocks', from: 'p:4', to: 'p:1' } as ReadDocumentOptions), /之前/);
  await assert.rejects(readDocument(bytes, { mode: 'outline', from: 'p:3', to: 'p:0' } as ReadDocumentOptions), /之前/);
  await assert.rejects(readDocument(bytes, { mode: 'search', query: '章', to: 'p:2' } as ReadDocumentOptions), /blocks.*outline|不支持/);
  await assert.rejects(readDocument(bytes, { mode: 'outline', onlyHints: true } as ReadDocumentOptions), /blocks/);
  const noHintsInSlice = await readDocument(bytes, { mode: 'blocks', from: 'p:0', to: 'p:1', onlyHints: true });
  assert.equal(noHintsInSlice.items.length, 0);
  assert.equal(noHintsInSlice.truncated, false);
});

test('runProject read uses lightweight pending marks, preserves baseline warnings and accepts object/string cursor', async t => {
  const sandbox = await createSandbox(t, 'm37-read-');
  const host = new NodeHostPort();
  const source = path.join(sandbox, 'tender.docx');
  const root = path.join(sandbox, 'project');
  const body = [
    p('固定原文段落'),
    p('报价：____'),
    p('交期：____'),
  ].join('');
  await fs.writeFile(source, await packageOf(body));
  await runProject(host, ['init', '--root', root, '--name', '轻读测试', '--deadline', '2028-12-31', '--tender', source]);
  await runProject(host, ['extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:2' }])]);
  await runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
    { op: 'replace', at: 'p:1', find: '____', value: '100万元' },
  ])]);

  // Read with limit=1 and continue with JSON string cursor
  const first = (await runProject(host, ['read', '--project', root, '--file', 'bid', '--mode', 'blocks', '--limit', '1'])) as any;
  assert.ok(first.next);
  const second = (await runProject(host, [
    'read', '--project', root, '--file', 'bid', '--mode', 'blocks', '--limit', '1',
    '--cursor', JSON.stringify(first.next.cursor),
  ])) as any;
  assert.equal(second.items[0].address, 'p:1');
  assert.match(second.items[0].text, /«待定:报价»100万元«\/待定»/);

  // Tamper baseline -> warning still reported without needing full checkDraft diff
  const basePath = path.join(root, 'draft', 'bid.base.docx');
  const savedBaseBytes = await fs.readFile(basePath);
  await fs.writeFile(basePath, await fs.readFile(path.join(root, 'draft', 'bid.docx')));
  const warned = (await runProject(host, ['read', '--project', root, '--file', 'bid', '--mode', 'blocks'])) as any;
  assert.ok(warned.warnings.some((w: string) => w.includes('基准')));
  await fs.writeFile(basePath, savedBaseBytes);
});

test('editBidDraft dismiss_hints supports targets and range, writes per-hint dismissals for C03, and runProject strips originalHighlights and enriches diagnostics', async t => {
  const sandbox = await createSandbox(t, 'm37-edit-');
  const host = new NodeHostPort();
  const source = path.join(sandbox, 'tender.docx');
  const root = path.join(sandbox, 'project');
  const body = [
    p('姓名：____ 电话：____'),
    `<w:tbl><w:tr><w:tc>${p('单元格：____')}</w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>`,
    p('备注：（请填写） 编号：____'),
  ].join('');
  await fs.writeFile(source, await packageOf(body));
  await runProject(host, ['init', '--root', root, '--name', '批量跳过测试', '--deadline', '2028-12-31', '--tender', source]);
  await runProject(host, ['extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:1' }])]);

  // 1. originalHighlights stripped from edit result, retained in ledger.json
  const editRes = (await runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
    { op: 'replace', at: 'p:0', blank: 0, value: '张三', pending: { category: '其他', note: '核对人名' } },
  ])])) as any;
  assert.ok(editRes.pending.length > 0);
  for (const item of editRes.pending) {
    assert.equal(Object.hasOwn(item, 'originalHighlights'), false);
  }
  const ledgerAfterEdit = JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'));
  assert.ok(Array.isArray(ledgerAfterEdit.pending[0].originalHighlights));
  assert.ok(ledgerAfterEdit.pending[0].originalHighlights.length > 0);

  // 2. dismiss_hints via targets (partial blanks + omitted blanks)
  await runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
    {
      op: 'dismiss_hints',
      targets: [
        { at: 'p:0', blanks: [0] }, // now blank 0 is 电话：____ after 姓名：____ was replaced
        { at: 't:0/r:0/c:1' }, // empty cell
      ],
      reason: '此批无需填写',
    },
  ])]);
  const checkAfterTargets = (await runProject(host, ['check', '--project', root, '--draft', 'bid'])) as any;
  assert.ok(!checkAfterTargets.results.C02.some((h: any) => h.address === 'p:0' || h.address === 't:0/r:0/c:1'));
  assert.equal(checkAfterTargets.results.C03.filter((h: any) => h.address === 'p:0' || h.address === 't:0/r:0/c:1').length, 2);

  // 3. dismiss_hints via range [from, to] covering table cell & trailing paragraph
  await runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
    { op: 'dismiss_hints', from: 't:0', to: 'p:1', reason: '整区不适用' },
  ])]);
  const checkAfterRange = (await runProject(host, ['check', '--project', root, '--draft', 'bid'])) as any;
  assert.equal(checkAfterRange.results.C02.length, 0);
  assert.equal(checkAfterRange.results.C03.length, 5);

  // Verify C03 compatibility with human review acknowledgement
  const key = await host.authorizationKey(true);
  assert.ok(key);
  const draftXml = new TextDecoder().decode((await (await import('../src/core/docx/package-structure.js')).validatePackageStructure(
    await fs.readFile(path.join(root, 'draft', 'bid.docx')),
  )).get('word/document.xml')!);
  const ledgerNow = JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'));
  const hintsNow = currentHints(draftXml, 'bid');
  assert.equal(hintsNow.length, 5);
  for (const h of hintsNow) {
    await reviewHint(ledgerNow, 'bid', h.id, draftXml, { root, vaultId: null, deadline: '2028-12-31' }, key);
  }
  assert.equal(ledgerNow.dismissals.every((d: any) => !!d.authorization), true);

  // 4. Negative controls for dismiss_hints: already dismissed, nonexistent target/blank, reversed range, no unhandled hints in range, forbidden fields
  for (const badOp of [
    { op: 'dismiss_hints', targets: [{ at: 'p:0' }], reason: '重复' },
    { op: 'dismiss_hints', targets: [{ at: 'p:99' }], reason: '不存在' },
    { op: 'dismiss_hints', targets: [{ at: 'p:1', blanks: [9] }], reason: '序号不存在' },
    { op: 'dismiss_hints', from: 'p:1', to: 'p:0', reason: '反序' },
    { op: 'dismiss_hints', from: 'p:0', to: 'p:1', reason: '已无未处理' },
    { op: 'dismiss_hints', from: 'p:0', to: 'p:1', reason: '越权', actor: 'human' },
  ]) {
    await assert.rejects(
      runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([badOp])]),
    );
  }

  // 5. Failure diagnostics include index, at, and currentBlock (with text + hints)
  await assert.rejects(
    runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
      { op: 'replace', at: 'p:0', find: '张三', value: '李四' },
      { op: 'replace', at: 'p:1', find: '绝对找不到', value: '新值' },
    ])]),
    (error: any) => {
      const payload = JSON.parse(error.message);
      assert.equal(payload.committed, false);
      assert.equal(payload.results[0].status, 'rolled_back');
      assert.equal(payload.results[0].index, 0);
      assert.equal(payload.results[1].status, 'rejected');
      assert.equal(payload.results[1].index, 1);
      assert.equal(payload.results[1].at, 'p:1');
      assert.equal(payload.results[1].currentBlock?.address, 'p:1');
      assert.match(payload.results[1].currentBlock?.text, /备注：/);
      assert.ok(Array.isArray(payload.results[1].currentBlock?.hints));
      assert.equal(payload.results[1].currentBlock.hints.length, 2);
      return true;
    },
  );
  // Batch conflict (both individually valid, conflicting together) reports rolled_back with index/at
  await assert.rejects(
    runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
      { op: 'replace', at: 'p:0', find: '张三', value: '甲' },
      { op: 'replace', at: 'p:0', find: '姓名：张三', value: '乙' },
    ])]),
    (error: any) => {
      const payload = JSON.parse(error.message);
      assert.equal(payload.committed, false);
      assert.deepEqual(payload.results.map((r: any) => [r.index, r.at, r.status]), [[0, 'p:0', 'rolled_back'], [1, 'p:0', 'rolled_back']]);
      assert.ok(payload.results.every((r: any) => r.suggestion.includes('冲突')));
      return true;
    },
  );
  // Single failing op diagnostic
  await assert.rejects(
    runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
      { op: 'replace', at: 'p:999', find: 'x', value: 'y' },
    ])]),
    (error: any) => {
      const payload = JSON.parse(error.message);
      assert.equal(payload.results[0].status, 'rejected');
      assert.equal(payload.results[0].index, 0);
      assert.equal(payload.results[0].at, 'p:999');
      assert.equal(payload.results[0].currentBlock, undefined);
      return true;
    },
  );
  // Core editBidDraft remains directly testable
  assert.equal(typeof editBidDraft, 'function');
});

test('seal_requirements patch updates responses/evidence atomically and rejects unauthorized or missing IDs', async t => {
  const sandbox = await createSandbox(t, 'm37-req-patch-');
  const host = new NodeHostPort();
  const source = path.join(sandbox, 'tender.docx');
  const root = path.join(sandbox, 'project');
  await fs.writeFile(source, await packageOf(p('资格要求：须具备营业执照') + p('评分项：技术方案10分')));
  await runProject(host, ['init', '--root', root, '--name', '要求增量测试', '--deadline', '2028-12-31', '--tender', source]);

  // Reject patch before requirements.json exists
  await assert.rejects(
    runProject(host, ['requirements', '--project', root, '--action', 'patch', '--items', JSON.stringify([{ id: 'r1', responses: [{ draft: 'bid', address: 'p:0' }] }])]),
    /尚不存在|save/,
  );

  const initialItems: Requirement[] = [
    {
      id: 'r1',
      kind: '资格要求',
      text: '提供营业执照',
      quote: '须具备营业执照',
      source: { file: 'tender/1.docx', address: 'p:0' },
      mustRespond: true,
      responses: [],
    },
    {
      id: 'r2',
      kind: '评分项',
      text: '技术方案完整',
      quote: '技术方案10分',
      source: { file: 'tender/1.docx', address: 'p:1' },
      mustRespond: false,
      points: 10,
      responses: [],
    },
  ];
  await runProject(host, ['requirements', '--project', root, '--action', 'save', '--items', JSON.stringify(initialItems)]);

  const patched = (await runProject(host, [
    'requirements', '--project', root, '--action', 'patch',
    '--items', JSON.stringify([
      { id: 'r1', responses: [{ draft: 'bid', address: 'p:0' }], evidence: ['kb-1'] },
    ]),
  ])) as any;
  assert.equal(patched.patched, true);
  assert.equal(patched.updatedCount, 1);
  assert.equal(patched.total, 2);
  assert.equal(patched.mustRespondCount, 1);

  const after = parseRequirements(await fs.readFile(path.join(root, 'requirements.json'), 'utf8'));
  assert.equal(after.kind, 'value');
  if (after.kind === 'value') {
    assert.deepEqual(after.items.map(i => i.id), ['r1', 'r2']);
    assert.deepEqual(after.items[0].responses, [{ draft: 'bid', address: 'p:0' }]);
    assert.deepEqual(after.items[0].evidence, ['kb-1']);
    assert.deepEqual(after.items[1], initialItems[1]);
  }

  const reqBefore = await fs.readFile(path.join(root, 'requirements.json'), 'utf8');
  await assert.rejects(
    runProject(host, ['requirements', '--project', root, '--action', 'patch', '--items', JSON.stringify([
      { id: 'r1', responses: [{ draft: 'bid', address: 'p:0' }], covered: true },
    ])]),
    /禁止设置人工覆盖或核实字段/,
  );
  for (const badPatch of [
    [{ id: 'nonexistent', responses: [] }],
    [{ id: 'r1', responses: [] }, { id: 'r1', evidence: ['kb-2'] }],
    [{ id: 'r1', text: '偷改概括', responses: [] }],
    [{ id: 'r1', quote: '偷改引文', responses: [] }],
    [{ id: 'r1' }],
  ]) {
    await assert.rejects(
      runProject(host, ['requirements', '--project', root, '--action', 'patch', '--items', JSON.stringify(badPatch)]),
    );
    assert.equal(await fs.readFile(path.join(root, 'requirements.json'), 'utf8'), reqBefore);
  }
  assert.equal(typeof patchRequirements, 'function');
});

test('seal_kb_save dismiss_candidates and dismissCandidateIds are atomic and reject privileged fields', async t => {
  const sandbox = await createSandbox(t, 'm37-kb-dismiss-');
  const host = new NodeHostPort();
  const kb = new KnowledgeBase(host, path.join(sandbox, 'seal-home', 'vaults'));
  const vaultId = `v-${randomUUID().slice(0, 8)}`;
  await kb.createVault({ vaultId, name: '批量候选柜' });
  const batchDir = path.join(kb.vaultRoot(vaultId), 'inbox', 'batch-1');
  await fs.mkdir(batchDir, { recursive: true });
  for (const cid of ['candidate-1', 'candidate-2', 'candidate-3']) {
    await fs.writeFile(path.join(batchDir, `${cid}.md`), serializeEntry({ title: cid, source: 'a.docx', processed: false }, `内容 ${cid}`));
  }

  // 1. Atomic rollback if one candidate does not exist or privileged field is passed
  await assert.rejects(
    runKnowledgeBase(host, ['save', '--vault', vaultId, '--data', JSON.stringify({
      action: 'dismiss_candidates',
      kind: 'material',
      ids: ['candidate-1', 'candidate-missing'],
    })]),
    /不存在/,
  );
  assert.equal((await kb.getCandidate(vaultId, 'candidate-1')).fields.processed, false);

  await assert.rejects(
    runKnowledgeBase(host, ['save', '--vault', vaultId, '--data', JSON.stringify({
      action: 'dismiss_candidates',
      kind: 'material',
      ids: ['candidate-1'],
      fields: { verified: true },
    })]),
    /核实/,
  );
  assert.equal((await kb.getCandidate(vaultId, 'candidate-1')).fields.processed, false);

  // 2. create with dismissCandidateIds rejects atomically when candidate is missing (no record created)
  const recordFilesBefore = await fs.readdir(path.join(kb.vaultRoot(vaultId), 'records'));
  await assert.rejects(
    runKnowledgeBase(host, ['save', '--vault', vaultId, '--data', JSON.stringify({
      action: 'create',
      kind: 'record',
      fields: { type: '其他', title: '应回滚记录' },
      body: '内容',
      dismissCandidateIds: ['candidate-1', 'candidate-nonexistent'],
    })]),
    /不存在/,
  );
  assert.deepEqual(await fs.readdir(path.join(kb.vaultRoot(vaultId), 'records')), recordFilesBefore);
  assert.equal((await kb.getCandidate(vaultId, 'candidate-1')).fields.processed, false);

  // 3. create with dismissCandidateIds saves record and marks candidates processed atomically
  const created = (await runKnowledgeBase(host, ['save', '--vault', vaultId, '--data', JSON.stringify({
    action: 'create',
    kind: 'record',
    fields: { type: '其他', title: '证照一' },
    body: '内容',
    dismissCandidateIds: ['candidate-1'],
  })])) as any;
  assert.match(created.id, /^kb-/);
  assert.equal((await kb.getCandidate(vaultId, 'candidate-1')).fields.processed, true);

  // 3. dismiss_candidates marks remaining candidates atomically and appends logs
  const batchDismissed = (await runKnowledgeBase(host, ['save', '--vault', vaultId, '--data', JSON.stringify({
    action: 'dismiss_candidates',
    ids: ['candidate-2', 'candidate-3'],
  })])) as any;
  assert.equal(batchDismissed.dismissedCount, 2);
  assert.deepEqual(batchDismissed.dismissedIds, ['candidate-2', 'candidate-3']);
  assert.equal((await kb.listPendingBatches(vaultId)).length, 0);

  const logLines = (await fs.readFile(path.join(kb.vaultRoot(vaultId), 'log.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(logLines.filter(e => e.action === 'dismiss_candidate').length, 3);
});

test('seal-bid and seal-kb skills document new batch and incremental capabilities clearly', () => {
  assert.ok(SEAL_BID_SKILL.description.length <= 500);
  assert.ok(SEAL_KB_SKILL.description.length <= 500);
  assert.match(SEAL_BID_SKILL.content, /onlyHints/);
  assert.match(SEAL_BID_SKILL.content, /dismiss_hints/);
  assert.match(SEAL_BID_SKILL.content, /action="patch"|action=patch/);
  assert.match(SEAL_BID_SKILL.content, /kb:<recordId>\/<relPath>|kb:<id>\/<文件>/);
  assert.match(SEAL_BID_SKILL.content, /未核实或效期未知.*挂载/);
  assert.match(SEAL_KB_SKILL.content, /dismiss_candidates/);
  assert.match(SEAL_KB_SKILL.content, /dismissCandidateIds/);
  assert.match(SEAL_KB_SKILL.content, /files\/<batchId>/);
  assert.match(SEAL_KB_SKILL.content, /Word 母本.*source-N/);
  assert.match(SEAL_KB_SKILL.content, /新版营业执照.*长期/);
  assert.match(SEAL_KB_SKILL.content, /以最新有效证照原图为准/);
});

test('KnowledgeBase batch candidate ops fail closed without HostPort.writeFiles and stay atomic on writeFiles failure', async t => {
  const sandbox = await createSandbox(t, 'm37-kb-atomic-');
  const nodeHost = new NodeHostPort();
  const vaultsRoot = path.join(sandbox, 'seal-home', 'vaults');
  const setupKb = new KnowledgeBase(nodeHost, vaultsRoot);
  const vaultId = `v-${randomUUID().slice(0, 8)}`;
  await setupKb.createVault({ vaultId, name: '原子性回归库' });
  const batchDir = path.join(setupKb.vaultRoot(vaultId), 'inbox', 'batch-1');
  await fs.mkdir(batchDir, { recursive: true });
  for (const cid of ['candidate-1', 'candidate-2']) {
    await fs.writeFile(path.join(batchDir, `${cid}.md`), serializeEntry({ title: cid, source: 'a.docx', processed: false }, `内容 ${cid}`));
  }

  const logPath = path.join(setupKb.vaultRoot(vaultId), 'log.jsonl');
  const logBefore = await fs.readFile(logPath, 'utf8');
  const candidate1Before = await fs.readFile(path.join(batchDir, 'candidate-1.md'), 'utf8');
  const candidate2Before = await fs.readFile(path.join(batchDir, 'candidate-2.md'), 'utf8');

  // 1. HostPort without writeFiles must reject batch candidate operations before any writes
  const noAtomicHost: HostPort = {
    readBytes: p => nodeHost.readBytes(p),
    writeBytes: (p, d) => nodeHost.writeBytes(p, d),
    readText: p => nodeHost.readText(p),
    writeText: (p, c) => nodeHost.writeText(p, c),
    stat: p => nodeHost.stat(p),
    makeDirectory: p => nodeHost.makeDirectory(p),
    listFiles: p => nodeHost.listFiles(p),
    joinPath: (...s) => nodeHost.joinPath(...s),
    dirname: p => nodeHost.dirname(p),
  };
  const noAtomicKb = new KnowledgeBase(noAtomicHost, vaultsRoot);

  await assert.rejects(
    noAtomicKb.save(vaultId, { action: 'dismiss_candidates', kind: 'material', ids: ['candidate-1', 'candidate-2'] }),
    /writeFiles|原子/,
  );
  await assert.rejects(
    noAtomicKb.save(vaultId, {
      action: 'create',
      kind: 'record',
      fields: { type: '其他', title: '应被拒绝' },
      body: '正文',
      dismissCandidateIds: ['candidate-1'],
    }),
    /writeFiles|原子/,
  );
  assert.equal(await fs.readFile(path.join(batchDir, 'candidate-1.md'), 'utf8'), candidate1Before);
  assert.equal(await fs.readFile(path.join(batchDir, 'candidate-2.md'), 'utf8'), candidate2Before);
  assert.equal(await fs.readFile(logPath, 'utf8'), logBefore);
  assert.deepEqual(await fs.readdir(path.join(setupKb.vaultRoot(vaultId), 'records')), []);

  // 2. HostPort with failing atomic writeFiles rolls back entire batch (zero partial commits)
  const failingAtomicHost: HostPort = {
    ...noAtomicHost,
    writeFiles: async () => {
      throw new Error('simulated atomic write failure');
    },
  };
  const failingAtomicKb = new KnowledgeBase(failingAtomicHost, vaultsRoot);

  await assert.rejects(
    failingAtomicKb.save(vaultId, { action: 'dismiss_candidates', kind: 'material', ids: ['candidate-1', 'candidate-2'] }),
    /simulated atomic write failure/,
  );
  await assert.rejects(
    failingAtomicKb.save(vaultId, {
      action: 'create',
      kind: 'record',
      fields: { type: '其他', title: '应全部回滚' },
      body: '正文',
      dismissCandidateIds: ['candidate-1'],
    }),
    /simulated atomic write failure/,
  );
  assert.equal(await fs.readFile(path.join(batchDir, 'candidate-1.md'), 'utf8'), candidate1Before);
  assert.equal(await fs.readFile(path.join(batchDir, 'candidate-2.md'), 'utf8'), candidate2Before);
  assert.equal(await fs.readFile(logPath, 'utf8'), logBefore);
  assert.deepEqual(await fs.readdir(path.join(setupKb.vaultRoot(vaultId), 'records')), []);
});

test('runProject edit diagnoses out-of-bounds image paths and missing fact references with structured JSON', async t => {
  const sandbox = await createSandbox(t, 'm37-resolve-diag-');
  const host = new NodeHostPort();
  const source = path.join(sandbox, 'tender.docx');
  const root = path.join(sandbox, 'project');
  const kb = new KnowledgeBase(host, path.join(sandbox, 'seal-home', 'vaults'));
  const vaultId = `v-${randomUUID().slice(0, 8)}`;
  await kb.createVault({ vaultId, name: '诊断测试库' });
  await kb.save(vaultId, { action: 'update', kind: 'subject', fields: { legalName: '星河演示公司' } });

  await fs.writeFile(source, await packageOf(p('请填写名称：____') + p('请贴图：____')));
  await runProject(host, ['init', '--root', root, '--name', '解析诊断测试', '--deadline', '2028-12-31', '--tender', source, '--vault', vaultId]);
  await runProject(host, ['extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:1' }])]);

  const draftPath = path.join(root, 'draft', 'bid.docx');
  const draftBefore = await fs.readFile(draftPath);

  // 1. Single-op out-of-bounds image path returns unified diagnostic JSON
  await assert.rejects(
    runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
      { op: 'insert_image', at: 'p:1', image: '/outside.png' },
    ])]),
    (error: any) => {
      const payload = JSON.parse(error.message);
      assert.equal(payload.committed, false);
      assert.match(payload.reason, /项目内路径/);
      assert.equal(payload.results.length, 1);
      assert.equal(payload.results[0].index, 0);
      assert.equal(payload.results[0].op, 'insert_image');
      assert.equal(payload.results[0].at, 'p:1');
      assert.equal(payload.results[0].status, 'rejected');
      assert.equal(payload.results[0].currentBlock?.address, 'p:1');
      assert.equal(payload.results[0].currentBlock?.text, '请贴图：____');
      return true;
    },
  );
  assert.deepEqual(await fs.readFile(draftPath), draftBefore);

  // 2. Single-op invalid fact reference returns unified diagnostic JSON
  await assert.rejects(
    runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
      { op: 'replace', at: 'p:0', blank: 0, value: '{{subject.nonexistent}}' },
    ])]),
    (error: any) => {
      const payload = JSON.parse(error.message);
      assert.equal(payload.committed, false);
      assert.match(payload.reason, /nonexistent/);
      assert.equal(payload.results.length, 1);
      assert.equal(payload.results[0].index, 0);
      assert.equal(payload.results[0].op, 'replace');
      assert.equal(payload.results[0].at, 'p:0');
      assert.equal(payload.results[0].status, 'rejected');
      assert.equal(payload.results[0].currentBlock?.address, 'p:0');
      assert.equal(payload.results[0].currentBlock?.hints.length, 1);
      return true;
    },
  );
  assert.deepEqual(await fs.readFile(draftPath), draftBefore);

  // 3. Multi-op batch with valid op + multiple failing resolution ops reports every failure accurately
  await assert.rejects(
    runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
      { op: 'replace', at: 'p:0', blank: 0, value: '手工名称' },
      { op: 'insert_image', at: 'p:1', image: '/outside.png' },
      { op: 'replace', at: 'p:0', blank: 0, value: '{{subject.nonexistent}}' },
    ])]),
    (error: any) => {
      const payload = JSON.parse(error.message);
      assert.equal(payload.committed, false);
      assert.equal(payload.results.length, 3);
      assert.equal(payload.results[0].index, 0);
      assert.equal(payload.results[0].status, 'rolled_back');
      assert.equal(payload.results[1].index, 1);
      assert.equal(payload.results[1].op, 'insert_image');
      assert.equal(payload.results[1].at, 'p:1');
      assert.equal(payload.results[1].status, 'rejected');
      assert.equal(payload.results[1].currentBlock?.address, 'p:1');
      assert.equal(payload.results[2].index, 2);
      assert.equal(payload.results[2].op, 'replace');
      assert.equal(payload.results[2].at, 'p:0');
      assert.equal(payload.results[2].status, 'rejected');
      assert.equal(payload.results[2].currentBlock?.address, 'p:0');
      return true;
    },
  );
  assert.deepEqual(await fs.readFile(draftPath), draftBefore);
});

test('FactFill removal on overwrite/delete unblocks C05 & finalization while external bookmark tampering remains blocked', async t => {
  const sandbox = await createSandbox(t, 'm37-c05-fill-removal-');
  const host = new NodeHostPort();
  const vaultsRoot = path.join(sandbox, 'seal-home', 'vaults');
  const kb = new KnowledgeBase(host, vaultsRoot);
  const vaultId = `v-${randomUUID().slice(0, 8)}`;
  await kb.createVault({ vaultId, name: 'C05 回归库' });
  await kb.save(vaultId, {
    action: 'update',
    kind: 'subject',
    fields: { legalName: '星河演示公司', address: '上海市测试路1号' },
  });
  await kb.verify(vaultId, 'subject', 'subject', ['legalName']);
  const expiredRecord = await kb.save(vaultId, {
    action: 'create',
    kind: 'record',
    fields: { type: '其他', title: '证照标题', holder: '星河演示公司', validUntil: '2029-12-31' },
    body: '有效期内证明',
  });
  await kb.verify(vaultId, 'record', expiredRecord.id);

  const source = path.join(sandbox, 'tender.docx');
  await fs.writeFile(source, await packageOf(p('供应商：____') + p('地址：____') + p('证照：____')));
  const root = path.join(sandbox, 'project');
  await runProject(host, ['init', '--root', root, '--name', 'C05定稿死锁回归', '--deadline', '2028-12-31', '--tender', source, '--vault', vaultId]);
  await runProject(host, ['extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:2' }])]);

  // Write verified _Seal_F_ (p:0), unverified _Seal_P_ (p:1), and record _Seal_F_ (p:2)
  await runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
    { op: 'replace', at: 'p:0', blank: 0, value: '{{subject.legalName}}' },
    { op: 'replace', at: 'p:1', blank: 0, value: '{{subject.address}}' },
    { op: 'replace', at: 'p:2', blank: 0, value: `{{record:${expiredRecord.id}.title}}` },
  ])]);

  // Expire the record afterwards (simulating passage of deadline or updated expiry)
  await kb.save(vaultId, {
    action: 'update',
    kind: 'record',
    id: expiredRecord.id,
    fields: { validUntil: '2020-01-01' },
  });
  await kb.verify(vaultId, 'record', expiredRecord.id);

  const readLedger = async () => JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'));
  const beforeLedger = await readLedger();
  assert.equal(beforeLedger.fills.length, 3);
  const checkWithExpired = (await runProject(host, ['check', '--project', root, '--draft', 'bid'])) as any;
  assert.ok(checkWithExpired.results.C08.length > 0);

  // (a) & (d): Overwrite p:0/p:1 with full paragraph replacement and delete p:2 -> old fills become removed, C05=0, C08=0, finalization succeeds
  await runProject(host, ['edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([
    { op: 'replace', at: 'p:0', find: '供应商：星河演示公司', value: '供应商重写：{{subject.legalName}}' },
    { op: 'replace', at: 'p:1', find: '地址：上海市测试路1号', value: '地址重写：不填引用' },
    { op: 'delete', at: 'p:2' },
  ])]);

  const afterOverwriteLedger = await readLedger();
  const removedFills = afterOverwriteLedger.fills.filter((f: any) => f.status === 'removed');
  assert.equal(removedFills.length, 3);
  const checkAfterOverwrite = (await runProject(host, ['check', '--project', root, '--draft', 'bid'])) as any;
  assert.equal(checkAfterOverwrite.results.C05.some((i: any) => typeof i.reason === 'string'), false);
  assert.equal(checkAfterOverwrite.results.C08.length, 0);

  // Confirm remaining open pending items and verify C05 clears to 0 and finalization succeeds
  const key = (await host.authorizationKey(true))!;
  const projectMeta = await readProject(host, root);
  const draftBytes = await fs.readFile(path.join(root, 'draft', 'bid.docx'));
  const baseBytes = await fs.readFile(path.join(root, 'draft', 'bid.base.docx'));
  const anchorValue = JSON.parse(await fs.readFile(await host.ledgerAnchorPath(root, false), 'utf8'));
  const xmlForReview = new TextDecoder().decode((await validatePackageStructure(draftBytes)).get('word/document.xml')!);
  const liveLedger = await readLedger();
  for (const item of liveLedger.pending.filter((pItem: any) => pItem.draft === 'bid' && pItem.status === 'open')) {
    await confirmPending(liveLedger, 'bid', item.id, xmlForReview, { root, vaultId, deadline: '2028-12-31' }, key);
  }
  await sealLedger(liveLedger, root, key);
  await fs.writeFile(path.join(root, 'ledger.json'), JSON.stringify(liveLedger, null, 2));
  await fs.writeFile(await host.ledgerAnchorPath(root, false), JSON.stringify(liveLedger.integrity));
  const checkAfterConfirm = (await runProject(host, ['check', '--project', root, '--draft', 'bid'])) as any;
  assert.equal(checkAfterConfirm.results.C05.length, 0);
  const finalized = await finalizeDraftMarkers(host, {
    name: 'bid',
    root,
    draft: draftBytes,
    base: baseBytes,
    ledger: liveLedger,
    anchor: liveLedger.integrity,
    project: projectMeta,
    secret: key,
  });
  assert.ok(finalized.length > 0);
  assert.ok(anchorValue);

  // (b) & (c): External tampering removes _Seal_F_ / _Seal_P_ bookmark -> C05 blocks even after an unrelated Seal edit!
  const rootTamper = path.join(sandbox, 'project-tamper');
  await runProject(host, ['init', '--root', rootTamper, '--name', '外部删书签防洗白', '--deadline', '2028-12-31', '--tender', source, '--vault', vaultId]);
  await runProject(host, ['extract', '--project', rootTamper, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:2' }])]);
  await runProject(host, ['edit', '--project', rootTamper, '--draft', 'bid', '--ops', JSON.stringify([
    { op: 'replace', at: 'p:0', blank: 0, value: '{{subject.legalName}}' },
    { op: 'replace', at: 'p:1', blank: 0, value: '{{subject.address}}' },
  ])]);

  // Externally strip bookmark tags from p:0 & p:1 inside bid.docx
  const tamperDraftPath = path.join(rootTamper, 'draft', 'bid.docx');
  const tamperZip = await readZip(await fs.readFile(tamperDraftPath));
  const origDocXml = new TextDecoder().decode(tamperZip.get('word/document.xml')!);
  const strippedXml = origDocXml
    .replace(/<w:bookmarkStart[^/]*\/>/g, '')
    .replace(/<w:bookmarkEnd[^/]*\/>/g, '');
  tamperZip.set('word/document.xml', enc.encode(strippedXml));
  await fs.writeFile(tamperDraftPath, await writeZip(tamperZip));

  // (b) Direct check reports 事实引用范围缺失 for both external deletions
  const checkTampered = (await runProject(host, ['check', '--project', rootTamper, '--draft', 'bid'])) as any;
  assert.equal(checkTampered.results.C05.filter((i: any) => i.reason === '事实引用范围缺失').length, 2);

  // (c) Perform an unrelated edit on p:2 -> beforeNames has neither marker, so neither fill may be washed to removed
  await runProject(host, ['edit', '--project', rootTamper, '--draft', 'bid', '--ops', JSON.stringify([
    { op: 'replace', at: 'p:2', blank: 0, value: '无关编辑' },
  ])]);
  const tamperLedger = JSON.parse(await fs.readFile(path.join(rootTamper, 'ledger.json'), 'utf8'));
  assert.equal(tamperLedger.fills.filter((f: any) => f.status === 'removed').length, 0);
  const checkAfterUnrelated = (await runProject(host, ['check', '--project', rootTamper, '--draft', 'bid'])) as any;
  assert.equal(checkAfterUnrelated.results.C05.filter((i: any) => i.reason === '事实引用范围缺失').length, 2);

  // (e) Invalid fill.status value fails closed in checkDraft
  const hackedLedger = JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'));
  hackedLedger.fills[0].status = 'hacked';
  await sealLedger(hackedLedger, root, key);
  const hackedCheck = (await checkDraft(host, {
    name: 'bid',
    root,
    draft: draftBytes,
    base: baseBytes,
    ledger: hackedLedger,
    anchor: hackedLedger.integrity,
    project: projectMeta,
    secret: key,
  })) as any;
  assert.ok(hackedCheck.results.C05.some((i: any) => i.reason === '事实引用记录无效'));
  assert.ok(sha256Hex(draftBytes));
});
