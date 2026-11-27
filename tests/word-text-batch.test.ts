import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaxesParser } from 'saxes';
import { applyTextBatch, resolveTextTarget, type TextBatchEdit } from '../src/core/docx/text-batch.js';
import { extractPlainText } from '../src/core/docx/xml.js';
import { editableText } from '../src/core/docx/visible-surgery.js';
import { readZip, sha256Hex, writeZip } from '../src/core/docx/zip.js';
import { editBidDraft } from '../src/core/bid/edit.js';
import type { BidLedger } from '../src/core/bid/project.js';

const xml = `<w:document><w:body><w:p><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>姓名：</w:t></w:r><w:r><w:t>____ 地址：____</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>标签</w:t></w:r></w:p></w:tc><w:tc><w:p><w:pPr/><w:r><w:drawing/></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;

test('same-block replacements use original offsets and keep other text', () => {
  const output = applyTextBatch(xml, [
    { op: 'replace', at: 'p:0', find: '姓名：____', value: '姓名：张三' },
    { op: 'replace', at: 'p:0', find: '地址：____', value: '地址：北京' },
  ]);
  assert.equal(extractPlainText(output), '姓名：张三 地址：北京标签');
  assert.match(output, /<w:u w:val="single"\/>/);
});

test('replace locates visible text without counting hidden runs or text boxes', () => {
  const input = '<w:document><w:body><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>姓名</w:t></w:r><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r><w:r><w:t>姓名</w:t></w:r></w:p></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'replace', at: 'p:0', find: '姓名', value: '名称' }]);
  assert.match(output, /<w:vanish\/><\/w:rPr><w:t>姓名<\/w:t>/);
  assert.match(output, /<w:txbxContent>.*<w:t>姓名<\/w:t>/);
  assert.match(output, /名称/);
});

test('cross-run replacement handles entities, tabs and soft line breaks', () => {
  const input = '<w:document xmlns:w="word"><w:body><w:p><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>😀&#91;</w:t><w:tab/></w:r><w:r><w:t>姓名&#93;后</w:t></w:r></w:p></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'replace', at: 'p:0', find: '[\t姓名]', value: '张\n三', yellow: true }]);
  assert.equal(editableText(output), '😀张\n三后');
  assert.match(output, /<w:highlight w:val="yellow"\/>/);
  assert.match(output, /<w:u w:val="single"\/>/);
  assert.doesNotThrow(() => new SaxesParser({ xmlns: true }).write(output).close());
});

test('check changes only the symbol adjacent to the requested option', () => {
  const input = '<w:document><w:body><w:p><w:r><w:t>□甲 □乙</w:t></w:r></w:p></w:body></w:document>';
  assert.equal(editableText(applyTextBatch(input, [{ op: 'check', at: 'p:0', option: '乙', checked: true }])), '□甲 ☑乙');
  assert.throws(() => applyTextBatch(input, [{ op: 'check', at: 'p:0', option: '不存在', checked: true }]));
});

test('delete uses the batch-start address and mark_pending preserves existing text', () => {
  const input = '<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'delete', at: 'p:0' }, { op: 'mark_pending', at: 'p:1', find: '第二段' }]);
  assert.equal(editableText(output), '第二段');
  assert.match(output, /<w:highlight w:val="yellow"\/>/);
  assert.throws(() => applyTextBatch(input, [{ op: 'delete', at: 'p:5' }]));
});

test('insert_rows preserves row and cell properties and fills cloned values', () => {
  const input = '<w:document><w:body><w:tbl><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="100"/></w:tcPr><w:p><w:pPr/><w:r><w:rPr><w:b/></w:rPr><w:t>示例</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'replace', rows: [['一'], ['二']], yellow: true }]);
  assert.equal((output.match(/<w:tr>/g) ?? []).length, 2);
  assert.equal((output.match(/<w:tcW w:w="100"\/>/g) ?? []).length, 2);
  assert.equal((output.match(/<w:pPr\/>/g) ?? []).length, 2);
  assert.equal((output.match(/<w:highlight w:val="yellow"\/>/g) ?? []).length, 2);
  assert.equal(editableText(output), '一二');
  assert.throws(() => applyTextBatch(input, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['bad', 'extra']] }]));
});

test('copied drawing rows retain images with fresh drawing identifiers', () => {
  const input = '<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:drawing><wp:docPr id="7"/></w:drawing><w:t>示例</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['甲'], ['乙']] }]);
  assert.deepEqual([...output.matchAll(/<wp:docPr id="(\d+)"/g)].map(match => match[1]), ['7', '8', '9']);
  assert.equal((output.match(/<w:drawing>/g) ?? []).length, 3);
});

test('insert adds Markdown blocks without replacing the anchor', () => {
  const input = '<w:document><w:body><w:p><w:pPr/><w:r><w:t>原文</w:t></w:r></w:p></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'insert', at: 'p:0', position: 'after', markdown: '## 方案\n\n正文 **重点**。' }]);
  assert.equal(editableText(output), '原文方案正文 重点。');
  assert.match(output, /<w:b\/>/);
  assert.equal((output.match(/<w:p>/g) ?? []).length, 3);
});

test('text-empty cell retains object and paragraph properties', () => {
  const output = applyTextBatch(xml, [{ op: 'set_cell', at: 't:0/r:0/c:1', value: '资料', yellow: true }]);
  assert.match(output, /<w:drawing\/>/);
  assert.match(output, /<w:pPr\/>/);
  assert.match(output, /<w:b\/>/);
  assert.match(output, /<w:highlight w:val="yellow"\/>/);
  assert.match(output, /资料/);
});

for (const object of ['<w:drawing/>', '<w:pict><v:shape/></w:pict>', '<w:object/>']) test(`set_cell preserves existing ${object}`, () => {
  const input = `<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r>${object}</w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const output = applyTextBatch(input, [{ op: 'set_cell', at: 't:0/r:0/c:0', value: '资料' }]);
  assert.ok(output.includes(object));
  assert.equal(editableText(output), '资料');
  assert.equal((output.match(/<w:p>/g) ?? []).length, 2);
});

