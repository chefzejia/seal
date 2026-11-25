import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeRelation, sealRanges } from '../src/core/docx/seal-ranges.js';
import { editableText, visibleRunProperties, wrapVisibleRange } from '../src/core/docx/visible-surgery.js';
import { applyTextBatch } from '../src/core/docx/text-batch.js';
import { auditSealPending } from '../src/core/docx/pending-audit.js';

test('paired hidden bookmarks preserve exact visible text and formatting across runs', () => {
  const input = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>前甲</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>乙后</w:t></w:r></w:p>';
  const output = wrapVisibleRange(input, 1, 3, '_Seal_P_abc', 31);
  assert.equal(editableText(output), '前甲乙后');
  assert.deepEqual(visibleRunProperties(output), visibleRunProperties(input));
  const [range] = sealRanges(output);
  assert.equal(range.name, '_Seal_P_abc');
  assert.equal(range.text, '甲乙');
  assert.deepEqual([range.start, range.end], [1, 3]);
});

test('edits distinguish contained, exact, covering, partial and disjoint ranges', () => {
  for (const [start, end, expected] of [[3, 4, 'inside'], [2, 5, 'inside'], [1, 6, 'cover'], [2, 6, 'cover'], [1, 5, 'cover'], [1, 3, 'partial'], [4, 6, 'partial'], [0, 2, 'disjoint'], [5, 7, 'disjoint']] as const) {
    assert.equal(rangeRelation({ start: 2, end: 5 }, start, end), expected, `${start}:${end}`);
  }
});

test('Seal bookmarks cannot overlap, nest or omit an end marker', () => {
  const input = '<w:p><w:r><w:t>前甲乙后</w:t></w:r></w:p>';
  const first = wrapVisibleRange(input, 1, 3, '_Seal_P_abc', 31);
  assert.throws(() => sealRanges(wrapVisibleRange(first, 2, 4, '_Seal_F_def', 32)), /交叉|嵌套/);
  assert.throws(() => sealRanges(first.replace('<w:bookmarkEnd w:id="31"/>', '')), /缺少结束/);
});

test('Seal bookmarks reject ambiguous or out-of-order Word bookmark identifiers', () => {
  const marked = wrapVisibleRange('<w:p><w:r><w:t>甲乙</w:t></w:r></w:p>', 0, 2, '_Seal_P_abc', 31);
  const duplicateStart = marked.replace('<w:bookmarkStart w:id="31"', '<w:bookmarkStart w:id="31" w:name="other"/><w:bookmarkStart w:id="31"');
  const duplicateEnd = marked.replace('<w:bookmarkEnd w:id="31"/>', '<w:bookmarkEnd w:id="31"/><w:bookmarkEnd w:id="31"/>');
  const earlyEnd = marked.replace('<w:bookmarkStart w:id="31"', '<w:bookmarkEnd w:id="31"/><w:bookmarkStart w:id="31"');
  const missingId = marked.replace('w:id="31" w:name="_Seal_P_abc"', 'w:name="_Seal_P_abc"');
  for (const xml of [duplicateStart, duplicateEnd, earlyEnd, missingId]) assert.throws(() => sealRanges(xml), /书签/);
});

test('edit batch retains equal and inner ranges, removes covered ranges and rejects partial overlap', () => {
  const document = '<w:document><w:body><w:p><w:r><w:t>前甲乙后</w:t></w:r></w:p></w:body></w:document>';
  const marked = wrapVisibleRange(document, 1, 3, '_Seal_P_a', 31);
  const exact = applyTextBatch(marked, [{ op: 'replace', at: 'p:0', find: '甲乙', value: '新值' }]);
  assert.equal(sealRanges(exact)[0].text, '新值');
  assert.equal(sealRanges(exact)[0].name, '_Seal_P_a');
  const extended = applyTextBatch(marked, [{ op: 'replace', at: 'p:0', find: '甲乙', value: '甲乙丙' }]);
  assert.equal(sealRanges(extended)[0].text, '甲乙丙');
  const inner = applyTextBatch(marked, [{ op: 'replace', at: 'p:0', find: '甲', value: '新' }]);
  assert.equal(sealRanges(inner)[0].text, '新乙');
  const empty = applyTextBatch(marked, [{ op: 'replace', at: 'p:0', find: '甲乙', value: '' }]);
  assert.equal(sealRanges(empty)[0].text, '');
  assert.equal(sealRanges(empty)[0].name, '_Seal_P_a');
  const covered = applyTextBatch(marked, [{ op: 'replace', at: 'p:0', find: '前甲乙', value: '整段' }]);
  assert.deepEqual(sealRanges(covered), []);
  assert.throws(() => applyTextBatch(marked, [{ op: 'replace', at: 'p:0', find: '前甲', value: '修改' }]), /部分交叉/);
  assert.equal(sealRanges(marked)[0].text, '甲乙');
});

