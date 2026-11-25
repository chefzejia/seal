import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HostPort } from '../src/core/host.js';
import { pendingReasons } from '../src/core/bid/policy.js';
import { editBidDraft } from '../src/core/bid/edit.js';
import { checkDraft } from '../src/core/bid/check.js';
import { confirmPending } from '../src/core/bid/human-review.js';
import { finalizeDraftMarkers } from '../src/core/bid/finalize.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import type { BidLedger, ProjectMetadata } from '../src/core/bid/project.js';
import type { FactResolution } from '../src/core/bid/facts.js';
import {
  extractFirstParagraphPr,
  parseDocumentBody,
  readZip,
  sanitizeInsertedBodyParagraphPr,
  sha256Hex,
  writeZip,
} from '../src/core/docx/index.js';
import { applyTextBatch } from '../src/core/docx/text-batch.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';
import { editableText, visibleRunProperties } from '../src/core/docx/visible-surgery.js';
import { SEAL_BID_SKILL } from '../src/shells/dsh/seal-bid-skill.js';
import { KnowledgeBase } from '../src/core/kb/index.js';
import { NodeHostPort } from '../src/shells/node-host.js';
import { runProject } from '../src/shells/cli/project-v2.js';

const enc = (text: string) => new TextEncoder().encode(text);
const xmlOf = async (bytes: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true }).decode((await readZip(bytes)).get('word/document.xml')!);

const makeDoc = (body: string, styles = '') =>
  writeZip(
    new Map([
      [
        '[Content_Types].xml',
        enc(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
        ),
      ],
      [
        'word/styles.xml',
        enc(
          styles ||
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>',
        ),
      ],
      [
        'word/document.xml',
        enc(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
        ),
      ],
    ]),
  );

const makeLedger = (base: Uint8Array): BidLedger => ({
  format: 'seal-ledger-1',
  fills: [],
  pending: [],
  dismissals: [],
  acceptedChanges: [],
  requirements: [],
  drafts: { bid: sha256Hex(base) },
  bases: { bid: sha256Hex(base) },
});