test('self-closing cell and run properties can receive a pending value', () => {
  const input = '<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:rPr/><w:t>标签</w:t></w:r></w:p></w:tc><w:tc/></w:tr></w:tbl></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'set_cell', at: 't:0/r:0/c:1', value: '资料', yellow: true }]);
  assert.match(output, /<\/w:tc><w:tc><w:p>/);
  assert.match(output, /<w:highlight w:val="yellow"\/>/);
  assert.match(output, /资料/);
});

test('empty cells inherit nearby column style when their row has no text', () => {
  const input = '<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>上方</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'set_cell', at: 't:0/r:1/c:0', value: '填写' }]);
  assert.match(output, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">填写/);
});

test('batch rejects missing, ambiguous, overlapping and illegal edits', () => {
  for (const bad of [
    [{ op: 'replace', at: 'p:0', find: '不存在', value: 'x' }],
    [{ op: 'replace', at: 'p:0', find: '____', value: 'x' }],
    [{ op: 'set_cell', at: 't:0/r:0/c:0', value: 'x' }],
    [{ op: 'replace', at: 'p:0', find: '姓名', value: '\ud800' }],
    [{ op: 'replace', at: 'p:0', find: '姓名', value: 'x' }, { op: 'replace', at: 'p:0', find: '姓名：', value: 'y' }],
  ] as Parameters<typeof applyTextBatch>[1][]) {
    assert.throws(() => applyTextBatch(xml, bad));
  }
  const batch: Parameters<typeof applyTextBatch>[1] = [
    { op: 'replace', at: 'p:0', find: '姓名：____', value: '姓名：张三' },
    { op: 'set_cell', at: 't:0/r:0/c:0', value: 'invalid' },
  ];
  assert.throws(() => applyTextBatch(xml, batch));
  assert.match(xml, /姓名：/);
  assert.match(xml, /<w:drawing\/>/);
});

test('blank locators select current hint offsets even for identical blank text', () => {
  const output = applyTextBatch(xml, [{ op: 'replace', at: 'p:0', blank: 0, value: '甲' }, { op: 'replace', at: 'p:0', blank: 1, value: '乙' }]);
  assert.equal(editableText(output), '姓名：甲 地址：乙标签');
  const marked = applyTextBatch(xml, [{ op: 'mark_pending', at: 'p:0', blank: 1 }]);
  assert.equal(editableText(marked), editableText(xml));
  assert.equal((marked.match(/w:highlight/g) ?? []).length, 1);
  for (const locator of [{}, { find: '____', blank: 0 }, { blank: -1 }, { blank: 99 }, { blank: 0.5 }, { find: '不存在' }, { find: '____' }]) {
    assert.throws(() => applyTextBatch(xml, [{ op: 'replace', at: 'p:0', find: '姓名', value: '称谓' }, { op: 'replace', at: 'p:0', ...locator, value: '甲' }] as Parameters<typeof applyTextBatch>[1]), /操作\s*2.*建议/);
    assert.throws(() => applyTextBatch(xml, [{ op: 'replace', at: 'p:0', ...locator, value: '甲' }] as Parameters<typeof applyTextBatch>[1]), /操作\s*1.*建议/);
  }
  assert.throws(() => applyTextBatch(xml, [{ op: 'mark_pending', at: 'p:99', find: '甲' }]), /操作\s*1.*建议/);
});

test('mark_pending preserves each original run style and inline object while replace inherits its first style', () => {
  const input = '<w:document><w:body><w:p><w:r><w:rPr><w:b/><w:rFonts w:ascii="Arial"/></w:rPr><w:t>xA</w:t><w:drawing/></w:r><w:r><w:rPr><w:i/><w:sz w:val="30"/></w:rPr><w:t>By</w:t></w:r></w:p></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'mark_pending', at: 'p:0', find: 'AB' }]);
  const runs = [...output.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map(match => match[1]);
  assert.equal(editableText(output), 'xABy');
  assert.ok(runs.some(run => /<w:i\/>/.test(run) && /<w:sz w:val="30"\/>/.test(run) && /yellow/.test(run) && /<w:t[^>]*>B<\/w:t>/.test(run)));
  assert.ok(runs.some(run => /<w:b\/>/.test(run) && /Arial/.test(run) && /yellow/.test(run) && /<w:t[^>]*>A<\/w:t>/.test(run)));
  assert.equal((output.match(/<w:drawing\/>/g) ?? []).length, 1);
  assert.ok(runs.filter(run => /<w:t[^>]*>[xy]<\/w:t>/.test(run)).every(run => !/yellow/.test(run)));
  const replaced = applyTextBatch(input, [{ op: 'replace', at: 'p:0', find: 'AB', value: '替换' }]);
  assert.match(replaced, /<w:b\/><w:rFonts w:ascii="Arial"\/>[\s\S]*?<w:t[^>]*>替换<\/w:t>/);
});

test('ordinary empty cells reuse their first paragraph and preserve paragraph and neighboring run properties', () => {
  const input = '<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:i/><w:sz w:val="26"/></w:rPr><w:t>邻格</w:t></w:r></w:p></w:tc><w:tc><w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'set_cell', at: 't:0/r:0/c:1', value: '填写' }]);
  assert.equal((output.match(/<w:p>/g) ?? []).length, 2);
  assert.match(output, /<w:jc w:val="center"\/>/);
  assert.match(output, /<w:i\/><w:sz w:val="26"\/>/);
  const empty = input.replace('<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>', '<w:p/>');
  const filled = applyTextBatch(empty, [{ op: 'set_cell', at: 't:0/r:0/c:1', value: '填写' }]);
  assert.equal((filled.match(/<w:p\b/g) ?? []).length, 2);
});

test('row copies preserve VML, OLE objects, bookmark pairs and remap all local identities', () => {
  const input = '<w:document><w:body><w:tbl><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="1200"/><w:tcBorders><w:bottom w:val="single"/></w:tcBorders></w:tcPr><w:p><w:bookmarkStart w:id="4" w:name="Local"/><w:hyperlink w:anchor="Local"><w:r><w:t>示例</w:t></w:r></w:hyperlink><w:r><w:pict><v:shape id="shape1"/></w:pict><w:object><o:OLEObject ObjectID="obj1" ShapeID="shape1" r:id="r1"/></w:object></w:r><w:bookmarkEnd w:id="4"/></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['甲'], ['乙']] }]);
  assert.equal((output.match(/<w:tr>/g) ?? []).length, 3);
  assert.equal((output.match(/<w:pict>/g) ?? []).length, 3);
  assert.equal((output.match(/<w:object>/g) ?? []).length, 3);
  for (const regex of [/<v:shape id="([^"]+)"/g, /ObjectID="([^"]+)"/g, /<w:bookmarkStart w:id="([^"]+)"/g, /w:name="([^"]+)"/g]) {
    const ids = [...output.matchAll(regex)].map(match => match[1]);
    assert.equal(new Set(ids).size, 3);
  }
  const names = [...output.matchAll(/w:name="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...output.matchAll(/w:anchor="([^"]+)"/g)].map(match => match[1]), names);
  assert.deepEqual([...output.matchAll(/<w:bookmarkEnd w:id="([^"]+)"/g)].map(match => match[1]), [...output.matchAll(/<w:bookmarkStart w:id="([^"]+)"/g)].map(match => match[1]));
  assert.deepEqual([...output.matchAll(/ShapeID="([^"]+)"/g)].map(match => match[1]), [...output.matchAll(/<v:shape id="([^"]+)"/g)].map(match => match[1]));
  assert.equal((output.match(/<w:tcW w:w="1200"\/>/g) ?? []).length, 3);
  assert.equal(editableText(output), '示例甲乙');
});

test('shared target resolver follows formatted-space and empty-cell view hint numbering', () => {
  const input = '<w:document><w:body><w:p><w:r><w:t>甲</w:t></w:r><w:r><w:rPr><w:u/></w:rPr><w:t xml:space="preserve">  </w:t></w:r><w:r><w:t>乙____</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:drawing/></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  assert.deepEqual(resolveTextTarget(input, { at: 'p:0', blank: 0 }), { find: '  ', start: 1, end: 3 });
  assert.deepEqual(resolveTextTarget(input, { at: 'p:0', blank: 1 }), { find: '____', start: 4, end: 8 });
  assert.deepEqual(resolveTextTarget(input, { at: 't:0/r:0/c:0', blank: 0 }), { find: '', start: 0, end: 0 });
  const filled = applyTextBatch(input, [{ op: 'replace', at: 't:0/r:0/c:0', blank: 0, value: '填入' }]);
  assert.equal(editableText(filled), '甲  乙____填入');
  assert.throws(() => resolveTextTarget(input, { at: 't:0/r:0/c:1', blank: 0 }), /提示序号无效/);
});

test('mark_pending keeps native controls, entities, hidden runs and object text outside the visible target', () => {
  const hidden = '<w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏</w:t></w:r>';
  const object = '<w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>图内</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r>';
  const input = `<w:document xmlns:w="word"><w:body><w:p><w:r w:rsidR="00112233"><w:rPr><w:b/></w:rPr><w:t>xA</w:t><w:tab/></w:r>${hidden}${object}<w:r><w:rPr><w:i/></w:rPr><w:t>B</w:t><w:br w:type="textWrapping"/><w:t>&amp;Cy</w:t></w:r></w:p></w:body></w:document>`;
  const output = applyTextBatch(input, [{ op: 'mark_pending', at: 'p:0', find: 'A\tB\n&C' }]);
  assert.equal(editableText(output), 'xA\tB\n&Cy');
  assert.ok(output.includes(hidden));
  assert.ok(output.includes(object));
  assert.equal((output.match(/<w:tab\/>/g) ?? []).length, 1);
  assert.equal((output.match(/<w:br w:type="textWrapping"\/>/g) ?? []).length, 1);
  const runs = [...output.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)].map(match => match[1]);
  assert.ok(runs.some(run => /yellow/.test(run) && /<w:b\/>/.test(run) && /<w:tab\/>/.test(run)));
  assert.ok(runs.some(run => /yellow/.test(run) && /<w:i\/>/.test(run) && /<w:br /.test(run)));
  assert.ok(runs.filter(run => /<w:t[^>]*>[xy]<\/w:t>/.test(run)).every(run => !/yellow/.test(run)));
  assert.doesNotThrow(() => new SaxesParser({ xmlns: true }).write(output).close());
});

test('multiple row copies share drawing, paragraph and content-control identity pools', () => {
  const row = '<w:tr><w:tc><w:sdt><w:sdtPr><w:id w:val="12"/></w:sdtPr><w:sdtContent><w:p w14:paraId="0000000A" w14:textId="0000000B"><w:bookmarkStart w:id="1" w:name="Local"/><w:r><w:drawing><wp:docPr id="7"/><pic:cNvPr id="8"/></w:drawing><w:t>示例</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p></w:sdtContent></w:sdt></w:tc></w:tr>';
  const second = row.replaceAll('="1"', '="2"').replace('Local', 'Other').replaceAll('0000000A', '0000000C').replaceAll('0000000B', '0000000D').replace('="7"', '="9"').replace('="8"', '="10"').replace('="12"', '="13"');
  const input = `<w:document><w:body><w:tbl>${row}${second}</w:tbl></w:body></w:document>`;
  const output = applyTextBatch(input, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['甲']] }, { op: 'insert_rows', at: 't:0/r:1', mode: 'after', rows: [['乙']] }]);
  for (const regex of [/<(?:wp:docPr|pic:cNvPr) id="(\d+)"/g, /w14:(?:paraId|textId)="([^"]+)"/g, /<w:id w:val="([^"]+)"/g, /<w:bookmarkStart w:id="([^"]+)"/g]) {
    const ids = [...output.matchAll(regex)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
  }
  const crossRow = input.replace('<w:bookmarkEnd w:id="1"/>', '');
  assert.throws(() => applyTextBatch(crossRow, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['甲']] }]), /操作 1.*完整标记/);
});