test('marking and filling create the requested document-owned pending range', () => {
  const doc = '<w:document><w:body><w:p><w:r><w:t>姓名：____</w:t></w:r></w:p></w:body></w:document>';
  const marked = applyTextBatch(doc, [{ op: 'mark_pending', at: 'p:0', find: '____', seal: { name: '_Seal_P_1', id: 51 } }]);
  assert.equal(sealRanges(marked)[0].text, '____');
  const filled = applyTextBatch(doc, [{ op: 'replace', at: 'p:0', find: '____', value: '甲公司', yellow: true, seal: { name: '_Seal_P_2', id: 52 } }]);
  assert.equal(sealRanges(filled)[0].text, '甲公司');
  assert.equal(sealRanges(filled)[0].name, '_Seal_P_2');
  assert.deepEqual(auditSealPending(filled, ['_Seal_P_2']), []);
  assert.equal(auditSealPending(filled, ['_Seal_P_missing']).length, 1);
  assert.equal(auditSealPending(filled.replaceAll('w:val="yellow"', 'w:val="green"'), ['_Seal_P_2']).length, 1);
});

test('mark_pending supports a unique find spanning paragraphs inside one cell', () => {
  const input = '<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const marked = applyTextBatch(input, [{ op: 'mark_pending', at: 't:0/r:0/c:0', find: '甲乙', seal: { name: '_Seal_P_cross', id: 54 } }]);
  const [range] = sealRanges(marked);
  assert.deepEqual([range.start, range.end, range.text], [0, 2, '甲乙']);
  assert.deepEqual(auditSealPending(marked, ['_Seal_P_cross']), []);
  const replaced = applyTextBatch(marked, [{ op: 'replace', at: 't:0/r:0/c:0', find: '甲乙', value: '新值' }]);
  assert.equal(sealRanges(replaced)[0].text, '新值');
});

test('pending audit ignores historical yellow inside w:rPrChange', () => {
  const input = '<w:document><w:body><w:p><w:r><w:rPr><w:rPrChange><w:rPr><w:highlight w:val="yellow"/></w:rPr></w:rPrChange></w:rPr><w:t>原文</w:t></w:r></w:p></w:body></w:document>';
  const marked = wrapVisibleRange(input, 0, 2, '_Seal_P_history', 55);
  assert.equal(auditSealPending(marked, ['_Seal_P_history']).length, 1);
  const current = marked.replace('<w:bookmarkStart w:id="55" w:name="_Seal_P_history"/><w:r><w:rPr><w:rPrChange>', '<w:bookmarkStart w:id="55" w:name="_Seal_P_history"/><w:r><w:rPr><w:highlight w:val="yellow"/><w:rPrChange>');
  assert.deepEqual(auditSealPending(current, ['_Seal_P_history']), []);
});

test('batch edits do not transfer a pending range between identical neighboring text', () => {
  const original = '前缀甲（报价金额）（报价金额）（报价金额）后缀乙';
  const doc = `<w:document><w:body><w:p><w:r><w:t>${original}</w:t></w:r></w:p></w:body></w:document>`;
  const start = original.lastIndexOf('（报价金额）');
  const marked = wrapVisibleRange(doc, start, start + '（报价金额）'.length, '_Seal_P_3', 53);
  const result = applyTextBatch(marked, [
    { op: 'replace', at: 'p:0', find: '前缀甲', value: '序言变更' },
    { op: 'replace', at: 'p:0', blank: 0, value: '100' },
    { op: 'replace', at: 'p:0', find: '后缀乙', value: '结尾变更' },
  ]);
  assert.equal(editableText(result), '序言变更100（报价金额）（报价金额）结尾变更');
  assert.equal(sealRanges(result)[0].text, '（报价金额）');
  assert.equal(sealRanges(result)[0].start, '序言变更100（报价金额）'.length);
});