const p = (text: string, pPr = '') => `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const tr = (...cells: string[]) => `<w:tr>${cells.map(cell => `<w:tc>${cell}</w:tc>`).join('')}</w:tr>`;
const tbl = (...rows: string[]) => `<w:tbl><w:tblPr/>${rows.join('')}</w:tbl>`;

test('M38 policy: narrows automatic keywords and requires explicit unverifiedFact', () => {
  for (const [text, expected] of [
    ['投标报价', '报价'],
    ['单价与合价', '报价'],
    ['税率优惠保证金', '报价'],
    ['交货时间与交付时间', '工期交期'],
    ['工期要求', '工期交期'],
    ['质保维保保修期', '质保'],
  ] as const) {
    assert.ok(pendingReasons({ context: text }).some(r => r.category === expected), text);
  }
  assert.deepEqual(pendingReasons({ context: '偏离说明 技术承诺 响应时间 联系人 地址' }), []);
  assert.deepEqual(pendingReasons({ context: '常规描述', unverifiedFact: false }), []);
  assert.deepEqual(pendingReasons({ context: '常规描述', unverifiedFact: true }), [
    { category: '待核对', note: '事实来源未核实', source: 'unverified' },
  ]);
  assert.deepEqual(
    pendingReasons({ context: '实质性偏离', declared: { category: '偏离', note: '负偏离需确认' } }),
    [{ category: '偏离', note: '负偏离需确认', source: 'declared' }],
  );
});

test('M38 edit: 2-col table merges r:0/c:1 header with c:0 label; multi-col uses column header and degrades safely on merged/short header', async () => {
  const twoColKeyValue = tbl(
    tr(p('序号/项目'), p('响应内容')),
    tr(p('公司名称'), '<w:p/>'),
    tr(p('投标总价'), '<w:p/>'),
    tr('<w:p/>', '<w:p/>'),
  );
  const twoColPriceList = tbl(
    tr(p('品名'), p('单价')),
    tr(p('样例设备'), '<w:p/>'),
    tr(p('模板设备'), p('0')),
  );
  const multiCol = tbl(
    tr(p('序号'), p('品名')), // intentionally fewer cells than body row (simulating merged/short header)
    tr(p('1'), '<w:p/>', '<w:p/>'),
  );
  const multiColFull = tbl(
    tr(p('序号'), p('品名'), p('单价')),
    tr(p('1'), '<w:p/>', '<w:p/>'),
  );
  const body = p('报价说明') + p('联系人：____') + twoColKeyValue + twoColPriceList + multiCol + multiColFull;
  const base = await makeDoc(body);
  const ledger = makeLedger(base);
  const res = await editBidDraft({
    name: 'bid',
    old: base,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [
      { op: 'replace', at: 'p:1', find: '____', value: '张三' },
      { op: 'set_cell', at: 't:0/r:1/c:1', value: '示例科技有限公司' },
      { op: 'set_cell', at: 't:0/r:2/c:1', value: '100万元' },
      { op: 'set_cell', at: 't:0/r:3/c:1', value: '无需标黄内容' },
      { op: 'set_cell', at: 't:1/r:1/c:1', value: '100' },
      { op: 'insert_rows', at: 't:1/r:2', mode: 'after', rows: [['设备', '100']] },
      { op: 'set_cell', at: 't:2/r:1/c:1', value: '乘客电梯' },
      { op: 'set_cell', at: 't:2/r:1/c:2', value: '无列头单元格安全降级' },
      { op: 'set_cell', at: 't:3/r:1/c:1', value: '载货电梯' },
      { op: 'set_cell', at: 't:3/r:1/c:2', value: '50000' },
    ],
  });
  // Pending items: t:0/r:2/c:1 (c:0='投标总价'), t:1/r:1/c:1 (r:0/c:1='单价'), t:1/r:2/c:1 (insert_rows under r:0/c:1='单价'), t:3/r:1/c:2 (r:0/c:2='单价')
  assert.deepEqual(
    res.pending.map(item => item.category),
    ['报价', '报价', '报价', '报价'],
  );
  const xml = await xmlOf(res.output);
  assert.deepEqual(
    sealRanges(xml).map(r => r.text),
    ['100万元', '100', '100', '50000'],
  );
});

test('M38 edit: insert_rows isolates per-cell keywords, mixes _Seal_F_ and _Seal_P_ in one batch, and passes check + finalize', async () => {
  const table5 = tbl(
    tr(p('序号'), p('品名'), p('单价'), p('交货期'), p('质保期'), p('技术响应')),
    tr(p('1'), p('模板品名'), p('0'), p('0天'), p('0年'), p('模板响应')),
  );
  const table2 = tbl(
    tr(p('字段'), p('响应内容')),
    tr(p('模板键'), p('模板值')),
  );
  const base = await makeDoc(table5 + table2);
  const ledger = makeLedger(base);

  const op5 = {
    op: 'insert_rows' as const,
    at: 't:0/r:1',
    mode: 'after' as const,
    rows: [['2', '示例企业有限公司', '88000', '45天', 'UNV-999', '完全响应招标要求，无偏离并承诺优质服务']],
  };
  const op2 = {
    op: 'insert_rows' as const,
    at: 't:1/r:1',
    mode: 'after' as const,
    rows: [
      ['联系人', '李四'],
      ['优惠说明', '九折'],
    ],
  };
  const verifiedSource = { reference: '{{subject.legalName}}', resolvedValue: '示例企业有限公司', verified: true };
  const unverifiedSource = { reference: '{{record:unv.number}}', resolvedValue: 'UNV-999', verified: false };
  const facts = new Map<typeof op5, FactResolution>([
    [
      op5,
      {
        value: '示例企业有限公司\nUNV-999',
        sources: [verifiedSource, unverifiedSource],
        spans: [],
        verified: false,
      },
    ],
  ]);

  const res = await editBidDraft({
    name: 'bid',
    old: base,
    base,
    ledger,
    operations: [op5, op2],
    facts,
    images: new Map(),
    markdownImages: new Map(),
  });

  const xml = await xmlOf(res.output);
  const ranges = sealRanges(xml);
  // In table5: c:1 ('示例企业有限公司') => _Seal_F_; c:2 ('88000') => _Seal_P_; c:3 ('45天') => _Seal_P_; c:4 ('UNV-999') => _Seal_P_ (质保 + 待核对); c:0 & c:5 => white!
  // In table2: row 0 ('联系人','李四') => white; row 1 ('优惠说明','九折') => both _Seal_P_!
  const fRanges = ranges.filter(r => r.name.startsWith('_Seal_F_'));
  const pRanges = ranges.filter(r => r.name.startsWith('_Seal_P_'));
  assert.deepEqual(fRanges.map(r => r.text), ['示例企业有限公司']);
  assert.deepEqual(pRanges.map(r => r.text), ['88000', '45天', 'UNV-999', '优惠说明', '九折']);

  const unvFill = ledger.fills.find(f => f.sealKind === 'pending');
  const verFill = ledger.fills.find(f => f.sealKind === 'fact');
  assert.ok(verFill?.verified);
  assert.equal(verFill?.resolvedValue, '示例企业有限公司');
  assert.equal(unvFill?.verified, false);
  assert.equal(unvFill?.resolvedValue, 'UNV-999');

  const unvPending = ledger.pending.find(item => item.id === unvFill?.id);
  assert.deepEqual(unvPending?.reasons.map(r => r.category), ['质保', '待核对']);

  // Check draft with checkDraft: C04=5, C05=1 (unverified), C10=0
  const context = { root: '/project', vaultId: null, deadline: '2028-12-31' };
  const project: ProjectMetadata = {
    format: 'seal-project-1',
    name: 'test',
    deadline: context.deadline,
    vaultId: null,
    tenders: [],
    drafts: ['bid'],
    createdAt: '2028-01-01',
  };
  const secret = new Uint8Array(32).fill(38);
  await sealLedger(ledger, context.root, secret);
  const report = (await checkDraft({} as HostPort, {
    name: 'bid',
    root: context.root,
    draft: res.output,
    base,
    ledger,
    project,
    secret,
    anchor: ledger.integrity,
  })) as { results: Record<string, unknown[]> };
  assert.equal(report.results.C04.length, 5);
  assert.equal(new Set((report.results.C05 as Array<{ id: string }>).map(item => item.id)).size, 1);
  assert.equal((report.results.C05 as Array<{ id: string }>)[0].id, unvFill?.id);
  assert.equal(report.results.C10.length, 0);

  // Confirm all pending items, accept original diffs if any (none here), finalize
  for (const item of ledger.pending) {
    await confirmPending(ledger, 'bid', item.id, xml, context, secret);
  }
  await sealLedger(ledger, context.root, secret);
  const finalBytes = await finalizeDraftMarkers({} as HostPort, {
    name: 'bid',
    root: context.root,
    draft: res.output,
    base,
    ledger,
    anchor: ledger.integrity,
    project,
    secret,
  });
  const finalXml = await xmlOf(finalBytes);
  assert.equal(sealRanges(finalXml).length, 0);
  assert.ok(visibleRunProperties(finalXml).every(pr => !pr.includes('yellow')));
  assert.ok(finalXml.includes('示例企业有限公司'));
  assert.ok(finalXml.includes('UNV-999'));
});

test('M38 edit: insert prose with keywords stays white, while mixed verified/unverified KB facts and images mark only unverified parts', async t => {
  const home = path.resolve('.tmp', `m38-insert-${randomUUID()}`);
  const prev = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (prev === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const kb = new KnowledgeBase(host, path.join(home, 'vaults'));
  const vault = await kb.createVault({ vaultId: 'm38-vault', name: 'M38测试库' });
  await kb.save(vault.vaultId, { action: 'update', kind: 'subject', fields: { legalName: '智造股份', contact: '王五' } });
  await kb.verify(vault.vaultId, 'subject', 'subject', ['legalName']);
  const unvRec = await kb.save(vault.vaultId, {
    action: 'create',
    kind: 'record',
    fields: { type: '其他', title: '未核实资质', number: 'CERT-UNV-01', holder: '智造股份', validUntil: '长期' },
    body: '',
  });
  await kb.save(vault.vaultId, {
    action: 'attach_file',
    kind: 'record',
    id: unvRec.id!,
    file: { fileName: 'unv.png', bytes: new Uint8Array(await fs.readFile('tests/fixtures/evidence-2x1.png')) },
  });
  const unvEntry = await kb.get(vault.vaultId, 'record', unvRec.id!);
  const unvImg = `kb:${unvRec.id}/${(unvEntry.fields.files as string[])[0]}`;

  const source = path.join(home, 'tender.docx');
  const projectRoot = path.join(home, 'project');
  await fs.writeFile(
    source,
    await makeDoc(
      p(
        '报价及承诺说明（居中提示）',
        '<w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/><w:pageBreakBefore/><w:keepNext/><w:outlineLvl w:val="0"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:line="360" w:lineRule="auto"/><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:pPr>',
      ),
    ),
  );
  await runProject(host, ['init', '--root', projectRoot, '--name', 'M38测试', '--deadline', '2028-12-31', '--vault', vault.vaultId, '--tender', source]);
  await runProject(host, ['extract', '--project', projectRoot, '--tender', 'tender/1.docx', '--draft', 'tech', '--ranges', '[{"from":"p:0","to":"p:0"}]']);

  // 1. Insert prose containing 承诺/维保/工期/偏离/报价 after centered Heading1 anchor -> stays white AND left-aligned!
  await runProject(host, [
    'edit',
    '--project',
    projectRoot,
    '--draft',
    'tech',
    '--ops',
    JSON.stringify([
      {
        op: 'insert',
        at: 'p:0',
        position: 'after',
        markdown: '我方承诺严格响应工期、维保、偏离与报价等商务条款，主体为{{subject.legalName}}，未核实编号{{subject.contact}}。\n\n![证据](<' + unvImg + '>)',
      },
    ]),
  ]);

  const draftBytes = new Uint8Array(await fs.readFile(path.join(projectRoot, 'draft', 'tech.docx')));
  const docXml = await xmlOf(draftBytes);
  const ranges = sealRanges(docXml);
  const fScopes = ranges.filter(r => r.name.startsWith('_Seal_F_'));
  const pScopes = ranges.filter(r => r.name.startsWith('_Seal_P_'));
  assert.deepEqual(fScopes.map(r => r.text), ['智造股份']);
  assert.deepEqual(pScopes.map(r => r.text), ['王五', '（图片待核对1）\n']);

  const techCheck = (await runProject(host, ['check', '--project', projectRoot, '--draft', 'tech'])) as {
    results: Record<string, Array<{ id?: string; value?: string }>>;
  };
  assert.equal(techCheck.results.C04.length, 2);
  assert.equal(new Set(techCheck.results.C05.map(i => i.id)).size, 2);
  assert.deepEqual(techCheck.results.C10, []);
  assert.deepEqual(techCheck.results.C16, []);

  // Verify body paragraph p:1 has sanitized pPr (left aligned, font/spacing kept, heading/pageBreak/keepNext/numPr/outlineLvl stripped)
  const blocks = parseDocumentBody(docXml).blocks;
  const insertedPPr = extractFirstParagraphPr(blocks[1].xml);
  assert.match(insertedPPr, /<w:jc w:val="left"\/>/);
  assert.match(insertedPPr, /w:eastAsia="宋体"/);
  assert.match(insertedPPr, /<w:spacing w:line="360"/);
  assert.doesNotMatch(insertedPPr, /w:val="center"|Heading1|pageBreakBefore|keepNext|outlineLvl|numPr/);
});

test('M38 xml: sanitizeInsertedBodyParagraphPr strips non-body structures and center/right jc while retaining fonts, spacing and indents', () => {
  assert.equal(sanitizeInsertedBodyParagraphPr(''), '');
  assert.equal(sanitizeInsertedBodyParagraphPr('<w:pPr/>'), '');
  assert.equal(sanitizeInsertedBodyParagraphPr('<w:pPr><w:pageBreakBefore/><w:keepNext/><w:outlineLvl w:val="1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>'), '');

  for (const styleId of ['Heading1', 'heading 2', 'Title', 'Subtitle', 'TOC1', '标题 1', '1', '9']) {
    const out = sanitizeInsertedBodyParagraphPr(`<w:pPr><w:pStyle w:val="${styleId}"/><w:jc w:val="center"/><w:spacing w:after="120"/><w:ind w:firstLine="420"/><w:rPr><w:sz w:val="21"/></w:rPr></w:pPr>`);
    assert.doesNotMatch(out, /<w:pStyle/, styleId);
    assert.match(out, /<w:jc w:val="left"\/>/, styleId);
    assert.match(out, /<w:spacing w:after="120"\/>/, styleId);
    assert.match(out, /<w:ind w:firstLine="420"\/>/, styleId);
    assert.match(out, /<w:sz w:val="21"\/>/, styleId);
  }

  const rightAligned = sanitizeInsertedBodyParagraphPr('<w:pPr><w:pStyle w:val="Normal"/><w:jc w:val="right"/></w:pPr>');
  assert.match(rightAligned, /<w:pStyle w:val="Normal"\/>/);
  assert.match(rightAligned, /<w:jc w:val="left"\/>/);

  const justified = '<w:pPr><w:pStyle w:val="BodyText"/><w:jc w:val="both"/><w:spacing w:line="240"/></w:pPr>';
  assert.equal(sanitizeInsertedBodyParagraphPr(justified), justified);

  // applyTextBatch insert path also sanitizes anchor pPr
  const docXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('居中提示', '<w:pPr><w:pStyle w:val="2"/><w:jc w:val="center"/><w:keepNext/><w:spacing w:after="100"/></w:pPr>')}<w:sectPr/></w:body></w:document>`;
  const batched = applyTextBatch(docXml, [{ op: 'insert', at: 'p:0', position: 'after', markdown: '普通正文段' }]);
  const insertedBlock = parseDocumentBody(batched).blocks[1];
  assert.equal(editableText(insertedBlock.xml), '普通正文段');
  const pPr = extractFirstParagraphPr(insertedBlock.xml);
  assert.match(pPr, /<w:jc w:val="left"\/>/);
  assert.match(pPr, /<w:spacing w:after="100"\/>/);
  assert.doesNotMatch(pPr, /w:val="center"|w:pStyle|keepNext/);
});