test('copied VML shapes keep shared id and spid references consistent', () => {
  const input = '<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:pict><v:shapetype id="type1"/><v:shape id="shape1" o:spid="shape1" type="#type1"/></w:pict><w:object><o:OLEObject ShapeID="shape1" r:id="r1"/></w:object><w:t>示例</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const output = applyTextBatch(input, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['甲']] }]);
  const shapes = [...output.matchAll(/<v:shape id="([^"]+)" o:spid="([^"]+)" type="#([^"]+)"/g)];
  assert.ok(shapes.every(match => match[1] === match[2]));
  assert.deepEqual(shapes.map(match => match[1]), [...output.matchAll(/ShapeID="([^"]+)"/g)].map(match => match[1]));
  assert.deepEqual(shapes.map(match => match[3]), [...output.matchAll(/<v:shapetype id="([^"]+)"/g)].map(match => match[1]));
});

test('delete rejects table-merging paragraph removal in final batch state while allowing safe restructuring', () => {
  const mkTbl = (label: string) => `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>${label}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  const mkP = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const wrap = (body: string) => `<w:document><w:body>${body}<w:sectPr/></w:body></w:document>`;

  // 1. Deleting sole separating paragraph between 2 tables -> rejected
  const oneSepDoc = wrap(`${mkTbl('表一')}${mkP('分隔段')}${mkTbl('表二')}`);
  assert.throws(() => applyTextBatch(oneSepDoc, [{ op: 'delete', at: 'p:0' }]), /操作 1.*合并/);

  // 2. Deleting ALL 2 empty separating paragraphs between 2 tables -> rejected (attributed to second delete)
  const twoSepDoc = wrap(`${mkTbl('表一')}${mkP('')}${mkP('')}${mkTbl('表二')}`);
  assert.throws(() => applyTextBatch(twoSepDoc, [{ op: 'delete', at: 'p:0' }, { op: 'delete', at: 'p:1' }]), /操作 2.*合并/);

  // 3. Deleting 1 of 2 separating paragraphs -> allowed
  const keptOne = applyTextBatch(twoSepDoc, [{ op: 'delete', at: 'p:0' }]);
  assert.equal(editableText(keptOne), '表一表二');
  assert.equal((keptOne.match(/<w:tbl>/g) ?? []).length, 2);

  // 4. Deleting sole separating paragraph AND either adjacent table in same batch -> allowed
  const delTrailingTbl = applyTextBatch(oneSepDoc, [{ op: 'delete', at: 'p:0' }, { op: 'delete', at: 't:1' }]);
  assert.equal(editableText(delTrailingTbl), '表一');
  const delLeadingTbl = applyTextBatch(oneSepDoc, [{ op: 'delete', at: 't:0' }, { op: 'delete', at: 'p:0' }]);
  assert.equal(editableText(delLeadingTbl), '表二');

  // 5. Deleting sole separating paragraph AND inserting a separating paragraph -> allowed; inserting a table instead -> rejected
  const replacedWithPara = applyTextBatch(oneSepDoc, [
    { op: 'delete', at: 'p:0' },
    { op: 'insert', at: 't:0', position: 'after', markdown: '新分隔段' },
  ]);
  assert.equal(editableText(replacedWithPara), '表一新分隔段表二');
  assert.throws(
    () =>
      applyTextBatch(oneSepDoc, [
        { op: 'delete', at: 'p:0' },
        { op: 'insert', at: 't:0', position: 'after', markdown: '| 新列 |\n| --- |\n| 新格 |' },
      ]),
    /操作 1.*合并/,
  );

  // 6. Nested tables inside a cell with sole separating paragraph deleted -> rejected
  const nestedDoc = wrap(`<w:tbl><w:tr><w:tc>${mkTbl('内表一')}${mkP('内分隔')}${mkTbl('内表二')}</w:tc></w:tr></w:tbl>`);
  assert.throws(() => applyTextBatch(nestedDoc, [{ op: 'delete', at: 't:0/r:0/c:0/p:0' }]), /操作 1.*合并/);

  // 7. Dirty pre-existing adjacent tables + unrelated paragraph delete -> allowed
  const dirtyDoc = wrap(`${mkTbl('原相邻表1')}${mkTbl('原相邻表2')}${mkP('无关末尾段')}`);
  const dirtyCleaned = applyTextBatch(dirtyDoc, [{ op: 'delete', at: 'p:0' }]);
  assert.equal(editableText(dirtyCleaned), '原相邻表1原相邻表2');

  // 8. insert_toc ordering relative to same-anchor insert(table): A -> TOC -> X -> B leaves X and B merged -> rejected; TOC before B -> allowed
  const tocDoc = wrap(`${mkTbl('表A')}${mkP('待删分隔')}${mkTbl('表B')}<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>一、章节</w:t></w:r></w:p>`);
  assert.throws(
    () =>
      applyTextBatch(tocDoc, [
        { op: 'delete', at: 'p:0' },
        { op: 'insert', at: 't:0', position: 'after', markdown: '| 新 |\n| --- |\n| X |' },
        { op: 'insert_toc', at: 't:0', position: 'after' },
      ]),
    /操作 1.*合并/,
  );
  const validTocSep = applyTextBatch(tocDoc, [
    { op: 'delete', at: 'p:0' },
    { op: 'insert', at: 't:0', position: 'after', markdown: '| 新 |\n| --- |\n| X |' },
    { op: 'insert_toc', at: 't:1', position: 'before' },
  ]);
  assert.match(editableText(validTocSep), /一、章节/);

  // 9. w:sdt wrapping a kept separating paragraph prevents false table-merge rejection (body & cell); w:sdt wrapping a table without kept paragraph still rejects
  const sdtBodyKeep = wrap(`${mkTbl('表A')}${mkP('待删')}<w:sdt><w:sdtContent>${mkP('控件分隔')}</w:sdtContent></w:sdt>${mkTbl('表B')}`);
  assert.equal(editableText(applyTextBatch(sdtBodyKeep, [{ op: 'delete', at: 'p:0' }])), '表A控件分隔表B');

  const sdtCellKeep = wrap(`<w:tbl><w:tr><w:tc>${mkTbl('内表A')}${mkP('待删')}<w:sdt><w:sdtContent>${mkP('内控件分隔')}</w:sdtContent></w:sdt>${mkTbl('内表B')}</w:tc></w:tr></w:tbl>`);
  assert.equal(editableText(applyTextBatch(sdtCellKeep, [{ op: 'delete', at: 't:0/r:0/c:0/p:0' }])), '内表A内控件分隔内表B');

  const sdtTblMerge = wrap(`${mkTbl('表A')}${mkP('待删')}<w:sdt><w:sdtContent>${mkTbl('控件表')}</w:sdtContent></w:sdt>`);
  assert.throws(() => applyTextBatch(sdtTblMerge, [{ op: 'delete', at: 'p:0' }]), /操作 1.*合并/);
});

test('delete protects section-break carrier paragraphs by default while allowing explicit opt-in and ignoring pPrChange', async () => {
  const doc =
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:pPr><w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/></w:sectPr></w:pPr><w:r><w:t>分节段</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pPrChange w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"><w:pPr><w:sectPr/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>仅历史修订含分节</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>末段</w:t></w:r></w:p>' +
    '<w:sectPr/></w:body></w:document>';

  // 1. Deleting active section-break paragraph without flag -> rejected with guidance
  assert.throws(
    () => applyTextBatch(doc, [{ op: 'delete', at: 'p:0' }]),
    /操作 1.*分节符（w:sectPr）.*replace.*allowDeleteSectionBreak: true/,
  );

  // 2. Deleting same paragraph with allowDeleteSectionBreak: true -> allowed
  const deletedSect = applyTextBatch(doc, [{ op: 'delete', at: 'p:0', allowDeleteSectionBreak: true }]);
  assert.equal(editableText(deletedSect), '仅历史修订含分节末段');
  assert.doesNotMatch(deletedSect, /orient="landscape"/);

  // 3. Historical w:pPrChange/w:sectPr does not count as active section break
  const deletedRevisionOnly = applyTextBatch(doc, [{ op: 'delete', at: 'p:1' }]);
  assert.equal(editableText(deletedRevisionOnly), '分节段末段');

  // 4. Non-boolean allowDeleteSectionBreak -> rejected
  assert.throws(
    () => applyTextBatch(doc, [{ op: 'delete', at: 'p:2', allowDeleteSectionBreak: 'yes' as unknown as boolean } satisfies TextBatchEdit]),
    /操作 1.*布尔值/,
  );

  // 5. editBidDraft forwarding test (allowlist + pass-through + type validation)
  const enc = (s: string) => new TextEncoder().encode(s);
  const base = await writeZip(
    new Map([
      ['[Content_Types].xml', enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')],
      ['word/document.xml', enc(doc)],
    ]),
  );
  const ledger: BidLedger = {
    format: 'seal-ledger-1',
    fills: [],
    pending: [],
    dismissals: [],
    acceptedChanges: [],
    requirements: [],
    drafts: { bid: sha256Hex(base) },
    bases: { bid: sha256Hex(base) },
  };
  await assert.rejects(
    () => editBidDraft({ name: 'bid', old: base, base, ledger, images: new Map(), markdownImages: new Map(), operations: [{ op: 'delete', at: 'p:0' }] }),
    /分节符（w:sectPr）/,
  );
  await assert.rejects(
    () => editBidDraft({ name: 'bid', old: base, base, ledger, images: new Map(), markdownImages: new Map(), operations: [{ op: 'delete', at: 'p:2', allowDeleteSectionBreak: 1 as unknown as boolean }] }),
    /布尔值/,
  );
  const res = await editBidDraft({
    name: 'bid',
    old: base,
    base,
    ledger,
    images: new Map(),
    markdownImages: new Map(),
    operations: [{ op: 'delete', at: 'p:0', allowDeleteSectionBreak: true }],
  });
  const outXml = new TextDecoder('utf-8', { fatal: true }).decode((await readZip(res.output)).get('word/document.xml')!);
  assert.equal(editableText(outXml), '仅历史修订含分节末段');
});
