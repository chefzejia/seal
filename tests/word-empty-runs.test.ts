import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPort } from '../src/core/host.js';
import { applyTextBatch } from '../src/core/docx/text-batch.js';
import { finalizeDocument } from '../src/core/docx/finalize-document.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';
import { validatePackageStructure } from '../src/core/docx/package-structure.js';
import { editableText, replaceVisibleRange, visibleRunProperties, wrapVisibleRange } from '../src/core/docx/visible-surgery.js';
import { elementChildren, xmlElements } from '../src/core/docx/xml.js';
import { sha256Hex } from '../src/core/docx/zip.js';
import { packageDocument } from './fixtures/layout-matrix.js';

const CONTENT_CHILD_NAMES = new Set([
  'w:tab',
  'w:br',
  'w:cr',
  'w:drawing',
  'w:pict',
  'w:object',
  'w:fldChar',
  'w:instrText',
  'w:sym',
  'w:noBreakHyphen',
  'w:softHyphen',
]);

function inspectRuns(xml: string) {
  const elements = xmlElements(xml);
  const children = elementChildren(elements);
  const emptyRuns: string[] = [];
  const yellowRuns: string[] = [];
  const yellowEmptyRuns: string[] = [];
  for (const [index, element] of elements.entries()) {
    if (element.name !== 'w:r') continue;
    const runXml = xml.slice(element.start, element.end);
    let hasContent = false;
    let hasYellow = false;
    for (const childIndex of children[index]) {
      const child = elements[childIndex];
      if (child.name === 'w:rPr') {
        if (/<w:highlight\b[^>]*\bw:val=["']yellow["']/.test(xml.slice(child.start, child.end))) {
          hasYellow = true;
        }
        continue;
      }
      if (child.name === 'w:t') {
        if (child.openEnd < child.closeStart) hasContent = true;
        continue;
      }
      if (CONTENT_CHILD_NAMES.has(child.name) || child.name !== 'w:t') {
        hasContent = true;
      }
    }
    if (!hasContent) emptyRuns.push(runXml);
    if (hasYellow) yellowRuns.push(runXml);
    if (hasYellow && !hasContent) yellowEmptyRuns.push(runXml);
  }
  return { emptyRuns, yellowRuns, yellowEmptyRuns };
}

test('wrapVisibleRange and replaceVisibleRange never emit empty shell runs on boundary or multi-token edits', () => {
  const yellowRun = '<w:p><w:r><w:rPr><w:b/><w:highlight w:val="yellow"/></w:rPr><w:t>甲乙</w:t></w:r></w:p>';
  const wrapped = wrapVisibleRange(yellowRun, 0, 2, '_Seal_P_1', 11);
  assert.equal(editableText(wrapped), '甲乙');
  assert.deepEqual(inspectRuns(wrapped).emptyRuns, []);
  assert.deepEqual(inspectRuns(wrapped).yellowEmptyRuns, []);
  assert.equal(wrapped, '<w:p><w:bookmarkStart w:id="11" w:name="_Seal_P_1"/><w:r><w:rPr><w:b/><w:highlight w:val="yellow"/></w:rPr><w:t>甲乙</w:t></w:r><w:bookmarkEnd w:id="11"/></w:p>');

  const withSiblings = '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:tab/><w:t>甲乙</w:t><w:br/></w:r></w:p>';
  const wrappedInner = wrapVisibleRange(withSiblings, 1, 3, '_Seal_P_2', 12);
  assert.equal(editableText(wrappedInner), '\t甲乙\n');
  assert.deepEqual(inspectRuns(wrappedInner).emptyRuns, []);
  assert.equal(sealRanges(wrappedInner)[0].text, '甲乙');

  const replacedFull = replaceVisibleRange(yellowRun, 0, 2, '新值', false);
  assert.equal(editableText(replacedFull), '新值');
  assert.deepEqual(inspectRuns(replacedFull).emptyRuns, []);

  const multiTokenSameRun = '<w:p><w:r><w:rPr><w:i/><w:highlight w:val="yellow"/></w:rPr><w:t>前甲</w:t><w:tab/><w:t>乙后</w:t></w:r></w:p>';
  const replacedMiddle = replaceVisibleRange(multiTokenSameRun, 1, 4, '替换', true);
  assert.equal(editableText(replacedMiddle), '前替换后');
  assert.deepEqual(inspectRuns(replacedMiddle).emptyRuns, []);
  assert.deepEqual(inspectRuns(replacedMiddle).yellowEmptyRuns, []);

  const deletedFull = replaceVisibleRange(yellowRun, 0, 2, '', false);
  assert.equal(editableText(deletedFull), '');
  assert.deepEqual(inspectRuns(deletedFull).emptyRuns, []);
});

test('replace + mark_pending + cross-run edit + manual modify + finalizeDocument leaves zero Seal markers and zero empty or stray yellow runs', async () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const body =
    '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>原件保留黄标</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>报价：____元</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>工期：待</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>定天数</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>质保期：二年</w:t></w:r></w:p>';
  const base = await packageDocument(body);
  const baseXml = decoder.decode((await validatePackageStructure(base)).get('word/document.xml')!);

  // 1. replace with yellow + seal, cross-run replace, and mark_pending
  const step1Xml = applyTextBatch(baseXml, [
    { op: 'replace', at: 'p:1', find: '____', value: '100', yellow: true, seal: { name: '_Seal_P_p1', id: 21 } },
    { op: 'replace', at: 'p:2', find: '待定', value: '30', yellow: true, seal: { name: '_Seal_P_p2', id: 22 } },
    { op: 'mark_pending', at: 'p:3', find: '二年', seal: { name: '_Seal_P_p3', id: 23 } },
  ]);
  assert.deepEqual(inspectRuns(step1Xml).emptyRuns, []);
  assert.deepEqual(inspectRuns(step1Xml).yellowEmptyRuns, []);

  // 2. manual in-place modify on pending items (full value and partial value)
  const step2Xml = applyTextBatch(step1Xml, [
    { op: 'replace', at: 'p:1', find: '100', value: '200', yellow: true },
    { op: 'replace', at: 'p:3', find: '二年', value: '三年', yellow: true },
  ]);
  assert.deepEqual(inspectRuns(step2Xml).emptyRuns, []);
  assert.deepEqual(inspectRuns(step2Xml).yellowEmptyRuns, []);

  const draftParts = await validatePackageStructure(base);
  draftParts.set('word/document.xml', new TextEncoder().encode(step2Xml));
  const { writeZip } = await import('../src/core/docx/zip.js');
  const draft = await writeZip(draftParts);

  const finalized = await finalizeDocument(
    draft,
    base,
    {
      draftSha256: sha256Hex(draft),
      baseSha256: sha256Hex(base),
      marks: [
        { id: 'p1', state: 'confirmed', originalHighlights: [null, null, null] },
        { id: 'p2', state: 'confirmed', originalHighlights: [null, null] },
        { id: 'p3', state: 'confirmed', originalHighlights: [null, null] },
      ],
    },
    {} as HostPort,
  );
  const finalXml = decoder.decode((await validatePackageStructure(finalized)).get('word/document.xml')!);

  assert.equal(finalXml.includes('_Seal_'), false);
  assert.equal(sealRanges(finalXml).length, 0);

  const inspection = inspectRuns(finalXml);
  assert.deepEqual(inspection.emptyRuns, []);
  assert.deepEqual(inspection.yellowEmptyRuns, []);
  // Only the native yellow run from the original document remains yellow.
  assert.equal(inspection.yellowRuns.length, 1);
  assert.match(inspection.yellowRuns[0], /原件保留黄标/);

  assert.equal(editableText(finalXml), '原件保留黄标报价：200元工期：30天数质保期：三年');
  const props = visibleRunProperties(finalXml);
  const quoteStart = editableText(finalXml).indexOf('200');
  assert.ok(props.slice(quoteStart, quoteStart + 3).every((rPr) => rPr.includes('<w:b/>') && !rPr.includes('yellow')));
});