test('M38 skill: seal-bid emphasizes white-background AI prose and forbids blanket pending on chapters/tables', () => {
  assert.ok(SEAL_BID_SKILL.description.length <= 500);
  assert.match(SEAL_BID_SKILL.content, /白底/);
  assert.match(SEAL_BID_SKILL.content, /严禁.*批量挂\s*`pending`/);
  assert.match(SEAL_BID_SKILL.content, /mark_pending/);
  assert.match(SEAL_BID_SKILL.content, /跳过招标文件自身的章节大标题/);
  assert.match(SEAL_BID_SKILL.content, /正（或副）本/);
});

test('M38 edit: insert_rows after a mark_pending template cell restores native highlight (white or cyan) without leaking orphan yellow', async () => {
  const cyanP = '<w:p><w:r><w:rPr><w:highlight w:val="cyan"/></w:rPr><w:t>青底模板</w:t></w:r></w:p>';
  const table = tbl(tr(p('白底模板'), cyanP));
  const base = await makeDoc(table);
  const ledger = makeLedger(base);

  const marked = await editBidDraft({
    name: 'bid',
    old: base,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [
      { op: 'mark_pending', at: 't:0/r:0/c:0', find: '白底模板', pending: { category: '其他', note: '待核对白底' } },
      { op: 'mark_pending', at: 't:0/r:0/c:1', find: '青底模板', pending: { category: '其他', note: '待核对青底' } },
    ],
  });
  assert.equal(ledger.pending.length, 2);

  const expanded = await editBidDraft({
    name: 'bid',
    old: marked.output,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['正常内容', '正常青底']] }],
  });
  assert.equal(ledger.pending.length, 2, 'Non-sensitive insert_rows adds no extra pending items');

  const xml = await xmlOf(expanded.output);
  const ranges = sealRanges(xml);
  assert.deepEqual(ranges.map(r => r.text), ['白底模板', '青底模板']);

  const rows = parseDocumentBody(xml).blocks[0];
  assert.equal(rows.kind, 'table');
  const row0 = rows.xml.match(/<w:tr>[\s\S]*?<\/w:tr>/g)![0];
  const row1 = rows.xml.match(/<w:tr>[\s\S]*?<\/w:tr>/g)![1];
  assert.match(row0, /w:val="yellow"/);
  assert.doesNotMatch(row1, /w:val="yellow"/, 'Copied row must not leak orphan yellow highlight');
  const row1Cells = row1.match(/<w:tc>[\s\S]*?<\/w:tc>/g)!;
  assert.doesNotMatch(row1Cells[0], /<w:highlight/, 'White source cell restores to no highlight');
  assert.match(row1Cells[1], /<w:highlight w:val="cyan"\/>/, 'Cyan source cell restores native cyan highlight');
});

