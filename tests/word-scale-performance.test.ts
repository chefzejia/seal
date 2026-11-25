import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPort } from '../src/core/host.js';
import { auditSealPending } from '../src/core/docx/pending-audit.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';
import { finalizeDocument, type FinalizeMark } from '../src/core/docx/finalize-document.js';
import { editableText, visibleRunProperties } from '../src/core/docx/visible-surgery.js';
import { xmlElements } from '../src/core/docx/xml.js';
import { readZip, sha256Hex, writeZip } from '../src/core/docx/zip.js';

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

async function buildDocx(documentXml: string): Promise<Uint8Array> {
  return writeZip(new Map([
    [
      '[Content_Types].xml',
      enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    ],
    [
      '_rels/.rels',
      enc('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    ],
    ['word/document.xml', enc(documentXml)],
  ]));
}

test('large-document sealRanges, auditSealPending and finalizeDocument scale linearly within budget', async (t) => {
  const paragraphCount = 1500;
  const pendingCount = 40;
  const pendingIndices = new Map<number, number>();
  for (let i = 0; i < pendingCount; i++) {
    pendingIndices.set(i * 35 + 5, i);
  }

  const baseParagraphs: string[] = [];
  const draftParagraphs: string[] = [];
  const names: string[] = [];
  const marks: FinalizeMark[] = [];

  for (let p = 0; p < paragraphCount; p++) {
    const pendingIdx = pendingIndices.get(p);
    baseParagraphs.push(
      `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>第${p}段：</w:t></w:r><w:r><w:t>${pendingIdx !== undefined ? '____' : `正文内容编号${p}`}</w:t></w:r></w:p>`,
    );
    if (pendingIdx !== undefined) {
      const id = `p${pendingIdx}`;
      const name = `_Seal_P_${id}`;
      const value = `待定参数${pendingIdx}`;
      names.push(name);
      marks.push({
        id,
        state: 'confirmed',
        originalHighlights: Array<string | null>(value.length).fill(null),
      });
      draftParagraphs.push(
        `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>第${p}段：</w:t></w:r><w:bookmarkStart w:id="${100 + pendingIdx}" w:name="${name}"/><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>${value}</w:t></w:r><w:bookmarkEnd w:id="${100 + pendingIdx}"/></w:p>`,
      );
    } else {
      draftParagraphs.push(baseParagraphs[baseParagraphs.length - 1]);
    }
  }

  const baseXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${baseParagraphs.join('')}<w:sectPr><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const draftXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${draftParagraphs.join('')}<w:sectPr><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const elementCount = xmlElements(draftXml).length;
  assert.ok(elementCount >= 12_000, `expected >= 12000 elements, got ${elementCount}`);

  const baseBytes = await buildDocx(baseXml);
  const draftBytes = await buildDocx(draftXml);

  // Deliberately remove yellow highlight from one pending range as negative control.
  const brokenXml = draftXml.replace(
    `<w:bookmarkStart w:id="119" w:name="_Seal_P_p19"/><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr>`,
    `<w:bookmarkStart w:id="119" w:name="_Seal_P_p19"/><w:r><w:rPr/>`,
  );

  const startedAt = performance.now();

  const ranges = sealRanges(draftXml);
  assert.equal(ranges.length, pendingCount);
  assert.equal(ranges[0].name, '_Seal_P_p0');
  assert.equal(ranges[0].text, '待定参数0');
  assert.equal(ranges[39].name, '_Seal_P_p39');
  assert.equal(ranges[39].text, '待定参数39');

  const cleanAudit = auditSealPending(draftXml, names);
  assert.deepEqual(cleanAudit, []);

  const brokenAudit = auditSealPending(brokenXml, names);
  assert.deepEqual(brokenAudit, [{ id: '_Seal_P_p19', reason: '待定范围内文字缺少黄色高亮' }]);

  const finalizedBytes = await finalizeDocument(
    draftBytes,
    baseBytes,
    {
      draftSha256: sha256Hex(draftBytes),
      baseSha256: sha256Hex(baseBytes),
      marks,
    },
    {} as HostPort,
  );

  const elapsedMs = performance.now() - startedAt;
  t.diagnostic(`elements=${elementCount}, pending=${pendingCount}, elapsedMs=${elapsedMs.toFixed(1)}`);
  assert.ok(elapsedMs < 1500, `expected total elapsed < 1500 ms, got ${elapsedMs.toFixed(1)} ms`);

  const finalXml = dec((await readZip(finalizedBytes)).get('word/document.xml')!);
  assert.deepEqual(sealRanges(finalXml), []);
  assert.ok(!finalXml.includes('w:val="yellow"'));
  assert.ok(finalXml.includes('待定参数0'));
  assert.ok(finalXml.includes('待定参数39'));
  assert.ok(finalXml.includes('正文内容编号1499'));
});

test('very long single run (150,000 chars) avoids call stack overflow in pending audit and visible properties', () => {
  const longText = '甲'.repeat(150_000);
  const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:bookmarkStart w:id="1" w:name="_Seal_P_big"/><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>${longText}</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p></w:body></w:document>`;

  const ranges = sealRanges(xml);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].text.length, 150_000);
  assert.equal(editableText(xml).length, 150_000);
  assert.deepEqual(auditSealPending(xml, ['_Seal_P_big']), []);
  assert.equal(visibleRunProperties(xml).length, 150_000);

  const missingHighlightXml = xml.replace('<w:highlight w:val="yellow"/>', '');
  assert.deepEqual(auditSealPending(missingHighlightXml, ['_Seal_P_big']), [
    { id: '_Seal_P_big', reason: '待定范围内文字缺少黄色高亮' },
  ]);
});
