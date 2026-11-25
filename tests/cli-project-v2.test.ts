import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readZip, writeZip } from '../src/core/docx/zip.js';
import { acknowledgeLedgerRecovery, sealLedger } from '../src/core/bid/ledger-integrity.js';
import { persistEditedDraft } from '../src/core/bid/edit.js';
import { NodeHostPort } from '../src/shells/node-host.js';

const run = promisify(execFile);
async function cli(...args: string[]): Promise<any> {
  const result = await run(process.execPath, ['--import', 'tsx', 'src/shells/cli/index.ts', ...(args[0] === 'init' ? ['project'] : []), ...args]);
  return JSON.parse(result.stdout);
}

test('CLI project path initializes, reads, extracts, edits and checks a draft', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/cli-v2-'));
  const previousSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  try {
    const input = await writeZip(new Map([
      ['[Content_Types].xml', new TextEncoder().encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
      ['word/document.xml', new TextEncoder().encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>姓名：____ 电话：____ □同意</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>报价</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>')],
    ]));
    const source = path.join(sandbox, 'original.docx'), root = path.join(sandbox, 'project');
    await writeFile(source, input);
    await cli('init', '--root', root, '--name', '测试', '--deadline', '2028-02-29', '--tender', source);
    const read = await cli('read', '--project', root, '--file', 'tender/1.docx', '--mode', 'blocks');
    assert.equal(read.items[0].address, 'p:0');
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', '商务', '--ranges', JSON.stringify([{ from: 'p:0', to: 't:0' }]));
    const edited = await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '姓名：____', value: '姓名：张三' }, { op: 'check', at: 'p:0', option: '同意', checked: true }, { op: 'set_cell', at: 't:0/r:0/c:1', value: '100' }]));
    assert.equal(edited.pending.length, 1);
    assert.equal(edited.pending[0].category, '报价');
    assert.ok(edited.pending.every((item: { reasons: Array<{ source: string }> }) => item.reasons.every(reason => reason.source === 'keyword')));
    assert.deepEqual(edited.results.map((item: { status: string }) => item.status), ['applied', 'applied', 'applied']);
    assert.equal(edited.results[0].views[0].address, 'p:0');
    assert.match(edited.results[0].views[0].text, /姓名：张三/);
    assert.equal(edited.results[2].views[0].address, 't:0/r:0/c:1');
    const rows = await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['报价二', '200']] }]));
    assert.ok(rows.pending.length >= 2);
    assert.equal(rows.results[0].views[0].address, 't:0/r:1');
    await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert', at: 't:0', position: 'after', markdown: '## 方案\n\n正文 **重点**。' }]));
    const inserted = await cli('read', '--project', root, '--file', '商务', '--mode', 'blocks');
    assert.ok(inserted.items.some((item: { text: string }) => item.text === '方案'));
    assert.ok(inserted.items.some((item: { text: string }) => item.text.includes('«待定:报价»100«/待定»')));
    const firstPage = await cli('read', '--project', root, '--file', '商务', '--mode', 'blocks', '--limit', '1');
    assert.ok(firstPage.next);
    const nextPage = await cli('read', '--project', root, '--file', '商务', '--mode', firstPage.next.mode, '--limit', String(firstPage.next.limit), '--max-chars', String(firstPage.next.maxChars), '--context', String(firstPage.next.context), '--cursor', JSON.stringify(firstPage.next.cursor));
    assert.notEqual(nextPage.items[0].address, firstPage.items[0].address);
    await writeFile(path.join(root, 'materials', 'image.png'), await readFile('tests/fixtures/evidence-2x1.png'));
    const image = await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert_image', at: 't:0', image: 'materials/image.png', pending: { category: '报价', note: '核对图片' } }]));
    assert.ok(image.pending.some((item: { category: string }) => item.category === '报价'));
    await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert', at: 'p:0', position: 'after', markdown: '材料 ![图片](materials/image.png)' }]));
    const markdownPending = await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert', at: 'p:0', position: 'after', markdown: '报价材料 ![图片](materials/image.png)', pending: { category: '报价', note: '核对报价材料' } }]));
    assert.ok(markdownPending.pending.some((item: { category: string }) => item.category === '报价'));
    assert.ok(markdownPending.pending.every((item: { id?: string }) => !!item.id));
    const protectedDraft = path.join(root, 'draft', '商务.docx'), protectedBytes = await readFile(protectedDraft);
    await assert.rejects(cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '张三', value: '李四' }, { op: 'replace', at: 'p:0', find: '不存在', value: '错误' }])), (error: any) => {
      const failure = JSON.parse(error.stderr);
      assert.equal(failure.committed, false);
      assert.deepEqual(failure.results.map((item: { status: string }) => item.status), ['rolled_back', 'rejected']);
      assert.match(failure.results[1].suggestion, /建议/);
      return true;
    });
    await assert.rejects(cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '张三', value: '甲' }, { op: 'replace', at: 'p:0', find: '姓名：张三', value: '乙' }])), (error: any) => {
      const failure = JSON.parse(error.stderr);
      assert.equal(failure.committed, false);
      assert.ok(failure.results.every((item: { status: string; suggestion: string }) => item.status === 'rolled_back' && item.suggestion.includes('冲突')));
      return true;
    });
    assert.deepEqual(await readFile(protectedDraft), protectedBytes);
    const imageParts = await readZip(protectedBytes);
    assert.equal([...imageParts.keys()].filter(name => name.startsWith('word/media/seal-image-')).length, 3);
    await writeFile(path.join(root, 'materials', 'image.gif'), await readFile('tests/fixtures/geometry.gif'));
    await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert_image', at: 'p:0', image: 'materials/image.gif' }]));
    await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert', at: 'p:0', position: 'after', markdown: '材料 ![图片](materials/image.gif)' }]));
    const withGif = await readFile(protectedDraft);
    assert.equal([...(await readZip(withGif)).keys()].filter(name => name.startsWith('word/media/seal-image-')).length, 5);
    await writeFile(path.join(root, 'materials', 'bad.gif'), new Uint8Array([0, 1, 2]));
    await assert.rejects(cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert_image', at: 'p:0', image: 'materials/bad.gif' }])));
    await assert.rejects(cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert', at: 'p:0', position: 'after', markdown: '![图片](materials/bad.gif)' }])));
    assert.deepEqual(await readFile(protectedDraft), withGif);
    await assert.rejects(cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert_prepared_image', at: 'p:0', drawing: '</w:p><bad/>' }])));
    await assert.rejects(cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '电话：____', value: '电话：123', explicitlyConfirmed: true }])));
    await assert.rejects(cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert', at: 'p:0', position: 'after', markdown: 'x', compiledXml: '<bad/>' }])));
    assert.deepEqual(await readFile(protectedDraft), withGif);
    const report = await cli('check', '--project', root, '--draft', '商务');
    assert.deepEqual(report.results.C01, []);
    assert.ok(report.results.C04.length > 0);
    assert.ok(report.results.C02.some((item: { id: string }) => item.id === 'p:0#1'));
    assert.ok(report.results.C02.some((item: { id: string }) => item.id === 'p:0#0'));
    assert.deepEqual(report.results.C06, []);
    assert.deepEqual(report.results.C10, []);
    assert.deepEqual(report.results.C15, []);
    const group = await cli('check', '--project', root, '--draft', '商务', '--group', 'C04');
    assert.deepEqual(Object.keys(group.results), ['C04']);
    assert.equal(group.counts.C04, report.results.C04.length);
    assert.equal(group.remaining.C04, Math.max(0, group.counts.C04 - group.results.C04.length));
    assert.equal(group.truncated.C04, group.remaining.C04 > 0);
    const allDrafts = await cli('check', '--project', root, '--group', 'C04');
    assert.equal(allDrafts.volumes.length, 1);
    assert.equal(allDrafts.volumes[0].draft, '商务');
    assert.equal(allDrafts.volumes[0].counts.C04, group.counts.C04);
    assert.equal(group.ready, false);
    await assert.rejects(cli('check', '--project', root, '--draft', '商务', '--group', 'C99'));
    await assert.rejects(cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'dismiss_hint', at: 'p:0', blank: 1, reason: '' }])));
    await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'dismiss_hint', at: 'p:0', blank: 0, reason: '本次不适用' }]));
    const skipped = await cli('check', '--project', root, '--draft', '商务');
    assert.ok(skipped.results.C03.some((item: { id: string }) => item.id === 'p:0#0'));
    assert.ok(!skipped.results.C02.some((item: { id: string }) => item.id === 'p:0#0'));
    const ledgerPath = path.join(root, 'ledger.json'), ledgerText = await readFile(ledgerPath, 'utf8');
    const forged = JSON.parse(ledgerText);
    forged.pending[0].status = 'confirmed';
    await writeFile(ledgerPath, JSON.stringify(forged));
    const forgedReport = await cli('check', '--project', root, '--draft', '商务');
    assert.ok(forgedReport.results.C04.some((item: { id: string }) => item.id === forged.pending[0].id));
    assert.ok(forgedReport.results.C15.length > 0);
    const forgedRead = await cli('read', '--project', root, '--file', 'draft/商务.docx', '--mode', 'blocks');
    assert.ok(forgedRead.items.some((item: { text: string }) => item.text.includes('«待定:')));
    await writeFile(ledgerPath, ledgerText);
    const draftPath = path.join(root, 'draft', '商务.docx');
    const entries = await readZip(await readFile(draftPath));
    const xml = new TextDecoder().decode(entries.get('word/document.xml')).replace(/<w:highlight w:val="yellow"\/>/g, '').replace('>报价<', '>总价<');
    entries.set('word/document.xml', new TextEncoder().encode(xml));
    await writeFile(draftPath, await writeZip(entries));
    const tampered = await cli('check', '--project', root, '--draft', '商务');
    assert.ok(tampered.results.C10.length > 0);
    assert.ok(tampered.results.C15.length > 0);
    assert.ok(tampered.results.C06.length > 0);
    await cli('edit', '--project', root, '--draft', '商务', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '电话：____', value: '电话：123' }]));
    const recovered = await cli('check', '--project', root, '--draft', '商务');
    assert.ok(recovered.results.C15.some((item: { reason: string }) => item.reason.includes('草稿在 Seal 之外')));
    assert.ok(recovered.results.C06.length > 0);
    assert.ok(recovered.results.C10.length > 0);
    const corruptMedia = await readZip(await readFile(draftPath));
    const media = [...corruptMedia.keys()].find(item => item.startsWith('word/media/seal-image-'))!;
    corruptMedia.set(media, new Uint8Array([1, 2, 3]));
    await writeFile(draftPath, await writeZip(corruptMedia));
    const brokenImage = await cli('check', '--project', root, '--draft', '商务');
    assert.ok(brokenImage.results.C01.some((item: { part: string }) => item.part === media));
    await writeFile(draftPath, new Uint8Array([1, 2, 3]));
    const broken = await cli('check', '--project', root, '--draft', '商务');
    assert.ok(broken.results.C01.length > 0);
    assert.ok(broken.limitations.some((item: string) => item.includes('其他检查未执行')));
    assert.deepEqual(new Uint8Array(await readFile(source)), input);
  } finally {
    if (previousSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previousSealHome;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('CLI retains an emptied pending range and records deletion of a covered paragraph', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/cli-pending-delete-'));
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'home');
  try {
    const enc = new TextEncoder(), source = path.join(sandbox, 'source.docx'), root = path.join(sandbox, 'project');
    await writeFile(source, await writeZip(new Map([
      ['[Content_Types].xml', enc.encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
      ['word/document.xml', enc.encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>报价：____</w:t></w:r></w:p><w:p><w:r><w:t>交货期：____</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
    ])));
    await cli('init', '--root', root, '--name', 'test', '--deadline', '2028-12-31', '--tender', source);
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:1' }]));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '____', value: '100万元' }, { op: 'replace', at: 'p:1', find: '____', value: '30天' }]));
    const before = await cli('check', '--project', root, '--draft', 'bid');
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '100万元', value: '' }, { op: 'delete', at: 'p:1' }]));
    const after = await cli('check', '--project', root, '--draft', 'bid');
    assert.equal(after.results.C04.length, before.results.C04.length - 1);
    assert.equal(after.results.C10.length, 0);
    const ledger = JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8'));
    assert.equal(ledger.pending.filter((item: { status: string }) => item.status === 'removed').length, 1);
  } finally {
    if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('CLI rejects a modified tender and reports a replaced or missing draft baseline', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/cli-baseline-'));
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'home');
  try {
    const enc = new TextEncoder(), source = path.join(sandbox, 'source.docx'), root = path.join(sandbox, 'project');
    await writeFile(source, await writeZip(new Map([
      ['[Content_Types].xml', enc.encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
      ['word/document.xml', enc.encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>固定条款</w:t></w:r></w:p><w:p><w:r><w:t>另一条款</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
    ])));
    await cli('init', '--root', root, '--name', 'test', '--deadline', '2028-12-31', '--tender', source);
    const tender = path.join(root, 'tender', '1.docx'), originalTender = await readFile(tender);
    const forged = await readZip(originalTender);
    forged.set('word/document.xml', enc.encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>篡改</w:t></w:r></w:p><w:p><w:r><w:t>另一条款</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'));
    await writeFile(tender, await writeZip(forged));
    await assert.rejects(cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:1' }])));
    await writeFile(tender, originalTender);
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:1' }]));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'delete', at: 'p:0' }]));
    const before = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(before.results.C06.length); assert.deepEqual(before.results.C15, []);
    const base = path.join(root, 'draft', 'bid.base.docx');
    await writeFile(base, await readFile(path.join(root, 'draft', 'bid.docx')));
    const forgedReport = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(forgedReport.results.C15.some((item: { reason: string }) => item.reason.includes('基准')));
    assert.ok(forgedReport.limitations.some((item: string) => item.includes('基准')));
    const read = await cli('read', '--project', root, '--file', 'bid', '--mode', 'blocks');
    assert.ok(read.warnings.some((warning: string) => warning.includes('基准')));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '另一条款', value: '另一条款更新' }]));
    const afterEdit = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(afterEdit.results.C15.some((item: { reason: string }) => item.reason.includes('基准')));
    await unlink(base);
    const missing = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(missing.results.C15.some((item: { reason: string }) => item.reason.includes('基准')));
  } finally {
    if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('CLI project initialization converts DOC inside the project without changing the source', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/cli-doc-'));
  const previousSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  try {
    const html = path.join(sandbox, 'source.html'), source = path.join(sandbox, 'source.doc');
    await writeFile(html, '<html><body><p>投标文件格式</p></body></html>');
    await run('soffice', [`-env:UserInstallation=${pathToFileURL(path.join(sandbox, 'profile')).href}`, '--headless', '--convert-to', 'doc:MS Word 97', '--outdir', sandbox, html]);
    const original = await readFile(source), root = path.join(sandbox, 'project');
    await cli('init', '--root', root, '--name', 'DOC 测试', '--deadline', '2028-02-29', '--tender', source);
    const read = await cli('read', '--project', root, '--file', 'tender/1.docx', '--mode', 'blocks');
    assert.ok(read.items.some((block: { text: string }) => block.text.includes('投标文件格式')));
    assert.deepEqual(await readFile(source), original);
  } finally {
    if (previousSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previousSealHome;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('CLI detects deleted or forged ledger state and keeps the incident through later edits', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/cli-ledger-'));
  const previousSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  try {
    const source = path.join(sandbox, 'source.docx'), root = path.join(sandbox, 'project');
    const enc = new TextEncoder();
    await writeFile(source, await writeZip(new Map([
      ['[Content_Types].xml', enc.encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
      ['word/document.xml', enc.encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>报价：____</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
    ])));
    await cli('init', '--root', root, '--name', '台账测试', '--deadline', '2028-12-31', '--tender', source);
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:0' }]));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '报价：____', value: '报价：100万元' }]));
    const ledgerPath = path.join(root, 'ledger.json'), original = JSON.parse(await readFile(ledgerPath, 'utf8'));
    const draftPath = path.join(root, 'draft', 'bid.docx'), originalDraft = await readFile(draftPath);
    const pendingCount = original.pending.length;
    assert.ok(pendingCount > 0);
    for (const field of ['pending', 'dismissals', 'acceptedChanges', 'requirements', 'drafts']) {
      const altered = structuredClone(original);
      altered[field] = field === 'drafts' ? { bid: 'forged' } : field === 'pending' ? [] : [{ id: 'forged' }];
      await writeFile(ledgerPath, JSON.stringify(altered));
      const report = await cli('check', '--project', root, '--draft', 'bid');
      assert.ok(report.results.C15.length > 0, field);
      assert.equal(report.results.C04.length, pendingCount, field);
    }
    const unsealed = structuredClone(original);
    delete unsealed.integrity;
    await writeFile(ledgerPath, JSON.stringify(unsealed));
    const unknown = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(unknown.results.C15.length > 0);
    assert.equal(unknown.results.C04.length, pendingCount);
    const host = new NodeHostPort(), anchorPath = await host.ledgerAnchorPath(root, false), savedAnchor = await readFile(anchorPath);
    await unlink(anchorPath);
    const noAnchor = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(noAnchor.results.C15.length > 0);
    assert.ok(noAnchor.results.C04.some((item: { id: string }) => item.id === 'ledger'));
    await writeFile(anchorPath, savedAnchor);
    const altered = structuredClone(original);
    altered.pending = [];
    await writeFile(ledgerPath, JSON.stringify(altered));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '报价：100万元', value: '报价：200万元' }]));
    const afterEdit = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(afterEdit.results.C15.length > 0);
    assert.ok(afterEdit.results.C04.some((item: { value: string }) => item.value === '报价：200万元'));
    const recovered = JSON.parse(await readFile(ledgerPath, 'utf8'));
    const latestDraft = await readFile(draftPath);
    await writeFile(ledgerPath, JSON.stringify(original));
    await writeFile(draftPath, originalDraft);
    const replayed = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(replayed.results.C15.length > 0);
    assert.ok(replayed.results.C04.some((item: { id: string }) => item.id === recovered.pending.find((entry: { status: string }) => entry.status === 'open')?.id));
    assert.ok(replayed.results.C04.some((item: { value?: string }) => item.value === '报价：100万元'));
    await writeFile(draftPath, latestDraft);
    const key = await readFile(path.join(process.env.SEAL_HOME, 'keys', 'authorization.key'));
    await acknowledgeLedgerRecovery(recovered, root, key, '已人工核对恢复记录');
    await sealLedger(recovered, root, key);
    await persistEditedDraft(host, draftPath, ledgerPath, await host.ledgerAnchorPath(root, true), await readFile(draftPath), recovered);
    assert.deepEqual((await cli('check', '--project', root, '--draft', 'bid')).results.C15, []);
  } finally {
    if (previousSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previousSealHome;
    await rm(sandbox, { recursive: true, force: true });
  }
});