test('M38 edit: gridSpan and gridBefore map logical columns accurately without misaligning physical indices', async () => {
  const spanHeaderRow = `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p('设备信息')}</w:tc><w:tc>${p('单价')}</w:tc></w:tr>`;
  const spanTable = tbl(
    spanHeaderRow,
    tr(p('1'), p('旧设备'), p('50')),
    tr(p('0'), p('空设备'), '<w:p/>'),
    tr(p('0'), p('模板设备'), p('0')),
  );
  const gridBeforeTable = tbl(
    tr(p('序号'), p('品名'), p('单价')),
    `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr><w:tc>${p('旧型号')}</w:tc><w:tc><w:p/></w:tc></w:tr>`,
    `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr><w:tc>${p('模板型号')}</w:tc><w:tc>${p('0')}</w:tc></w:tr>`,
  );
  const gridBeforeNonKvTable = tbl(
    tr(p('序号'), p('报价'), p('备注')),
    `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr><w:tc>${p('100')}</w:tc><w:tc><w:p/></w:tc></w:tr>`,
  );
  const base = await makeDoc(spanTable + gridBeforeTable + gridBeforeNonKvTable);
  const ledger = makeLedger(base);

  const res = await editBidDraft({
    name: 'bid',
    old: base,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [
      { op: 'replace', at: 't:0/r:1/c:1', find: '旧设备', value: '新设备' },
      { op: 'replace', at: 't:0/r:1/c:2', find: '50', value: '80' },
      { op: 'set_cell', at: 't:0/r:2/c:2', value: '90' },
      { op: 'insert_rows', at: 't:0/r:3', mode: 'after', rows: [['2', '新设备二', '100']] },
      { op: 'replace', at: 't:1/r:1/c:0', find: '旧型号', value: '新型号' },
      { op: 'set_cell', at: 't:1/r:1/c:1', value: '200' },
      { op: 'insert_rows', at: 't:1/r:2', mode: 'after', rows: [['设备X', '300']] },
      { op: 'set_cell', at: 't:2/r:1/c:1', value: '正常备注' },
    ],
  });

  assert.deepEqual(
    res.pending.map(item => item.category),
    ['报价', '报价', '报价', '报价', '报价'],
  );
  const xml = await xmlOf(res.output);
  assert.deepEqual(
    sealRanges(xml).map(r => r.text),
    ['80', '90', '100', '200', '300'],
  );
});

