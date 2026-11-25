import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeHostPort } from '../src/shells/node-host.js';
import { KnowledgeBase } from '../src/core/kb/index.js';
import { runProject } from '../src/shells/cli/project-v2.js';
import { validatePackageStructure } from '../src/core/docx/package-structure.js';
import { xmlElements } from '../src/core/docx/xml.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';
import { workflowTemplate } from './fixtures/workflow-template.js';

test('project CLI resolves verified facts and rejects expired or wrong-holder references without a partial write', async t => {
  const home = path.resolve('.tmp', `bid-facts-${randomUUID()}`), projectRoot = path.join(home, 'project');
  await fs.mkdir(home, { recursive: true });
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous; await fs.rm(home, { recursive: true, force: true }); });
  const host = new NodeHostPort(), kb = new KnowledgeBase(host, path.join(home, 'vaults'));
  const vault = await kb.createVault({ vaultId: 'facts-test-vault', name: '投标合成资料柜' });
  await kb.save(vault.vaultId, { action: 'update', kind: 'subject', fields: { legalName: '合成主体', forbiddenAffiliates: ['禁用主体'] } });
  await kb.verify(vault.vaultId, 'subject', 'subject', ['legalName', 'forbiddenAffiliates']);
  assert.deepEqual((await kb.get(vault.vaultId, 'subject')).verifiedFields, ['forbiddenAffiliates', 'legalName']);
  const makeRecord = async (title: string, fields: Record<string, string>) => {
    const record = await kb.save(vault.vaultId, { action: 'create', kind: 'record', fields: { type: '其他', title, number: `SYN-${title}`, holder: '合成主体', validUntil: '长期', ...fields }, body: '' });
    await kb.verify(vault.vaultId, 'record', record.id!, []);
    return record.id!;
  };
  const expired = await makeRecord('已过期', { validUntil: '2020-01-01' });
  const forbidden = await makeRecord('禁用主体', { holder: '禁用主体' });
  const mismatch = await makeRecord('主体不符', { holder: '其他主体' });
  const live = await makeRecord('动态过期正控', { number: 'SYN-LIVE' });
  const healthy = await makeRecord('正常效期正控', { number: 'SYN-HEALTHY' });
  const soon = await makeRecord('动态临期正控', { number: 'SYN-SOON' });
  const imageRecord = await makeRecord('图片证据正控', { number: 'SYN-IMAGE' });
  await kb.save(vault.vaultId, { action: 'attach_file', kind: 'record', id: imageRecord, file: { fileName: '证书 (2026) 1.png', bytes: new Uint8Array(await fs.readFile(path.resolve('tests/fixtures/evidence-2x1.png'))) } });
  await kb.verify(vault.vaultId, 'record', imageRecord, []);
  const unknown = await kb.save(vault.vaultId, { action: 'create', kind: 'record', fields: { type: '其他', title: '未知效期主体', number: 'SYN-UNKNOWN' }, body: '' });
  await kb.verify(vault.vaultId, 'record', unknown.id!, []);
  const unverified = await kb.save(vault.vaultId, { action: 'create', kind: 'record', fields: { type: '其他', title: '未核实证据', number: 'SYN-UNVERIFIED', holder: '合成主体', validUntil: '长期' }, body: '' });

  const source = path.join(home, 'format.docx');
  const draftPath = path.join(projectRoot, 'draft/商务.docx'), ledgerPath = path.join(projectRoot, 'ledger.json');
  await fs.writeFile(source, await workflowTemplate());
  await runProject(host, ['init', '--root', projectRoot, '--name', '合成投标', '--deadline', '2028-02-29', '--vault', vault.vaultId, '--tender', source]);
  await runProject(host, ['extract', '--project', projectRoot, '--tender', 'tender/1.docx', '--draft', '商务', '--ranges', JSON.stringify([{ from: 'p:2', to: 'p:6' }])]);
  await runProject(host, ['edit', '--project', projectRoot, '--draft', '商务', '--ops', JSON.stringify([{ op: 'replace', at: 'p:0', find: '投标人名称：________', value: '{{subject.legalName}}' }])]);
  const subjectReport = await runProject(host, ['check', '--project', projectRoot, '--draft', '商务', '--group', 'C05']) as { counts: Record<string, number> };
  assert.equal(subjectReport.counts.C05, 0);

  await runProject(host, ['edit', '--project', projectRoot, '--draft', '商务', '--ops', JSON.stringify([{ op: 'replace', at: 'p:4', find: '固定责任条款：资料按真实原件提供，禁止篡改。', value: '禁用主体 222222222222222222' }])]);
  const identityReport = await runProject(host, ['check', '--project', projectRoot, '--draft', '商务', '--group', 'C09']) as { results: Record<string, Array<{ value?: string }>> };
  assert.ok(identityReport.results.C09.some(item => item.value === '禁用主体'));
  assert.ok(identityReport.results.C09.some(item => item.value === '222222222222222222'));
  const beforeInsertedFact = await runProject(host, ['check', '--project', projectRoot, '--draft', '商务', '--group', 'C05']) as { counts: Record<string, number> };
  await runProject(host, ['edit', '--project', projectRoot, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert', at: 'p:4', position: 'after', markdown: 'Responsible entity: {{subject.legalName}}' }])]);
  const insertedFactReport = await runProject(host, ['check', '--project', projectRoot, '--draft', '商务', '--group', 'C05']) as { counts: Record<string, number> };
  assert.equal(insertedFactReport.counts.C05, beforeInsertedFact.counts.C05, 'Verified references in inserted prose add no new C05 issue');
  const afterFactLedger = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as { fills: Array<{ id: string; operation: string; sources?: Array<{ reference: string }> }> };
  const insertedFact = afterFactLedger.fills.find(fill => fill.operation === 'insert' && fill.sources?.some(source => source.reference === '{{subject.legalName}}'));
  assert.ok(insertedFact);
  const factParts = await validatePackageStructure(new Uint8Array(await fs.readFile(draftPath)));
  const factXml = new TextDecoder().decode(factParts.get('word/document.xml'));
  assert.equal(sealRanges(factXml).find(range => range.name === `_Seal_F_${insertedFact.id}`)?.text, '合成主体');
  const caption = '持证方：合成第三方';
  await kb.save(vault.vaultId, { action: 'update', kind: 'subject', fields: { thirdPartyHolders: ['合成第三方'] } });
  const rawNumber = 'SYN-第三方 A|B*[C]';
  const thirdParty = await makeRecord('第三方图片', { holder: '合成第三方', number: rawNumber });
  await kb.save(vault.vaultId, { action: 'attach_file', kind: 'record', id: thirdParty, file: { fileName: '合成图片.png', bytes: new Uint8Array(await fs.readFile('tests/fixtures/evidence-2x1.png')) } });
  await kb.verify(vault.vaultId, 'record', thirdParty, []);
  const thirdImage = `kb:${thirdParty}/${((await kb.get(vault.vaultId, 'record', thirdParty)).fields.files as string[])[0]}`;
  const addedDraft = async (draft: string) => runProject(host, ['extract', '--project', projectRoot, '--tender', 'tender/1.docx', '--draft', draft, '--ranges', JSON.stringify([{ from: 'p:2', to: 'p:6' }])]);
  const edits = async (draft: string, operations: unknown[]) => runProject(host, ['edit', '--project', projectRoot, '--draft', draft, '--ops', JSON.stringify(operations)]);
  const xmlFor = async (draft: string) => new TextDecoder().decode((await validatePackageStructure(await fs.readFile(path.join(projectRoot, 'draft', `${draft}.docx`)))).get('word/document.xml'));
  for (const [draft, operation] of [
    ['第三方行内', { op: 'insert', at: 'p:4', position: 'after', markdown: `![证明](<${thirdImage}>)` }],
    ['第三方单图', { op: 'insert_image', at: 'p:4', image: thirdImage }],
  ] as const) {
    await addedDraft(draft);
    await assert.rejects(edits(draft, [operation]), /第三方/);
    await edits(draft, [{ ...operation, thirdPartyHolder: '合成第三方' }]);
    const written = await xmlFor(draft);
    const image = sealRanges(written).find(range => written.slice(range.startXml, range.endXml).includes('<w:drawing'));
    assert.equal(image?.text.trimEnd(), caption);
    const imageXml = written.slice(image!.startXml, image!.endXml);
    const imageParagraph = xmlElements(written).find(element => element.name === 'w:p' && element.start < image!.startXml && element.end >= image!.endXml);
    assert.match(written.slice(imageParagraph!.start, image!.endXml), /<w:keepLines\/>/);
    assert.match(imageXml, /<w:br\/>[\s\S]*<w:drawing\b/);
    const report = await runProject(host, ['check', '--project', projectRoot, '--draft', draft]) as { counts: Record<string, number> };
    assert.equal(report.counts.C05, 0);
  }

  const textDraft = '第三方事实册', reference = `{{record:${thirdParty}.number}}`;
  const printed = `${rawNumber}（${caption}）`;
  await addedDraft(textDraft);
  await edits(textDraft, [{ op: 'insert', at: 'p:4', position: 'after', markdown: '| 窄列 | 宽列 |\n| --- | --- |\n| | 保留格式 |' }]);
  const thirdPartyHolder = '合成第三方';
  for (const operation of [
    { op: 'replace', at: 'p:1', find: '________', value: reference },
    { op: 'set_cell', at: 't:0/r:1/c:0', value: reference },
    { op: 'insert_rows', at: 't:0/r:1', mode: 'after', rows: [[reference, '新行']] },
    { op: 'insert', at: 'p:4', position: 'after', markdown: `合成证书编号：**${reference}**` },
  ]) {
    await assert.rejects(edits(textDraft, [operation]), /第三方/);
    await edits(textDraft, [{ ...operation, thirdPartyHolder }]);
  }
  const printedRanges = sealRanges(await xmlFor(textDraft)).filter(scope => scope.text.includes(rawNumber));
  assert.equal(printedRanges.length, 4);
  assert.ok(printedRanges.every(scope => scope.text.includes(printed)));
  const textReport = await runProject(host, ['check', '--project', projectRoot, '--draft', textDraft]) as { results: Record<string, Array<{ reason?: string }>> };
  assert.deepEqual(textReport.results.C05, []);
  const facts = JSON.parse(await fs.readFile(ledgerPath, 'utf8')).fills.filter((fill: { draft: string }) => fill.draft === textDraft);
  assert.ok(facts.every((fill: { sources: Array<{ resolvedValue: string }> }) => fill.sources[0]?.resolvedValue === rawNumber));
  await edits(textDraft, [{ op: 'replace', at: 'p:5', find: caption, value: '持证方：擅改主体' }]);
  const tampered = await runProject(host, ['check', '--project', projectRoot, '--draft', textDraft]) as typeof textReport;
  assert.ok(tampered.results.C05.some(item => item.reason === '事实引用内容已变化'));
  await edits(textDraft, [{ op: 'insert', at: 'p:5', position: 'after', markdown: `| 证书 |\n| --- |\n| ${reference} |`, thirdPartyHolder }]);
  assert.equal(sealRanges(await xmlFor(textDraft)).filter(scope => scope.text === printed).length, 4);

  const mixedDraft = '第三方图文册';
  await addedDraft(mixedDraft);
  const mixed = await edits(mixedDraft, [
    { op: 'insert', at: 'p:3', position: 'after', markdown: `**前文** ![证明](<${thirdImage}>) 后文 ![证明](<${thirdImage}>) 保存尾句`, thirdPartyHolder },
    { op: 'replace', at: 'p:4', find: '固定责任条款', value: `{{record:${unverified.id}.number}}` },
  ]) as { results: Array<{ views: Array<{ address: string; text: string }> }> };
  assert.deepEqual(mixed.results[0].views.map(view => view.text), ['前文 ', caption + '\n', ' 后文 ', caption + '\n', ' 保存尾句']);
  assert.equal(mixed.results[1].views[0].address, 'p:9');
  assert.match(mixed.results[1].views[0].text, /^SYN-UNVERIFIED/);
  const mixedReport = await runProject(host, ['check', '--project', projectRoot, '--draft', mixedDraft]) as { results: Record<string, Array<{ value?: string }>> };
  assert.deepEqual(mixedReport.results.C05.map(item => item.value).filter(Boolean), ['SYN-UNVERIFIED']);

  for (const [draft, find, replacement, expected] of [
    ['事实范围局部', '主体', '公司', '合成公司'],
    ['事实范围完整', '合成主体', '新值', '新值'],
  ] as const) {
    await addedDraft(draft);
    await edits(draft, [{ op: 'replace', at: 'p:0', find: '投标人名称：________', value: `{{record:${live}.holder}}` }]);
    const [before] = sealRanges(await xmlFor(draft));
    assert.match(before.name, /^_Seal_F_/);
    await edits(draft, [{ op: 'replace', at: 'p:0', find, value: replacement }]);
    const after = sealRanges(await xmlFor(draft));
    assert.deepEqual(after.map(item => [item.bookmarkId, item.name, item.text]), [[before.bookmarkId, before.name.replace('_Seal_F_', '_Seal_P_'), expected]]);
    const report = await runProject(host, ['check', '--project', projectRoot, '--draft', draft]) as { results: Record<string, Array<{ reason?: string; value?: string }>> };
    assert.equal(report.results.C04[0]?.value, expected);
    assert.ok(report.results.C05.some(item => item.reason === '事实引用内容已变化'));
    assert.deepEqual(report.results.C10, []);
  }
  const imageEntry = await kb.get(vault.vaultId, 'record', imageRecord);
  const imageFiles = imageEntry.fields.files;
  assert.ok(Array.isArray(imageFiles));
  const rangeDraft = '书签边界册', cell = 't:0/r:0/c:0';
  const imageMarkdown = `![Certificate](<kb:${imageRecord}/${imageFiles[0]}>)`;
  await addedDraft(rangeDraft);
  await edits(rangeDraft, [{ op: 'insert', at: 'p:4', position: 'after', markdown: '| FIRST |\n| --- |\n| ROW |' }]);
  await edits(rangeDraft, [{ op: 'insert', at: `${cell}/p:0`, position: 'after', markdown: 'SECOND' }]);
  await edits(rangeDraft, [{ op: 'mark_pending', at: cell, find: 'FIRSTSECOND', pending: { category: '其他', note: '跨段范围' } }]);
  const rangePath = path.join(projectRoot, 'draft', `${rangeDraft}.docx`);
  const [rangeBefore, ledgerBefore] = await Promise.all([fs.readFile(rangePath), fs.readFile(ledgerPath)]);
  await assert.rejects(edits(rangeDraft, [{ op: 'insert', at: `${cell}/p:0`, position: 'after', markdown: imageMarkdown }]), /首段之前或末段之后/);
  assert.deepEqual(await fs.readFile(rangePath), rangeBefore);
  assert.deepEqual(await fs.readFile(ledgerPath), ledgerBefore);
  await edits(rangeDraft, [{ op: 'insert', at: `${cell}/p:1`, position: 'after', markdown: imageMarkdown }]);
  await edits(rangeDraft, [{ op: 'insert', at: `${cell}/p:0`, position: 'before', markdown: imageMarkdown }]);
  const spans = sealRanges(await xmlFor(rangeDraft));
  assert.deepEqual(spans.map(scope => scope.text), ['', 'FIRSTSECOND', '']);
  assert.deepEqual(spans.map(scope => scope.name.slice(0, 8)), ['_Seal_F_', '_Seal_P_', '_Seal_F_']);
  await runProject(host, ['edit', '--project', projectRoot, '--draft', '商务', '--ops', JSON.stringify([{ op: 'insert', at: 'p:4', position: 'after', markdown: `![Certificate](<kb:${imageRecord}/${imageFiles[0]}>)` }])]);
  const packageParts = await validatePackageStructure(new Uint8Array(await fs.readFile(path.join(projectRoot, 'draft/商务.docx'))));
  const xml = new TextDecoder().decode(packageParts.get('word/document.xml'));
  const elements = xmlElements(xml);
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as { fills: Array<{ id: string; draft: string; sources?: Array<{ recordId?: string; media?: boolean }> }> };
  const imageFill = ledger.fills.find(fill => fill.draft === '商务' && fill.sources?.some(source => source.recordId === imageRecord && source.media));
  assert.ok(imageFill, 'Verified KB image has a source record in the ledger');
  const start = elements.find(element => element.name === 'w:bookmarkStart' && xml.slice(element.start, element.openEnd).includes(`_Seal_F_${imageFill.id}`));
  assert.ok(start, 'Verified KB image has an _Seal_F_ identity');
  assert.equal(elements[start.parent!].name, 'w:p', 'Image bookmark markers stay at paragraph level outside the drawing run');

  for (const [id, reason] of [[expired, /已过期/], [forbidden, /禁用/], [mismatch, /不符/]] as const) {
    const draftBefore = await fs.readFile(draftPath), ledgerBefore = await fs.readFile(ledgerPath);
    await assert.rejects(runProject(host, ['edit', '--project', projectRoot, '--draft', '商务', '--ops', JSON.stringify([{ op: 'replace', at: 'p:1', find: '报价：________', value: `{{record:${id}.number}}` }])]), reason);
    assert.deepEqual(await fs.readFile(draftPath), draftBefore, 'A rejected citation leaves draft bytes unchanged');
    assert.deepEqual(await fs.readFile(ledgerPath), ledgerBefore, 'A rejected citation leaves the ledger unchanged');
  }

  for (const [draft, record, number] of [['未知来源册', unknown, 'SYN-UNKNOWN'], ['未核实来源册', unverified, 'SYN-UNVERIFIED']] as const) {
    await runProject(host, ['extract', '--project', projectRoot, '--tender', 'tender/1.docx', '--draft', draft, '--ranges', JSON.stringify([{ from: 'p:2', to: 'p:6' }])]);
    await runProject(host, ['edit', '--project', projectRoot, '--draft', draft, '--ops', JSON.stringify([{ op: 'insert', at: 'p:4', position: 'after', markdown: `证据编号：{{record:${record.id}.number}}` }])]);
    const report = await runProject(host, ['check', '--project', projectRoot, '--draft', draft]) as { results: Record<string, Array<{ id: string; value?: string; category?: string }>> };
    assert.equal(report.results.C04.length, 1, `${draft} has a pending item for the actual citation`);
    assert.equal(report.results.C04[0].value, number);
    assert.equal(report.results.C04[0].category, '待核对');
    assert.ok(report.results.C05.some(item => item.id === report.results.C04[0].id));
    assert.deepEqual(report.results.C10, [], 'The pending source is visibly marked in the document');
  }

  const dateDrafts = [['效期正序册', [live, soon, healthy]], ['效期反序册', [healthy, soon, live]]] as const;
  for (const [draft, records] of dateDrafts) {
    await runProject(host, ['extract', '--project', projectRoot, '--tender', 'tender/1.docx', '--draft', draft, '--ranges', JSON.stringify([{ from: 'p:2', to: 'p:6' }])]);
    const value = records.map(id => `{{record:${id}.number}}`).join(' + ');
    await runProject(host, ['edit', '--project', projectRoot, '--draft', draft, '--ops', JSON.stringify([{ op: 'replace', at: 'p:1', find: '报价：________', value }])]);
    const initialDates = await runProject(host, ['check', '--project', projectRoot, '--draft', draft]) as { results: Record<string, unknown[]> };
    assert.deepEqual(initialDates.results.C08, []);
  }
  const recordPath = path.join(home, 'vaults', vault.vaultId, 'records', `${live}.md`);
  const recordMarkdown = await fs.readFile(recordPath, 'utf8');
  await fs.writeFile(recordPath, recordMarkdown.replace('validUntil: "长期"', 'validUntil: "2020-01-01"'));
  await kb.save(vault.vaultId, { action: 'update', kind: 'record', id: soon, fields: { validUntil: '2028-03-23' } });
  await kb.verify(vault.vaultId, 'record', soon, []);
  for (const [draft] of dateDrafts) {
    const expiredAfterWrite = await runProject(host, ['check', '--project', projectRoot, '--draft', draft]) as { results: Record<string, Array<{ id: string; recordId?: string; reason: string }>> };
    assert.equal(expiredAfterWrite.results.C08.length, 2, `${draft}: C08 reports both changed records inside one scope`);
    assert.equal(new Set(expiredAfterWrite.results.C08.map(item => item.id)).size, 1);
    assert.match(expiredAfterWrite.results.C08.find(item => item.recordId === live)?.reason ?? '', /已过期/);
    assert.match(expiredAfterWrite.results.C08.find(item => item.recordId === soon)?.reason ?? '', /60 天/);
    assert.ok(expiredAfterWrite.results.C05.length > 0, 'A citation invalidated by current KB state is caught by C05');
  }
});
