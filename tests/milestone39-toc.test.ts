import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { HostPort } from '../src/core/host.js';
import { editBidDraft } from '../src/core/bid/edit.js';
import { checkDraft } from '../src/core/bid/check.js';
import { confirmPending } from '../src/core/bid/human-review.js';
import { finalizeDraftMarkers } from '../src/core/bid/finalize.js';
import { sealLedger } from '../src/core/bid/ledger-integrity.js';
import type { BidLedger, ProjectMetadata } from '../src/core/bid/project.js';
import {
  ensureUpdateFieldsSetting,
  findTopLevelTocFields,
  patchTocPageNumbers,
  readZip,
  resolveTocPageNumbers,
  sha256Hex,
  writeZip,
} from '../src/core/docx/index.js';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { outline } from '../src/core/docx/outline.js';
import { readDocument } from '../src/core/docx/read-document.js';
import { validatePackageStructure } from '../src/core/docx/package-structure.js';
import { xmlElements } from '../src/core/docx/xml.js';
import { findSofficeBinary, NodeHostPort } from '../src/shells/node-host.js';
import { runProject } from '../src/shells/cli/project-v2.js';
import { SEAL_BID_SKILL } from '../src/shells/dsh/seal-bid-skill.js';

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const xmlOf = async (bytes: Uint8Array) => dec((await readZip(bytes)).get('word/document.xml')!);

const DEFAULT_STYLES =
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/></w:style>' +
  '</w:styles>';

const makeDoc = async (
  body: string,
  options: { styles?: string; settings?: string | null; rels?: string | null; section?: string } = {},
) => {
  const parts = new Map<string, Uint8Array>();
  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
  ];
  if (options.settings !== null && options.settings !== undefined) {
    overrides.push(
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
    );
    parts.set('word/settings.xml', enc(options.settings));
  }
  parts.set(
    '_rels/.rels',
    enc(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    ),
  );
  parts.set(
    '[Content_Types].xml',
    enc(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${overrides.join('')}</Types>`),
  );
  parts.set('word/styles.xml', enc(options.styles ?? DEFAULT_STYLES));
  const sectPr =
    options.section ??
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:gutter="0"/></w:sectPr>';
  parts.set(
    'word/document.xml',
    enc(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}${sectPr}</w:body></w:document>`),
  );
  if (options.rels !== null) {
    const rels =
      options.rels ??
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        (options.settings !== null && options.settings !== undefined
          ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
          : '') +
        '</Relationships>';
    parts.set('word/_rels/document.xml.rels', enc(rels));
  }
  return writeZip(parts);
};

const p = (text: string, pPr = '', rPr = '') =>
  `<w:p>${pPr}<w:r>${rPr}<w:t>${text}</w:t></w:r></w:p>`;
const tr = (...cells: string[]) => `<w:tr>${cells.map(cell => `<w:tc>${cell}</w:tc>`).join('')}</w:tr>`;
const tbl = (...rows: string[]) => `<w:tbl><w:tblPr/>${rows.join('')}</w:tbl>`;

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

test('M39 toc: multi-level headings, relative indent, right dot tab, _TocSeal_ bookmarks, and neutral formatting', async () => {
  const body = [
    p('投标文件封面', '<w:pPr><w:jc w:val="center"/></w:pPr>'),
    p('目  录', '<w:pPr><w:jc w:val="center"/><w:pStyle w:val="Heading1"/></w:pPr>', '<w:rPr><w:b/><w:highlight w:val="yellow"/><w:sz w:val="44"/></w:rPr>'),
    p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    p('1.1 投标承诺', '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'),
    p('1.1.1 详细条款', '<w:pPr><w:outlineLvl w:val="2"/></w:pPr>'),
    p('第二章 技术方案', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>'),
    p('正文内容。'),
  ].join('');
  const doc = await makeDoc(body);

  // Without extractDocxPageTexts: page cache must be empty string (no fake "1").
  const edited = await editTextDocument(doc, [{ op: 'insert_toc', at: 'p:1', position: 'after' }]);
  const parts = await validatePackageStructure(edited);
  const xml = dec(parts.get('word/document.xml')!);

  // Anchor "目  录" is excluded from TOC entries and given outlineLvl=9.
  const tocFields = findTopLevelTocFields(xml);
  assert.equal(tocFields.length, 1);
  assert.match(tocFields[0].instr, /TOC\s+\\o\s+"1-3"\s+\\h\s+\\z\s+\\u/);
  assert.equal(tocFields[0].endBlockIdx - tocFields[0].startBlockIdx + 1, 4);

  // Outline no longer includes "目  录" or TOC entries.
  const sec = outline(xml, dec(parts.get('word/styles.xml')!));
  assert.deepEqual(
    sec.map(item => [item.title, item.level]),
    [
      ['第一章 投标函', 1],
      ['1.1 投标承诺', 2],
      ['1.1.1 详细条款', 3],
      ['第二章 技术方案', 1],
    ],
  );

  // Check _TocSeal_1..4 bookmarks wrap headings and no _Seal_ prefix is used.
  for (let i = 1; i <= 4; i++) {
    assert.ok(xml.includes(`w:name="_TocSeal_${i}"`), `missing _TocSeal_${i}`);
    assert.ok(xml.includes(`w:anchor="_TocSeal_${i}"`), `missing hyperlink anchor _TocSeal_${i}`);
    assert.ok(xml.includes(`PAGEREF _TocSeal_${i} \\h`), `missing PAGEREF _TocSeal_${i}`);
  }
  assert.ok(!xml.includes('_Seal_'));

  // Relative indentation: minLevel=1 -> 0, 420, 840, 0 dxa.
  assert.ok(xml.includes('<w:ind w:left="0"/>'));
  assert.ok(xml.includes('<w:ind w:left="420"/>'));
  assert.ok(xml.includes('<w:ind w:left="840"/>'));

  // Right-aligned dot leader tab stop matching content width (11906 - 1800 - 1800 = 8306).
  assert.ok(xml.includes('<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8306"/></w:tabs>'));
  assert.ok(xml.includes('<w:jc w:val="left"/>'));

  // TOC entries follow OOXML CT_PPrBase sequence order (tabs -> spacing -> ind -> jc -> outlineLvl)
  // and have neutral font (宋体/Times New Roman, sz=24), NEVER inheriting yellow highlight or sz=44 or center!
  const tocParagraphs = xml.match(/<w:p><w:pPr><w:tabs>[\s\S]*?<\/w:p>/g) ?? [];
  assert.equal(tocParagraphs.length, 4);
  for (const tp of tocParagraphs) {
    assert.ok(!tp.includes('yellow'), 'TOC entry must not inherit yellow highlight');
    assert.ok(!tp.includes('w:val="center"'), 'TOC entry must not inherit center alignment');
    assert.ok(!tp.includes('w:val="44"'), 'TOC entry must not inherit title font size');
    assert.ok(tp.includes('<w:outlineLvl w:val="9"/>'));
    const pPrXml = tp.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? '';
    const order = ['<w:tabs>', '<w:spacing ', '<w:ind ', '<w:jc ', '<w:outlineLvl '].map(tag => pPrXml.indexOf(tag));
    assert.ok(order.every(pos => pos >= 0), `missing expected CT_PPrBase tags in ${pPrXml}`);
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i - 1] < order[i], `CT_PPrBase tag order violated in ${pPrXml}`);
    }
    // Must not leave fake "1" page cache when host.extractDocxPageTexts is absent.
    assert.ok(!/<w:t>1<\/w:t>/.test(tp), 'TOC entry must not leave fake page "1"');
  }

  // word/settings.xml was created & registered properly with updateFields=true.
  const settingsXml = dec(parts.get('word/settings.xml')!);
  assert.ok(settingsXml.includes('<w:updateFields w:val="true"/>'));
  assert.ok(dec(parts.get('[Content_Types].xml')!).includes('PartName="/word/settings.xml"'));
  assert.ok(dec(parts.get('word/_rels/document.xml.rels')!).includes('Target="settings.xml"'));
});