test('M38 edit: same-batch header update to 单价 propagates to insert_rows and set_cell in the same table', async () => {
  const table = tbl(
    tr(p('品名'), p('响应')),
    tr(p('模板设备'), p('0')),
    tr(p('待填设备'), '<w:p/>'),
  );
  const base = await makeDoc(table);
  const ledger = makeLedger(base);

  const res = await editBidDraft({
    name: 'bid',
    old: base,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [
      { op: 'replace', at: 't:0/r:0/c:1', find: '响应', value: '单价' },
      { op: 'insert_rows', at: 't:0/r:1', mode: 'after', rows: [['设备', '100']] },
      { op: 'set_cell', at: 't:0/r:2/c:1', value: '200' },
    ],
  });

  assert.deepEqual(res.pending.map(item => item.category), ['报价', '报价', '报价']);
  const xml = await xmlOf(res.output);
  assert.deepEqual(sealRanges(xml).map(r => r.text), ['单价', '100', '200']);
});

test('M38 edit: hMerge horizontal header spans merged columns identically to gridSpan', async () => {
  const hMergeHeader = `<w:tr><w:tc>${p('品名')}</w:tc><w:tc><w:tcPr><w:hMerge w:val="restart"/></w:tcPr>${p('报价')}</w:tc><w:tc><w:tcPr><w:hMerge/></w:tcPr><w:p/></w:tc></w:tr>`;
  const table = tbl(
    hMergeHeader,
    tr(p('设备A'), p('说明'), '<w:p/>'),
    tr(p('模板'), p('说明'), p('0')),
  );
  const base = await makeDoc(table);
  const ledger = makeLedger(base);
  const res = await editBidDraft({
    name: 'bid',
    old: base,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [
      { op: 'set_cell', at: 't:0/r:1/c:2', value: '100' },
      { op: 'insert_rows', at: 't:0/r:2', mode: 'after', rows: [['设备B', '普通', '200']] },
    ],
  });
  assert.deepEqual(res.pending.map(item => item.category), ['报价', '报价', '报价']);
  const xml = await xmlOf(res.output);
  assert.deepEqual(sealRanges(xml).map(r => r.text), ['100', '普通', '200']);
});

