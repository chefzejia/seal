import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTextBatch } from '../src/core/docx/text-batch.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';
import { editableText, wrapVisibleRange } from '../src/core/docx/visible-surgery.js';

const document = (text: string) => `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

test('a replacement covering adjacent repeated ranges removes each old identity', () => {
  let xml = document('甲值值值乙');
  xml = wrapVisibleRange(xml, 1, 2, '_Seal_P_a', 1);
  xml = wrapVisibleRange(xml, 2, 3, '_Seal_P_b', 2);
  xml = wrapVisibleRange(xml, 3, 4, '_Seal_P_c', 3);
  const edited = applyTextBatch(xml, [{ op: 'replace', at: 'p:0', find: '值值值', value: '全新' }]);
  assert.equal(editableText(edited), '甲全新乙');
  assert.deepEqual(sealRanges(edited).map(item => [item.name, item.text]), []);
  const onlyMiddle = applyTextBatch(xml, [{ op: 'replace', at: 'p:0', find: '值值值乙', value: '另文' }]);
  assert.equal(editableText(onlyMiddle), '甲另文');
  assert.deepEqual(sealRanges(onlyMiddle), []);
});

test('partial edits on either edge reject while a contained Unicode edit retains identity', () => {
  const xml = wrapVisibleRange(document('前😀甲乙后'), 1, 5, '_Seal_P_a', 5);
  for (const find of ['前😀', '乙后']) assert.throws(() => applyTextBatch(xml, [{ op: 'replace', at: 'p:0', find, value: '变' }]), /部分交叉/);
  const edited = applyTextBatch(xml, [{ op: 'replace', at: 'p:0', find: '😀', value: '😁' }]);
  assert.equal(editableText(edited), '前😁甲乙后');
  assert.equal(sealRanges(edited)[0].text, '😁甲乙');
  assert.equal(sealRanges(edited)[0].name, '_Seal_P_a');
});