test('M39 toc: maxLevel filters headings and relative minLevel shifts indentation when only H2/H3 exist', async () => {
  const body = [
    p('Contents', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>'),
    p('Section A', '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'),
    p('Sub A.1', '<w:pPr><w:pStyle w:val="Heading3"/></w:pPr>'),
  ].join('');
  const doc = await makeDoc(body);
  const edited = await editTextDocument(doc, [{ op: 'insert_toc', at: 'p:0', position: 'after', maxLevel: 2 }]);
  const xml = await xmlOf(edited);
  assert.ok(xml.includes('TOC \\o "1-2" \\h \\z \\u'));
  assert.ok(xml.includes('Section A'));
  assert.ok(!xml.includes('w:anchor="_TocSeal_2"'));
  assert.ok(xml.includes('<w:ind w:left="0"/>'));
});

test('M39 toc: ensureUpdateFieldsSetting handles existing, self-closing, false value, and missing settings.xml', async () => {
  // 1. Existing <w:updateFields w:val="false"/>
  const docFalse = await makeDoc(p('第一章', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'), {
    settings: '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="false"/></w:settings>',
  });
  const parts1 = await validatePackageStructure(docFalse);
  ensureUpdateFieldsSetting(parts1);
  const s1 = dec(parts1.get('word/settings.xml')!);
  assert.ok(s1.includes('<w:updateFields w:val="true"/>'));
  assert.ok(!s1.includes('false'));
  await validatePackageStructure(await writeZip(parts1));

  // 2. Self-closing <w:settings .../>
  const docSelfClosing = await makeDoc(p('第一章', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'), {
    settings: '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
  });
  const parts2 = await validatePackageStructure(docSelfClosing);
  ensureUpdateFieldsSetting(parts2);
  const s2 = dec(parts2.get('word/settings.xml')!);
  assert.ok(s2.includes('<w:updateFields w:val="true"/></w:settings>'));
  await validatePackageStructure(await writeZip(parts2));

  // 3. Missing settings.xml AND missing rels
  const docNoRels = await makeDoc(p('第一章', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'), {
    settings: null,
    rels: null,
  });
  const parts3 = await validatePackageStructure(docNoRels);
  ensureUpdateFieldsSetting(parts3);
  await validatePackageStructure(await writeZip(parts3));
  assert.ok(dec(parts3.get('word/settings.xml')!).includes('<w:updateFields w:val="true"/>'));
  assert.ok(dec(parts3.get('word/_rels/document.xml.rels')!).includes('Target="settings.xml"'));
});

test('M39 toc: idempotent refresh replaces old TOC cleanly, reuses _TocSeal_* bookmarks, and avoids duplicates', async () => {
  const existingBookmark =
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="10" w:name="_TocSeal_7"/><w:r><w:t>第一章 投标函</w:t></w:r><w:bookmarkEnd w:id="10"/></w:p>';
  const body = [
    p('Table of Contents', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>'),
    existingBookmark,
    p('第二章 商务部分', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
  ].join('');
  const doc1 = await makeDoc(body);

  // First insert_toc
  const doc2 = await editTextDocument(doc1, [{ op: 'insert_toc', at: 'p:0', position: 'after' }]);
  const xml2 = await xmlOf(doc2);
  assert.equal(findTopLevelTocFields(xml2).length, 1);
  assert.ok(xml2.includes('w:name="_TocSeal_7"'));
  assert.ok(xml2.includes('w:name="_TocSeal_8"')); // max existing was 7 -> next is 8

  // Add a third chapter, then call insert_toc again on the same anchor -> must replace, not duplicate!
  const doc3 = await editTextDocument(doc2, [
    { op: 'insert', at: 'p:4', position: 'after', markdown: '# 第三章 服务承诺' },
    { op: 'insert_toc', at: 'p:0', position: 'after' },
  ]);
  const xml3 = await xmlOf(doc3);
  const fields3 = findTopLevelTocFields(xml3);
  assert.equal(fields3.length, 1, 'Must have exactly one TOC field after refresh');
  assert.equal(fields3[0].endBlockIdx - fields3[0].startBlockIdx + 1, 3);
  assert.ok(xml3.includes('w:name="_TocSeal_7"'));
  assert.ok(xml3.includes('w:name="_TocSeal_8"'));
  assert.ok(xml3.includes('w:name="_TocSeal_9"'));
  assert.ok(xml3.includes('第三章 服务承诺'));

  // Also check every bookmarkStart has matching bookmarkEnd with no orphans.
  const elems = xmlElements(xml3);
  const starts = elems.filter(e => e.name === 'w:bookmarkStart').length;
  const ends = elems.filter(e => e.name === 'w:bookmarkEnd').length;
  assert.equal(starts, ends);
  assert.equal(starts, 3);
});

test('M39 toc: negative controls reject no-heading, cell address, bad maxLevel, pending, thirdPartyHolder, and deleting anchor', async () => {
  const noHeadingsDoc = await makeDoc(p('目录') + p('普通段落') + tbl(tr(p('单元格段落'))));
  await assert.rejects(
    () => editTextDocument(noHeadingsDoc, [{ op: 'insert_toc', at: 'p:0', position: 'after' }]),
    /文档中没有可生成目录的 1–3 级标题/,
  );

  const validDoc = await makeDoc(p('目录') + p('第一章', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>') + tbl(tr(p('单元格'))));
  for (const badOp of [
    { op: 'insert_toc', at: 't:0/r:0/c:0/p:0', position: 'after' },
    { op: 'insert_toc', at: 't:0/r:0', position: 'after' },
    { op: 'insert_toc', at: 'p:99', position: 'after' },
    { op: 'insert_toc', at: 'p:0', position: 'after', maxLevel: 0 },
    { op: 'insert_toc', at: 'p:0', position: 'after', maxLevel: 4 },
    { op: 'insert_toc', at: 'p:0', position: 'after', maxLevel: 1.5 },
    { op: 'insert_toc', at: 'p:0', position: 'inside' },
    { op: 'insert_toc', at: 'p:0', position: 'after', pending: { category: '其他', note: '不允许' } },
    { op: 'insert_toc', at: 'p:0', position: 'after', thirdPartyHolder: '某公司' },
  ] as any[]) {
    const ledger = makeLedger(validDoc);
    await assert.rejects(
      () =>
        editBidDraft({
          name: 'bid',
          old: validDoc,
          base: validDoc,
          ledger,
          operations: [badOp],
          images: new Map(),
          markdownImages: new Map(),
        }),
      /insert_toc|地址不存在/,
    );
  }

  await assert.rejects(
    () =>
      editTextDocument(validDoc, [
        { op: 'delete', at: 'p:0' },
        { op: 'insert_toc', at: 'p:0', position: 'after' },
      ]),
    /不能在删除锚点/,
  );
});

test('M39 toc: resolveTocPageNumbers & patchTocPageNumbers handle beforeToc/afterToc, multi-heading page, and fallback', async () => {
  const headings = [
    { bookmarkName: '_TocSeal_1', title: '开标一览表', beforeToc: true },
    { bookmarkName: '_TocSeal_2', title: '一、投标函', beforeToc: false },
    { bookmarkName: '_TocSeal_3', title: '二、法定代表人身份证明', beforeToc: false },
    { bookmarkName: '_TocSeal_4', title: '2.1 授权委托书', beforeToc: false },
    { bookmarkName: '_TocSeal_5', title: '三、技术方案', beforeToc: false },
  ];
  const pageTexts = Array.from({ length: 47 }, (_, i) => `第 ${i + 1} 页空白`);
  pageTexts[2] = '开标一览表\n投标人名称：某科技公司'; // Page 3 (beforeToc)
  pageTexts[4] = [
    '目  录',
    '开标一览表 ................................................ 1',
    '一、投标函 ................................................ 1',
    '二、法定代表人身份证明 ..................................... 1',
    '2.1 授权委托书 ............................................ 1',
    '三、技术方案 .............................................. 1',
  ].join('\n'); // Page 5 (TOC itself - MUST be skipped!)
  pageTexts[5] = '一、投标函\n致：采购人'; // Page 6
  pageTexts[11] = '二、法定代表人身份证明\n姓名：张三\n2.1 授权委托书\n委托人：李四'; // Page 12 has TWO consecutive headings
  pageTexts[46] = '三、技术方案\n完整实施方案'; // Page 47

  const resolved = resolveTocPageNumbers(headings, pageTexts, { anchorTitle: '目  录' });
  assert.equal(resolved.get('_TocSeal_1'), '3');
  assert.equal(resolved.get('_TocSeal_2'), '6');
  assert.equal(resolved.get('_TocSeal_3'), '12');
  assert.equal(resolved.get('_TocSeal_4'), '12');
  assert.equal(resolved.get('_TocSeal_5'), '47');

  // Also test TOC page where an entry has no dot-leader (e.g., wrapped title line on TOC page):
  const wrappedTocPages = [...pageTexts];
  wrappedTocPages[4] = ['目录', '开标一览表', '一、投标函', '二、法定代表人身份证明', '2.1 授权委托书', '三、技术方案'].join('\n');
  const resolvedWrapped = resolveTocPageNumbers(headings, wrappedTocPages, { anchorTitle: '目录' });
  assert.equal(resolvedWrapped.get('_TocSeal_1'), '3');
  assert.equal(resolvedWrapped.get('_TocSeal_2'), '6');
  assert.equal(resolvedWrapped.get('_TocSeal_5'), '47');

  // Case 2a: Page 1 has 2 TOC entries (no header/dots) and Page 2 has 2 body headings -> both resolve to "2".
  const twoPageBody = resolveTocPageNumbers(
    [
      { bookmarkName: '_TocSeal_1', title: '1. 项目概况', beforeToc: false },
      { bookmarkName: '_TocSeal_2', title: '2. 技术方案', beforeToc: false },
    ],
    ['1. 项目概况\n2. 技术方案', '1. 项目概况\n正文第一段\n2. 技术方案\n正文第二段'],
  );
  assert.equal(twoPageBody.get('_TocSeal_1'), '2');
  assert.equal(twoPageBody.get('_TocSeal_2'), '2');

  // Case 2b: TOC and body headings on the SAME page (Page 1) -> both resolve to "1".
  const samePageTocAndBody = resolveTocPageNumbers(
    [
      { bookmarkName: '_TocSeal_1', title: '第一章 投标函', beforeToc: false },
      { bookmarkName: '_TocSeal_2', title: '第二章 方案', beforeToc: false },
    ],
    ['目录\n第一章 投标函 ...... 1\n第二章 方案 ...... 1\n第一章 投标函\n正文\n第二章 方案\n正文'],
    { anchorTitle: '目录' },
  );
  assert.equal(samePageTocAndBody.get('_TocSeal_1'), '1');
  assert.equal(samePageTocAndBody.get('_TocSeal_2'), '1');

  // Case 2c: TOC spans Page 5 -> Page 6 top half, while afterToc headings land on Page 6 bottom half.
  const spilledPages = Array.from({ length: 47 }, (_, i) => `第 ${i + 1} 页空白`);
  spilledPages[2] = '开标一览表\n投标人名称：某科技公司'; // Page 3 (beforeToc)
  spilledPages[4] = [
    '目  录',
    '开标一览表 ................................................ 1',
    '一、投标函及投标函附录 .................................... 1',
    '（一）投标函 .............................................. 1',
  ].join('\n'); // Page 5 TOC start
  spilledPages[5] = [
    '二、法定代表人身份证明 ..................................... 1',
    '三、技术方案 .............................................. 1',
    '一、投标函及投标函附录',
    '（一）投标函',
    '致采购人：我方完全响应招标文件。',
  ].join('\n'); // Page 6: top half TOC continuation, bottom half first two afterToc headings!
  spilledPages[7] = '二、法定代表人身份证明\n姓名：张三'; // Page 8
  spilledPages[46] = '三、技术方案\n完整实施方案'; // Page 47
  const spilledResolved = resolveTocPageNumbers(
    [
      { bookmarkName: '_TocSeal_1', title: '开标一览表', beforeToc: true },
      { bookmarkName: '_TocSeal_2', title: '一、投标函及投标函附录', beforeToc: false },
      { bookmarkName: '_TocSeal_3', title: '（一）投标函', beforeToc: false },
      { bookmarkName: '_TocSeal_4', title: '二、法定代表人身份证明', beforeToc: false },
      { bookmarkName: '_TocSeal_5', title: '三、技术方案', beforeToc: false },
    ],
    spilledPages,
    { anchorTitle: '目  录' },
  );
  assert.equal(spilledResolved.get('_TocSeal_1'), '3');
  assert.equal(spilledResolved.get('_TocSeal_2'), '6');
  assert.equal(spilledResolved.get('_TocSeal_3'), '6');
  assert.equal(spilledResolved.get('_TocSeal_4'), '8');
  assert.equal(spilledResolved.get('_TocSeal_5'), '47');

  // Case 2d: Duplicate heading titles on different pages + wrapped 2-line heading must not reuse the same line.
  const dupResolved = resolveTocPageNumbers(
    [
      { bookmarkName: '_TocSeal_1', title: 'Overview', beforeToc: false },
      { bookmarkName: '_TocSeal_2', title: 'Overview', beforeToc: false },
      { bookmarkName: '_TocSeal_3', title: 'Very Long Section Title Part Two', beforeToc: false },
    ],
    [
      '目录\nOverview .... 1\nOverview .... 1\nVery Long Section Title Part Two .... 1',
      'Overview\nFirst overview body.',
      'Overview\nSecond overview body.',
      'Very Long Section\nTitle Part Two\nDetailed body.',
    ],
    { anchorTitle: '目录' },
  );
  assert.equal(dupResolved.get('_TocSeal_1'), '2');
  assert.equal(dupResolved.get('_TocSeal_2'), '3');
  assert.equal(dupResolved.get('_TocSeal_3'), '4');

  // Case 2e: 3-line wrapped TOC entry + standalone page number line on page 1, real heading on page 2.
  const threeLineWrapped = resolveTocPageNumbers(
    [{ bookmarkName: '_TocSeal_1', title: 'Alpha Beta Gamma', beforeToc: false }],
    ['目录\nAlpha\nBeta\nGamma\n1', 'Alpha Beta Gamma\nBody text'],
    { anchorTitle: '目录' },
  );
  assert.equal(threeLineWrapped.get('_TocSeal_1'), '2');

  // Case 2f: Unlocatable TOC mask must fail-closed to empty Map rather than matching page "1".
  const unlocatable = resolveTocPageNumbers(
    [
      { bookmarkName: '_TocSeal_1', title: 'Alpha', beforeToc: false },
      { bookmarkName: '_TocSeal_2', title: 'MissingInToc', beforeToc: false },
    ],
    ['Alpha .... 1\n随机文字', 'Alpha\n正文'],
  );
  assert.equal(unlocatable.size, 0);

  // Case 2g: Multiple TOC blocks (page 1 and page 2) must BOTH be masked so body on page 3 resolves to "3".
  const dualTocResolved = resolveTocPageNumbers(
    [{ bookmarkName: '_TocSeal_1', title: 'Alpha', beforeToc: false }],
    ['目录\nAlpha .... 1', '目录\nAlpha\n1', 'Alpha\nBody text'],
    { anchorTitle: '目录' },
  );
  assert.equal(dualTocResolved.get('_TocSeal_1'), '3');

  // Now verify end-to-end with editTextDocument + mock extractDocxPageTexts
  const doc = await makeDoc(
    [
      p('开标一览表', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      p('目录', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      p('一、投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      p('二、法定代表人身份证明', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      p('2.1 授权委托书', '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'),
      p('三、技术方案', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  let sawPlaceholderBytes = false;
  const mockHost: Pick<HostPort, 'validateImage' | 'extractDocxPageTexts'> = {
    async extractDocxPageTexts(bytes) {
      const placeholderXml = await xmlOf(bytes);
      // Verify placeholder "1" was generated in the intermediate pass so layout height is realistic.
      sawPlaceholderBytes = /PAGEREF _TocSeal_1 \\h[\s\S]*?<w:t>1<\/w:t>/.test(placeholderXml);
      return pageTexts;
    },
  };
  const finalBytes = await editTextDocument(doc, [{ op: 'insert_toc', at: 'p:1', position: 'after' }], mockHost);
  assert.ok(sawPlaceholderBytes);
  const finalXml = await xmlOf(finalBytes);
  assert.match(finalXml, /PAGEREF _TocSeal_1 \\h[\s\S]*?<w:t>3<\/w:t>/);
  assert.match(finalXml, /PAGEREF _TocSeal_2 \\h[\s\S]*?<w:t>6<\/w:t>/);
  assert.match(finalXml, /PAGEREF _TocSeal_3 \\h[\s\S]*?<w:t>12<\/w:t>/);
  assert.match(finalXml, /PAGEREF _TocSeal_4 \\h[\s\S]*?<w:t>12<\/w:t>/);
  assert.match(finalXml, /PAGEREF _TocSeal_5 \\h[\s\S]*?<w:t>47<\/w:t>/);

  // When extractDocxPageTexts degrades to [], placeholder "1" must be cleared to "".
  const degradedBytes = await editTextDocument(doc, [{ op: 'insert_toc', at: 'p:1', position: 'after' }], {
    extractDocxPageTexts: async () => [],
  });
  const degradedXml = await xmlOf(degradedBytes);
  assert.ok(!/<w:t>1<\/w:t>/.test(degradedXml), 'Degraded empty pageTexts must clear placeholder "1"');
  assert.equal(patchTocPageNumbers(finalXml, new Map()).includes('<w:t>47</w:t>'), false);
});

test('M39 seal loop: batch delete + insert_toc, addressAfterEdits, checkDraft (C01/C02/C04/C05/C10/C15/C16), and finalizeDocument', async () => {
  const sandbox = await fs.mkdtemp(path.join(process.cwd(), '.tmp/m39-loop-'));
  try {
    const body = [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      p('（投标人自行编写）'),
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      p('投标总价：____万元'),
      p('第二章 技术方案', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      p('方案正文内容已完善。'),
    ].join('');
    const base = await makeDoc(body);
    const ledger = makeLedger(base);
    const key = new Uint8Array(32).fill(7);
    const host = new NodeHostPort();
    const project: ProjectMetadata = {
      format: 'seal-project-1',
      name: 'M39测试项目',
      deadline: '2026-12-31',
      vaultId: null,
      tenders: [],
      drafts: ['bid'],
      createdAt: '2026-11-25T00:00:00Z',
    };

    // Same-batch: delete placeholder p:1 + insert_toc after p:0 + replace price p:3 (pending) + replace heading check
    const edited = await editBidDraft({
      name: 'bid',
      old: base,
      base,
      host: {
        extractDocxPageTexts: async () => [
          '目录\n第一章 投标函 .... 1\n第二章 技术方案 .... 1',
          '第一章 投标函\n投标总价：100万元',
          '第二章 技术方案\n方案正文内容已完善。',
        ],
      },
      ledger,
      operations: [
        { op: 'delete', at: 'p:1' },
        { op: 'insert_toc', at: 'p:0', position: 'after' },
        { op: 'replace', at: 'p:3', blank: 0, value: '100', pending: { category: '报价', note: '核对报价' } },
      ],
      images: new Map(),
      markdownImages: new Map(),
    });

    assert.equal(edited.results.length, 3);
    assert.deepEqual(
      edited.results[1].views.map(v => v.address),
      ['p:1', 'p:2'],
    );
    // p:3 (price) shifted: -1 (delete p:1) + 2 (toc inserted at p:1..p:2) => p:4!
    assert.deepEqual(
      edited.results[2].views.map(v => v.address),
      ['p:4'],
    );
    assert.equal(edited.ledger.drafts.bid, sha256Hex(edited.output));

    await sealLedger(edited.ledger, sandbox, key);
    const report1 = await checkDraft(host, {
      name: 'bid',
      root: sandbox,
      draft: edited.output,
      base,
      ledger: edited.ledger,
      anchor: edited.ledger.integrity,
      project,
      secret: key,
    });
    assert.deepEqual(report1.results.C01, []);
    assert.deepEqual(report1.results.C02, []);
    assert.equal(report1.results.C04.length, 1);
    assert.deepEqual(report1.results.C05, []);
    assert.deepEqual(report1.results.C10, []);
    assert.deepEqual(report1.results.C15, []);
    assert.deepEqual(report1.results.C16, []);

    // Confirm pending item -> C04 becomes 0, then finalizeDocument preserves TOC & _TocSeal_* bookmarks!
    const draftXml = await xmlOf(edited.output);
    const pendingId = edited.ledger.pending[0].id;
    const reviewCtx = { root: sandbox, vaultId: null, deadline: '2026-12-31' };
    await confirmPending(edited.ledger, 'bid', pendingId, draftXml, reviewCtx, key);
    await sealLedger(edited.ledger, sandbox, key);
    const report2 = await checkDraft(host, {
      name: 'bid',
      root: sandbox,
      draft: edited.output,
      base,
      ledger: edited.ledger,
      anchor: edited.ledger.integrity,
      project,
      secret: key,
    });
    assert.deepEqual(report2.results.C04, []);

    const finalized = await finalizeDraftMarkers(host, {
      name: 'bid',
      root: sandbox,
      draft: edited.output,
      base,
      ledger: edited.ledger,
      anchor: edited.ledger.integrity,
      project,
      secret: key,
    });
    const finalizedXml = await xmlOf(finalized);
    assert.ok(!finalizedXml.includes('_Seal_P_'), 'Seal pending range must be removed');
    assert.ok(finalizedXml.includes('w:name="_TocSeal_1"'), '_TocSeal_1 must survive finalization');
    assert.ok(finalizedXml.includes('w:name="_TocSeal_2"'), '_TocSeal_2 must survive finalization');
    assert.equal(findTopLevelTocFields(finalizedXml).length, 1, 'TOC field must survive finalization');
    assert.match(finalizedXml, /PAGEREF _TocSeal_2 \\h[\s\S]*?<w:t>3<\/w:t>/);
    const finalizedParts = await validatePackageStructure(finalized);
    assert.ok(dec(finalizedParts.get('word/settings.xml')!).includes('<w:updateFields w:val="true"/>'));
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('M39 cli & dsh: runProject edit with insert_toc, tool description, and seal-bid skill guidance', { timeout: 120_000 }, async () => {
  const sandbox = await fs.mkdtemp(path.join(process.cwd(), '.tmp/m39-cli-'));
  const prevSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  try {
    const tenderPath = path.join(sandbox, 'tender.docx');
    const projectDir = path.join(sandbox, 'project');
    const doc = await makeDoc(
      [
        p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
        p('（投标人自行编写）'),
        '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
        p('第一章 资格文件', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      ].join(''),
    );
    await fs.writeFile(tenderPath, doc);
    const host = new NodeHostPort();

    await runProject(host, ['init', '--root', projectDir, '--name', 'M39CLI', '--deadline', '2026-12-31', '--tender', tenderPath]);
    await runProject(host, [
      'extract',
      '--project',
      projectDir,
      '--tender',
      'tender/1.docx',
      '--draft',
      'bid',
      '--ranges',
      JSON.stringify([{ from: 'p:0', to: 'p:3' }]),
    ]);
    const editResult = (await runProject(host, [
      'edit',
      '--project',
      projectDir,
      '--draft',
      'bid',
      '--ops',
      JSON.stringify([
        { op: 'delete', at: 'p:1' },
        { op: 'insert_toc', at: 'p:0', position: 'after' },
      ]),
    ])) as { operations: number; results: Array<{ op: string; status: string; views: Array<{ address: string; text: string }> }> };
    assert.equal(editResult.operations, 2);
    assert.equal(editResult.results[1].op, 'insert_toc');
    assert.equal(editResult.results[1].views[0].address, 'p:1');

    const checkResult = (await runProject(host, ['check', '--project', projectDir, '--draft', 'bid'])) as {
      counts: Record<string, number>;
    };
    assert.equal(checkResult.counts.C01, 0);
    assert.equal(checkResult.counts.C02, 0);
    assert.equal(checkResult.counts.C10, 0);
    assert.equal(checkResult.counts.C15, 0);
    assert.equal(checkResult.counts.C16, 0);

    // readDocument shows TOC entry cleanly
    const draftBytes = await fs.readFile(path.join(projectDir, 'draft/bid.docx'));
    const view = await readDocument(draftBytes, { mode: 'blocks' });
    assert.ok(view.items.some(item => item.address === 'p:1' && item.text.includes('第一章 资格文件')));
  } finally {
    if (prevSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = prevSealHome;
    await fs.rm(sandbox, { recursive: true, force: true });
  }

  // Tool schema description & SEAL_BID_SKILL check
  const toolsSource = await fs.readFile(path.join(process.cwd(), 'src/shells/dsh/project-tools.ts'), 'utf8');
  assert.ok(toolsSource.includes('insert_toc(at, position: before|after, maxLevel?)'));
  assert.match(SEAL_BID_SKILL.content, /insert_toc/);
  assert.match(SEAL_BID_SKILL.content, /目录.*占位/);
});

test('M39 host: real soffice+pdfium page-number backfill on multi-page docx', { timeout: 120_000 }, async t => {
  let renderCapable = false;
  const probeProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'seal-m39-probe-'));
  try {
    execFileSync(
      findSofficeBinary(),
      [`-env:UserInstallation=${pathToFileURL(probeProfile).href}`, '--headless', '--version'],
      { stdio: 'pipe', timeout: 15_000 },
    );
    renderCapable = true;
  } catch {
    renderCapable = false;
  } finally {
    await fs.rm(probeProfile, { recursive: true, force: true });
  }
  if (!renderCapable) {
    t.skip('缺少 soffice');
    return;
  }
  const realHost = new NodeHostPort();
  let capturedPages: string[] = [];
  const host: Pick<HostPort, 'validateImage' | 'extractDocxPageTexts'> = {
    validateImage: (bytes, mime) => realHost.validateImage(bytes, mime),
    extractDocxPageTexts: async bytes => {
      capturedPages = await realHost.extractDocxPageTexts(bytes);
      return capturedPages;
    },
  };
  const doc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
      p('第一章 资格文件', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  const edited = await editTextDocument(doc, [{ op: 'insert_toc', at: 'p:0', position: 'after' }], host);
  assert.ok(capturedPages.length >= 2, `Expected >= 2 rendered pages, got ${capturedPages.length}`);
  assert.match(await xmlOf(edited), /PAGEREF _TocSeal_1 \\h[\s\S]*?<w:t>2<\/w:t>/);
});

test('M39 toc: supports position=before idempotent refresh and table anchor', async () => {
  const doc = await makeDoc(
    [
      p('第一章 总则', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      p('结尾落款'),
      tbl(tr(p('表格结尾'))),
    ].join(''),
  );
  // Insert TOC before p:1, then refresh again before p:2 (since p:1 shifted to p:2 after 1 TOC paragraph inserted)
  const doc2 = await editTextDocument(doc, [{ op: 'insert_toc', at: 'p:1', position: 'before' }]);
  const xml2 = await xmlOf(doc2);
  assert.equal(findTopLevelTocFields(xml2).length, 1);

  const doc3 = await editTextDocument(doc2, [
    { op: 'insert', at: 'p:2', position: 'after', markdown: '# 第二章 附件' },
    { op: 'insert_toc', at: 'p:2', position: 'before' },
  ]);
  const xml3 = await xmlOf(doc3);
  const fields3 = findTopLevelTocFields(xml3);
  assert.equal(fields3.length, 1);
  assert.equal(fields3[0].endBlockIdx - fields3[0].startBlockIdx + 1, 2);

  // Table anchor t:0 after
  const doc4 = await editTextDocument(doc, [{ op: 'insert_toc', at: 't:0', position: 'after' }]);
  const xml4 = await xmlOf(doc4);
  assert.equal(findTopLevelTocFields(xml4).length, 1);
});

test('M39 toc: refresh preserves prefix/suffix content and <w:sectPr> on replaced TOC paragraphs', async () => {
  const oldTocParagraph =
    '<w:p>' +
    '<w:pPr><w:sectPr><w:pgNumType w:start="1"/></w:sectPr></w:pPr>' +
    '<w:r><w:t>前置说明：</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>旧目录项</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    '<w:r><w:t>（后置说明）</w:t></w:r>' +
    '</w:p>';
  const doc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      oldTocParagraph,
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  const refreshed = await editTextDocument(doc, [{ op: 'insert_toc', at: 'p:0', position: 'after' }]);
  await validatePackageStructure(refreshed);
  const xml = await xmlOf(refreshed);
  assert.ok(xml.includes('前置说明：'), 'Prefix content outside old TOC field must survive');
  assert.ok(xml.includes('（后置说明）'), 'Suffix content outside old TOC field must survive');
  assert.ok(!xml.includes('旧目录项'), 'Old TOC content must be replaced');
  const sectMatches = xml.match(/<w:sectPr><w:pgNumType w:start="1"\/><\/w:sectPr>/g) ?? [];
  assert.equal(sectMatches.length, 1, 'Replaced TOC paragraph sectPr must be preserved exactly once');
  // sectPr should be on the preserved suffix paragraph (not the prefix paragraph).
  const suffixParaMatch = xml.match(/<w:p><w:pPr><w:sectPr><w:pgNumType w:start="1"\/><\/w:sectPr><\/w:pPr><w:r><w:t>（后置说明）<\/w:t><\/w:r><\/w:p>/);
  assert.ok(suffixParaMatch, 'sectPr must move onto preserved suffix paragraph');
  assert.ok(xml.includes('<w:spacing w:before="20" w:after="20" w:line="280" w:lineRule="auto"/>'));

  // Calling insert_toc a second time on the same anchor must still replace the TOC (count === 1),
  // even though preserved prefix paragraph sits between anchor and TOC!
  const refreshedTwice = await editTextDocument(refreshed, [
    { op: 'insert', at: 'p:4', position: 'after', markdown: '# 第二章 补充说明' },
    { op: 'insert_toc', at: 'p:0', position: 'after' },
  ]);
  await validatePackageStructure(refreshedTwice);
  const xmlTwice = await xmlOf(refreshedTwice);
  assert.equal(findTopLevelTocFields(xmlTwice).length, 1, 'Second refresh across preserved prefix must not duplicate TOC');
  assert.ok(xmlTwice.includes('前置说明：'));
  assert.ok(xmlTwice.includes('（后置说明）'));
  assert.ok(xmlTwice.includes('第二章 补充说明'));
  assert.equal((xmlTwice.match(/<w:sectPr><w:pgNumType w:start="1"\/><\/w:sectPr>/g) ?? []).length, 1);

  // Also test boundary <w:r> sharing outer text + w:fldChar (PREFIX_KEEP+begin and end+SUFFIX_KEEP).
  const sharedRunDoc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      '<w:p>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>PREFIX_KEEP</w:t><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        '<w:r><w:t>旧条目</w:t></w:r>' +
        '<w:r><w:rPr><w:i/></w:rPr><w:fldChar w:fldCharType="end"/><w:t>SUFFIX_KEEP</w:t></w:r>' +
        '</w:p>',
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  const sharedRefreshed = await editTextDocument(sharedRunDoc, [{ op: 'insert_toc', at: 'p:0', position: 'after' }]);
  await validatePackageStructure(sharedRefreshed);
  const sharedXml = await xmlOf(sharedRefreshed);
  assert.equal(findTopLevelTocFields(sharedXml).length, 1);
  assert.ok(sharedXml.includes('<w:r><w:rPr><w:b/></w:rPr><w:t>PREFIX_KEEP</w:t></w:r>'), 'Shared begin run prefix text and <w:b/> must survive');
  assert.ok(sharedXml.includes('<w:r><w:rPr><w:i/></w:rPr><w:t>SUFFIX_KEEP</w:t></w:r>'), 'Shared end run suffix text and <w:i/> must survive');
  assert.ok(!sharedXml.includes('旧条目'));
});

test('M39 seal loop: same-batch insert(pending) + insert_toc prevents bookmark ID collision and maps same-anchor views', async () => {
  const sandbox = await fs.mkdtemp(path.join(process.cwd(), '.tmp/m39-mixed-'));
  try {
    const base = await makeDoc(
      [
        p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
        p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      ].join(''),
    );
    const key = new Uint8Array(32).fill(9);
    const host = new NodeHostPort();
    const project: ProjectMetadata = {
      format: 'seal-project-1',
      name: 'M39混合批测试',
      deadline: '2026-12-31',
      vaultId: null,
      tenders: [],
      drafts: ['bid'],
      createdAt: '2026-11-25T00:00:00Z',
    };

    // Case 1: different anchors, no existing bookmarks, insert(pending) + insert_toc
    const ledger1 = makeLedger(base);
    const res1 = await editBidDraft({
      name: 'bid',
      old: base,
      base,
      ledger: ledger1,
      operations: [
        { op: 'insert', at: 'p:1', position: 'after', markdown: '新增报价说明：100万元', pending: { category: '报价', note: '待确认报价' } },
        { op: 'insert_toc', at: 'p:0', position: 'after' },
      ],
      images: new Map(),
      markdownImages: new Map(),
    });
    assert.deepEqual(res1.results[0].views.map(v => v.address), ['p:3']);
    assert.equal(res1.results[0].views[0].text, '新增报价说明：100万元');
    assert.deepEqual(res1.results[1].views.map(v => v.address), ['p:1']);
    await sealLedger(res1.ledger, sandbox, key);
    const report1 = await checkDraft(host, {
      name: 'bid',
      root: sandbox,
      draft: res1.output,
      base,
      ledger: res1.ledger,
      anchor: res1.ledger.integrity,
      project,
      secret: key,
    });
    assert.deepEqual(report1.results.C01, []);
    assert.deepEqual(report1.results.C04.length, 1);
    assert.deepEqual(report1.results.C10, []);
    assert.deepEqual(report1.results.C15, []);

    // Case 2: SAME anchor p:0 position=after for both insert(pending) and insert_toc
    const ledger2 = makeLedger(base);
    const res2 = await editBidDraft({
      name: 'bid',
      old: base,
      base,
      ledger: ledger2,
      operations: [
        { op: 'insert', at: 'p:0', position: 'after', markdown: '新增正文', pending: { category: '承诺', note: '核对承诺' } },
        { op: 'insert_toc', at: 'p:0', position: 'after' },
      ],
      images: new Map(),
      markdownImages: new Map(),
    });
    // insert_toc placed TOC at p:1, shifting "新增正文" to p:2!
    assert.deepEqual(res2.results[0].views.map(v => v.address), ['p:2']);
    assert.equal(res2.results[0].views[0].text, '新增正文');
    assert.deepEqual(res2.results[1].views.map(v => v.address), ['p:1']);
    assert.ok(res2.results[1].views[0].text.includes('第一章 投标函'));

    const xml2 = await xmlOf(res2.output);
    const tocPara = xml2.match(/<w:p><w:pPr><w:tabs>[\s\S]*?<\/w:p>/)?.[0] ?? '';
    assert.ok(!tocPara.includes('yellow'), 'TOC entry must stay white when sibling insert is pending');
    assert.ok(!tocPara.includes('_Seal_P_'), 'TOC entry must not get pending bookmark');

    await sealLedger(res2.ledger, sandbox, key);
    const report2 = await checkDraft(host, {
      name: 'bid',
      root: sandbox,
      draft: res2.output,
      base,
      ledger: res2.ledger,
      anchor: res2.ledger.integrity,
      project,
      secret: key,
    });
    assert.deepEqual(report2.results.C01, []);
    assert.deepEqual(report2.results.C10, []);
    assert.deepEqual(report2.results.C15, []);

    // Confirm pending item and finalizeDocument
    await confirmPending(
      res2.ledger,
      'bid',
      res2.ledger.pending[0].id,
      xml2,
      { root: sandbox, vaultId: null, deadline: '2026-12-31' },
      key,
    );
    await sealLedger(res2.ledger, sandbox, key);
    const finalized = await finalizeDraftMarkers(host, {
      name: 'bid',
      root: sandbox,
      draft: res2.output,
      base,
      ledger: res2.ledger,
      anchor: res2.ledger.integrity,
      project,
      secret: key,
    });
    const finalizedXml = await xmlOf(finalized);
    assert.ok(finalizedXml.includes('w:name="_TocSeal_1"'));
    assert.ok(!finalizedXml.includes('_Seal_P_'));
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('M39 toc: fail-closed guards reject edit inside old TOC, multi-section old TOC, exclude before-anchor, and skip custom pgNumType caching', async () => {
  // 1. Same-batch insert(pending) landing inside old TOC [p:1..p:2] must reject atomically.
  const twoEntryToc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      p('第二章 技术方案', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  const withOldToc = await editTextDocument(twoEntryToc, [{ op: 'insert_toc', at: 'p:0', position: 'after' }]);
  const ledger = makeLedger(withOldToc);
  await assert.rejects(
    () =>
      editBidDraft({
        name: 'bid',
        old: withOldToc,
        base: withOldToc,
        ledger,
        operations: [
          { op: 'insert', at: 'p:1', position: 'after', markdown: '中间误插段落', pending: { category: '承诺', note: '不可落入旧目录' } },
          { op: 'insert_toc', at: 'p:0', position: 'after' },
        ],
        images: new Map(),
        markdownImages: new Map(),
      }),
    /落入待替换旧目录区间/,
  );
  assert.equal(ledger.pending.length, 0);

  // 2. Old TOC spanning >= 2 w:sectPr must reject instead of silently dropping earlier section props.
  const multiSectTocDoc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr>' +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Entry1</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:sectPr><w:pgSz w:w="16838" w:h="11906"/></w:sectPr></w:pPr>' +
        '<w:r><w:t>Entry2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  await assert.rejects(
    () => editTextDocument(multiSectTocDoc, [{ op: 'insert_toc', at: 'p:0', position: 'after' }]),
    /跨越多个分节/,
  );

  // 3. position: 'before' on a "目录" heading anchor also excludes self and sets outlineLvl=9.
  const beforeAnchorDoc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>'),
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  const beforeEdited = await editTextDocument(beforeAnchorDoc, [{ op: 'insert_toc', at: 'p:0', position: 'before' }]);
  const beforeXml = await xmlOf(beforeEdited);
  const beforeFields = findTopLevelTocFields(beforeXml);
  assert.equal(beforeFields.length, 1);
  assert.equal(beforeFields[0].endBlockIdx - beforeFields[0].startBlockIdx + 1, 1);
  assert.ok(!beforeXml.includes('w:anchor="_TocSeal_2"'));
  const beforeOutline = outline(beforeXml, DEFAULT_STYLES);
  assert.deepEqual(
    beforeOutline.map(item => item.title),
    ['第一章 投标函'],
  );

  // 4. Single-section default <w:pgNumType w:start="1" w:fmt="decimal"/> (emitted by LibreOffice .doc->.docx)
  // still populates exact page numbers, whereas non-1 start, Roman fmt, or a second-section w:start="1" restart
  // keeps cached pages empty "".
  const standardSingleSectionDoc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
    {
      section: '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/><w:pgNumType w:start="1" w:fmt="decimal"/></w:sectPr>',
    },
  );
  const standardEdited = await editTextDocument(
    standardSingleSectionDoc,
    [{ op: 'insert_toc', at: 'p:0', position: 'after' }],
    { extractDocxPageTexts: async () => ['目录\n第一章 投标函 .... 1', '第一章 投标函'] },
  );
  assert.match(await xmlOf(standardEdited), /PAGEREF _TocSeal_1 \\h[\s\S]*?<w:t>2<\/w:t>/);

  for (const [label, bodyPrefix, pgNumType] of [
    ['second-section restart', '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>封面</w:t></w:r></w:p>', '<w:pgNumType w:start="1"/>'],
    ['non-1 start', '', '<w:pgNumType w:start="5"/>'],
    ['lowerRoman fmt', '', '<w:pgNumType w:fmt="lowerRoman"/>'],
  ] as const) {
    const customSectionDoc = await makeDoc(
      [
        bodyPrefix,
        p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
        p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      ].join(''),
      {
        section: `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/>${pgNumType}</w:sectPr>`,
      },
    );
    const anchor = bodyPrefix ? 'p:1' : 'p:0';
    const edited = await editTextDocument(
      customSectionDoc,
      [{ op: 'insert_toc', at: anchor, position: 'after' }],
      { extractDocxPageTexts: async () => ['封面', '目录\n第一章 投标函 .... 1', '第一章 投标函'] },
    );
    const xml = await xmlOf(edited);
    assert.ok(!/<w:t>\d+<\/w:t>/.test(xml), `Custom ${label} (${pgNumType}) must not write physical page digits`);
  }

  // 5. Ordinary bookmark partial intersection with replaced old TOC field must reject.
  const partialBmDoc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      '<w:p>' +
        '<w:r><w:t>前置说明</w:t></w:r>' +
        '<w:bookmarkStart w:id="88" w:name="UserSpan"/>' +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        '<w:r><w:t>旧条目</w:t></w:r>' +
        '<w:bookmarkEnd w:id="88"/>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
        '</w:p>',
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  await assert.rejects(
    () => editTextDocument(partialBmDoc, [{ op: 'insert_toc', at: 'p:0', position: 'after' }]),
    /书签范围部分交叉/,
  );

  // 6. Inserting TOC inside an existing TOC field must reject (prevent nested TOC).
  const multiParaTocDoc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>条目1</w:t></w:r></w:p>',
      p('条目2'),
      '<w:p><w:r><w:t>条目3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  await assert.rejects(
    () => editTextDocument(multiParaTocDoc, [{ op: 'insert_toc', at: 'p:2', position: 'after' }]),
    /已有目录域内部/,
  );

  // 7. TOC field spanning across a table (p -> t:0 -> p) must still block nested TOC insertion at t:0
  //    and reject unsafe in-place refresh at p:0.
  const crossTableTocDoc = await makeDoc(
    [
      p('目录', '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>条目1</w:t></w:r></w:p>',
      tbl(tr(p('目录内表格'))),
      '<w:p><w:r><w:t>条目2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  await assert.rejects(
    () => editTextDocument(crossTableTocDoc, [{ op: 'insert_toc', at: 't:0', position: 'after' }]),
    /已有目录域内部/,
  );
  await assert.rejects(
    () => editTextDocument(crossTableTocDoc, [{ op: 'insert_toc', at: 'p:0', position: 'after' }]),
    /包含表格等非段落块/,
  );

  // 8. insert_toc inside a cross-paragraph confirmed _Seal_P_ range in editBidDraft must reject atomically.
  const crossSealTemplate = await makeDoc(
    [
      p('第一段正文'),
      p('第二段正文'),
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  const crossSealDraft = await makeDoc(
    [
      '<w:p><w:bookmarkStart w:id="5" w:name="_Seal_P_cross1"/><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>第一段正文</w:t></w:r></w:p>',
      '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>第二段正文</w:t></w:r><w:bookmarkEnd w:id="5"/></w:p>',
      p('第一章 投标函', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    ].join(''),
  );
  const crossLedger: BidLedger = {
    ...makeLedger(crossSealTemplate),
    drafts: { bid: sha256Hex(crossSealDraft) },
    pending: [
      {
        id: 'cross1',
        draft: 'bid',
        category: '承诺',
        note: '跨段承诺',
        reasons: [{ category: '承诺', note: '跨段承诺', source: 'declared' }],
        status: 'confirmed',
        originalHighlights: Array(10).fill(null),
      },
    ],
  };
  await assert.rejects(
    () =>
      editBidDraft({
        name: 'bid',
        old: crossSealDraft,
        base: crossSealTemplate,
        ledger: crossLedger,
        operations: [{ op: 'insert_toc', at: 'p:0', position: 'after' }],
        images: new Map(),
        markdownImages: new Map(),
      }),
    /Seal 范围内部/,
  );
  assert.equal(crossLedger.pending[0].status, 'confirmed');
  assert.equal(crossLedger.drafts.bid, sha256Hex(crossSealDraft));
});

test('M39 host: extractDocxPageTexts degrades to [] when soffice binary is missing', async () => {
  const prevSoffice = process.env.SEAL_SOFFICE;
  process.env.SEAL_SOFFICE = '/nonexistent/soffice-missing-binary';
  try {
    const doc = await makeDoc(p('第一章', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'));
    const pages = await new NodeHostPort().extractDocxPageTexts(doc);
    assert.deepEqual(pages, []);
  } finally {
    if (prevSoffice === undefined) delete process.env.SEAL_SOFFICE;
    else process.env.SEAL_SOFFICE = prevSoffice;
  }
});