test('M38 edit: same-batch multi-replace composing 报价 on header applies to set_cell and insert_rows', async () => {
  const table = tbl(
    tr(p('品名'), p('甲乙')),
    tr(p('设备A'), '<w:p/>'),
    tr(p('模板'), p('0')),
  );
  const base = await makeDoc(table);
  const ledger = makeLedger(base);
  const res = await editBidDraft({
    name: 'bid',
    old: base,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [
      { op: 'replace', at: 't:0/r:0/c:1', find: '甲', value: '报' },
      { op: 'replace', at: 't:0/r:0/c:1', find: '乙', value: '价' },
      { op: 'set_cell', at: 't:0/r:1/c:1', value: '100' },
      { op: 'insert_rows', at: 't:0/r:2', mode: 'after', rows: [['设备B', '200']] },
    ],
  });
  assert.deepEqual(res.pending.map(item => item.category), ['报价', '报价', '报价', '报价']);
  const xml = await xmlOf(res.output);
  assert.deepEqual(sealRanges(xml).map(r => r.text), ['报', '价', '100', '200']);
});

test('M38 edit: set_cell and blank replace strip Seal pending yellow from left neighbor while restoring native cyan highlight', async () => {
  const cyanP = '<w:p><w:r><w:rPr><w:highlight w:val="cyan"/></w:rPr><w:t>青底模板</w:t></w:r></w:p>';
  const table = tbl(
    tr(p('白底模板'), '<w:p/>'),
    tr(cyanP, '<w:p/>'),
    tr(p('白底模板二'), '<w:p/>'),
    tr(cyanP, '<w:p/>'),
  );
  const base = await makeDoc(table);
  const ledger = makeLedger(base);
  const marked = await editBidDraft({
    name: 'bid',
    old: base,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [
      { op: 'mark_pending', at: 't:0/r:0/c:0', find: '白底模板', pending: { category: '其他', note: '待核1' } },
      { op: 'mark_pending', at: 't:0/r:1/c:0', find: '青底模板', pending: { category: '其他', note: '待核2' } },
      { op: 'mark_pending', at: 't:0/r:2/c:0', find: '白底模板二', pending: { category: '其他', note: '待核3' } },
      { op: 'mark_pending', at: 't:0/r:3/c:0', find: '青底模板', pending: { category: '其他', note: '待核4' } },
    ],
  });
  const filled = await editBidDraft({
    name: 'bid',
    old: marked.output,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [
      { op: 'set_cell', at: 't:0/r:0/c:1', value: '普通填写1' },
      { op: 'set_cell', at: 't:0/r:1/c:1', value: '普通填写2' },
      { op: 'replace', at: 't:0/r:2/c:1', blank: 0, value: '普通填写3' },
      { op: 'replace', at: 't:0/r:3/c:1', blank: 0, value: '普通填写4' },
    ],
  });
  assert.equal(ledger.pending.length, 4, 'Empty-cell fills from pending neighbors must not create extra pending');
  const xml = await xmlOf(filled.output);
  const rows = parseDocumentBody(xml).blocks[0].xml.match(/<w:tr>[\s\S]*?<\/w:tr>/g)!;
  for (const [rowIndex, expectCyan] of [[0, false], [1, true], [2, false], [3, true]] as const) {
    const rightCell = rows[rowIndex].match(/<w:tc>[\s\S]*?<\/w:tc>/g)![1];
    assert.doesNotMatch(rightCell, /w:val="yellow"/, `row ${rowIndex} must not leak yellow`);
    if (expectCyan) assert.match(rightCell, /<w:highlight w:val="cyan"\/>/, `row ${rowIndex} restores cyan`);
    else assert.doesNotMatch(rightCell, /<w:highlight/, `row ${rowIndex} restores white`);
  }
});

