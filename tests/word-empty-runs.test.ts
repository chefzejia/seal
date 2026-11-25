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