test('replaceVisibleRange replaces thousands of fragmented runs in linear time without empty runs', () => {
  const runCount = 4000;
  const fragmentedRuns = Array.from({ length: runCount }, (_, i) => `<w:r><w:t>${String(i % 10)}</w:t></w:r>`).join('');
  const paragraphXml = `<w:p>${fragmentedRuns}</w:p>`;
  const start = performance.now();
  const replaced = replaceVisibleRange(paragraphXml, 0, runCount, '汇总结果', true);
  const elapsedMs = performance.now() - start;
  assert.equal(editableText(replaced), '汇总结果');
  const inspection = inspectRuns(replaced);
  assert.deepEqual(inspection.emptyRuns, []);
  assert.deepEqual(inspection.yellowEmptyRuns, []);
  assert.equal(inspection.yellowRuns.length, 1);
  assert.ok(elapsedMs < 500, `replaceVisibleRange across ${runCount} runs took ${elapsedMs.toFixed(1)}ms`);
});

test('replaceVisibleRange preserves unchanged date separators, inherits blank slot underlines, and never invents underlines', () => {
  const maskFor = (xml: string) => {
    const props = visibleRunProperties(xml);
    return Array.from(editableText(xml)).map((ch, idx) => ({
      ch,
      u: hasU(props[idx] ?? ''),
      yellow: /w:val="yellow"/.test(props[idx] ?? ''),
      b: /<w:b\b/.test(props[idx] ?? ''),
      i: /<w:i\b/.test(props[idx] ?? ''),
    }));
  };
  const hasU = (rPr: string) => /<w:u\b/.test(rPr) && !/<w:u\b[^>]*w:val="none"/.test(rPr);

  const uRun = (t: string) => `<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const pRun = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;

  // 1 & 2. Multi-run underlined date: 2026, 11, 27 get underline; 年, 月, 日 stay plain; yellow: true marks ALL chars yellow
  const dateXml = `<w:p>${uRun('    ')}${pRun('年')}${uRun('  ')}${pRun('月')}${uRun('  ')}${pRun('日')}</w:p>`;
  const datePlain = replaceVisibleRange(dateXml, 0, editableText(dateXml).length, '2026年11月27日', false);
  assert.equal(editableText(datePlain), '2026年11月27日');
  assert.deepEqual(inspectRuns(datePlain).emptyRuns, []);
  assert.deepEqual(maskFor(datePlain).map(m => [m.ch, m.u, m.yellow]), [
    ['2', true, false], ['0', true, false], ['2', true, false], ['6', true, false],
    ['年', false, false],
    ['1', true, false], ['1', true, false],
    ['月', false, false],
    ['2', true, false], ['7', true, false],
    ['日', false, false],
  ]);

  const dateYellow = replaceVisibleRange(dateXml, 0, editableText(dateXml).length, '2026年11月27日', true);
  assert.equal(editableText(dateYellow), '2026年11月27日');
  assert.deepEqual(inspectRuns(dateYellow).emptyRuns, []);
  assert.deepEqual(inspectRuns(dateYellow).yellowEmptyRuns, []);
  assert.deepEqual(maskFor(dateYellow).map(m => [m.ch, m.u, m.yellow]), [
    ['2', true, true], ['0', true, true], ['2', true, true], ['6', true, true],
    ['年', false, true],
    ['1', true, true], ['1', true, true],
    ['月', false, true],
    ['2', true, true], ['7', true, true],
    ['日', false, true],
  ]);

  // 3. Multi-slot date range: all 6 number groups underlined, 年/月/日至/年/月/日 plain
  const rangeXml = `<w:p>${uRun('    ')}${pRun('年')}${uRun('  ')}${pRun('月')}${uRun('  ')}${pRun('日至')}${uRun('    ')}${pRun('年')}${uRun('  ')}${pRun('月')}${uRun('  ')}${pRun('日')}</w:p>`;
  const rangeOut = replaceVisibleRange(rangeXml, 0, editableText(rangeXml).length, '2026年01月01日至2026年12月31日', false);
  assert.equal(editableText(rangeOut), '2026年01月01日至2026年12月31日');
  assert.deepEqual(maskFor(rangeOut).filter(m => !m.u).map(m => m.ch).join(''), '年月日截至'.slice(0, 0) + '年月日至年月日');

  // 4. Label + underlined blank: label stays plain, filled text gets underline
  const labelBlank = `<w:p>${pRun('项目名称：')}${uRun('    ')}</w:p>`;
  const labelOut = replaceVisibleRange(labelBlank, 0, editableText(labelBlank).length, '项目名称：防爆电梯', false);
  assert.equal(editableText(labelOut), '项目名称：防爆电梯');
  assert.deepEqual(maskFor(labelOut).map(m => [m.ch, m.u]), [
    ['项', false], ['目', false], ['名', false], ['称', false], ['：', false],
    ['防', true], ['爆', true], ['电', true], ['梯', true],
  ]);

  // 5. Mixed leading plain space + underlined spaces in single slot -> inherits underline
  const mixedSlot = `<w:p>${pRun(' ')}${uRun('    ')}</w:p>`;
  const mixedOut = replaceVisibleRange(mixedSlot, 0, editableText(mixedSlot).length, '中标公司', false);
  assert.equal(editableText(mixedOut), '中标公司');
  assert.deepEqual(maskFor(mixedOut).every(m => m.u), true);

  // 6. Plain underscores never invent underline
  const plainDate = `<w:p>${pRun('____')}${pRun('年')}${pRun('__')}${pRun('月')}${pRun('__')}${pRun('日')}</w:p>`;
  const plainOut = replaceVisibleRange(plainDate, 0, editableText(plainDate).length, '2026年11月27日', false);
  assert.equal(editableText(plainOut), '2026年11月27日');
  assert.deepEqual(maskFor(plainOut).every(m => !m.u), true);

  // 7. Multi-run highlight clearing (yellow: null with same text) preserves each run style
  const yellowMixed = '<w:p><w:r><w:rPr><w:b/><w:highlight w:val="yellow"/></w:rPr><w:t>甲</w:t></w:r><w:r><w:rPr><w:i/><w:u w:val="single"/><w:highlight w:val="yellow"/></w:rPr><w:t>乙</w:t></w:r></w:p>';
  const cleared = replaceVisibleRange(yellowMixed, 0, 2, '甲乙', null);
  assert.equal(editableText(cleared), '甲乙');
  assert.deepEqual(inspectRuns(cleared).emptyRuns, []);
  assert.deepEqual(maskFor(cleared), [
    { ch: '甲', u: false, yellow: false, b: true, i: false },
    { ch: '乙', u: true, yellow: false, b: false, i: true },
  ]);

  // 8. Partial-range suffix insertion before afterRaw and trailing drawing before afterRaw
  assert.equal(editableText(replaceVisibleRange('<w:p><w:r><w:t>AB</w:t></w:r></w:p>', 0, 1, 'AX', false)), 'AXB');
  const withDrawing = replaceVisibleRange('<w:p><w:r><w:t>AB</w:t></w:r></w:p>', 0, 1, 'A', false, '<w:drawing/>');
  assert.ok(withDrawing.indexOf('<w:drawing/>') > withDrawing.indexOf('A') && withDrawing.indexOf('<w:drawing/>') < withDrawing.indexOf('B'));

  // 9. Surrogate boundary split fails identically with or without entities
  assert.throws(() => replaceVisibleRange('<w:p><w:r><w:t>😀B</w:t></w:r></w:p>', 1, 2, 'X'), /不可拆分/);
  assert.throws(() => replaceVisibleRange('<w:p><w:r><w:t>😀B&amp;</w:t></w:r></w:p>', 1, 2, 'X'), /不可拆分/);

  // 10. Multi-anchor (both leading-entity and no-entity / trailing-entity) scales linearly
  const anchorCount = 4000;
  const bigOrig = `${'_&amp;'.repeat(anchorCount)}_`;
  const bigVal = `${'1&'.repeat(anchorCount)}22`;
  const bigXml = `<w:p><w:r><w:t>${bigOrig}</w:t></w:r>${uRun('_')}</w:p>`;
  const t0 = performance.now();
  const bigOut = replaceVisibleRange(bigXml, 0, editableText(bigXml).length, `${bigVal}33`, false);
  const anchorMs = performance.now() - t0;
  assert.equal(editableText(bigOut), `${bigVal}33`);
  assert.ok(anchorMs < 500, `multi-anchor entity replacement took ${anchorMs.toFixed(1)}ms`);

  const plainAnchors = `${'_,'.repeat(anchorCount * 2)}_`;
  const plainVals = `${'1,'.repeat(anchorCount * 2)}22`;
  const plainBigXml = `<w:p><w:r><w:t>${plainAnchors}</w:t></w:r>${uRun('_')}</w:p>`;
  const t1 = performance.now();
  const plainBigOut = replaceVisibleRange(plainBigXml, 0, editableText(plainBigXml).length, `${plainVals}33`, false);
  const plainMs = performance.now() - t1;
  assert.equal(editableText(plainBigOut), `${plainVals}33`);
  assert.ok(plainMs < 500, `8000 no-entity anchor replacement took ${plainMs.toFixed(1)}ms`);
});

test('applyTextBatch mark_pending highlights thousands of fragmented runs in linear time', () => {
  const runCount = 4000;
  const fragmentedRuns = Array.from({ length: runCount }, (_, i) => `<w:r><w:t>${String(i % 10)}</w:t></w:r>`).join('');
  const docXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${fragmentedRuns}</w:p></w:body></w:document>`;
  const start = performance.now();
  const marked = applyTextBatch(docXml, [
    { op: 'mark_pending', at: 'p:0', span: { start: 0, end: runCount }, seal: { name: '_Seal_P_frag1', id: 7 } },
  ]);
  const elapsedMs = performance.now() - start;
  assert.equal(editableText(marked).length, runCount);
  const inspection = inspectRuns(marked);
  assert.deepEqual(inspection.emptyRuns, []);
  assert.deepEqual(inspection.yellowEmptyRuns, []);
  assert.equal(inspection.yellowRuns.length, runCount);
  assert.equal(sealRanges(marked).length, 1);
  assert.ok(elapsedMs < 1000, `applyTextBatch mark_pending across ${runCount} runs took ${elapsedMs.toFixed(1)}ms`);
});