test('M38 edit: insert_rows places cell fact citations by exact resolved coordinates instead of substring search', async t => {
  const home = path.resolve('.tmp', `m38-cell-pos-${randomUUID()}`);
  const prev = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (prev === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const kb = new KnowledgeBase(host, path.join(home, 'vaults'));
  const vault = await kb.createVault({ vaultId: 'm38-pos-vault', name: '坐标测试库' });
  await kb.save(vault.vaultId, { action: 'update', kind: 'subject', fields: { legalName: '10' } });
  await kb.verify(vault.vaultId, 'subject', 'subject', ['legalName']);
  const unv = await kb.save(vault.vaultId, {
    action: 'create',
    kind: 'record',
    fields: { type: '其他', title: '数量记录', number: '10', holder: '10', validUntil: '长期' },
    body: '',
  });

  const source = path.join(home, 'tender.docx');
  const projectRoot = path.join(home, 'project');
  await fs.writeFile(
    source,
    await makeDoc(tbl(tr(p('编号'), p('说明')), tr(p('0'), p('模板')))),
  );
  await runProject(host, ['init', '--root', projectRoot, '--name', '精确坐标测试', '--deadline', '2028-12-31', '--vault', vault.vaultId, '--tender', source]);
  await runProject(host, ['extract', '--project', projectRoot, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', '[{"from":"t:0","to":"t:0"}]']);

  await runProject(host, [
    'edit',
    '--project',
    projectRoot,
    '--draft',
    'bid',
    '--ops',
    JSON.stringify([
      {
        op: 'insert_rows',
        at: 't:0/r:1',
        mode: 'after',
        rows: [
          ['{{subject.legalName}}', '本页有100项'],
          [`{{record:${unv.id}.number}}`, '本页另有100项'],
        ],
      },
    ]),
  ]);

  const docXml = await xmlOf(new Uint8Array(await fs.readFile(path.join(projectRoot, 'draft', 'bid.docx'))));
  const scopes = sealRanges(docXml);
  assert.deepEqual(scopes.filter(s => s.name.startsWith('_Seal_F_')).map(s => s.text), ['10']);
  assert.deepEqual(scopes.filter(s => s.name.startsWith('_Seal_P_')).map(s => s.text), ['10']);
  const report = (await runProject(host, ['check', '--project', projectRoot, '--draft', 'bid'])) as {
    results: Record<string, unknown[]>;
  };
  assert.equal(report.results.C04.length, 1);
  assert.equal(report.results.C10.length, 0);
});
