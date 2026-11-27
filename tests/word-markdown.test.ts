import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaxesParser } from 'saxes';
import { markdownBlocks } from '../src/core/docx/markdown.js';
import { outline } from '../src/core/docx/outline.js';
import { applyInsertToc } from '../src/core/docx/toc.js';
import { editableText } from '../src/core/docx/visible-surgery.js';
import { elementChildren, xmlElements } from '../src/core/docx/xml.js';

function directChildNames(xml: string, parentName: string): string[][] {
  const elements = xmlElements(xml);
  const children = elementChildren(elements);
  return elements
    .map((el, idx) => (el.name === parentName ? children[idx].map(c => elements[c].name) : null))
    .filter((item): item is string[] => item !== null);
}

test('Markdown produces styled headings, paragraphs, lists and tables', () => {
  const result = markdownBlocks('# 标题\n\n正文 **粗体** 与 *斜体*。\n\n- 第一项\n- 第二项\n\n| 名称 | 内容 | 数值 |\n| :--- | :---: | ---: |\n| 甲 | 乙 | 100 |', { headingStyles: new Map([[1, 'Heading1']]) });
  assert.deepEqual(result.missingHeadings, []);
  assert.match(result.xml, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(result.xml, /<w:b\/>/);
  assert.match(result.xml, /<w:i\/>/);
  assert.match(result.xml, /<w:tbl>/);
  assert.match(editableText(result.xml), /标题正文 粗体 与 斜体。/);
  assert.match(editableText(result.xml), /第一项/);
  assert.deepEqual(directChildNames(result.xml, 'w:tblPr'), [['w:tblW', 'w:tblBorders', 'w:tblLayout', 'w:tblCellMar']]);
  assert.deepEqual(directChildNames(result.xml, 'w:tblBorders'), [['w:top', 'w:left', 'w:bottom', 'w:right', 'w:insideH', 'w:insideV']]);
  assert.deepEqual(directChildNames(result.xml, 'w:tblCellMar'), [['w:top', 'w:left', 'w:bottom', 'w:right']]);
  assert.deepEqual(directChildNames(result.xml, 'w:trPr'), [['w:cantSplit', 'w:tblHeader'], ['w:cantSplit']]);
  assert.deepEqual(directChildNames(result.xml, 'w:tcPr'), [
    ['w:tcW', 'w:shd', 'w:vAlign'],
    ['w:tcW', 'w:shd', 'w:vAlign'],
    ['w:tcW', 'w:shd', 'w:vAlign'],
    ['w:tcW', 'w:vAlign'],
    ['w:tcW', 'w:vAlign'],
    ['w:tcW', 'w:vAlign'],
  ]);
  assert.match(result.xml, /<w:jc w:val="left"\/>/);
  assert.match(result.xml, /<w:jc w:val="center"\/>/);
  assert.match(result.xml, /<w:jc w:val="right"\/>/);
  const rows = [...result.xml.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)].map(m => m[0]);
  assert.equal(rows.length, 2);
  const headerCells = [...rows[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(m => m[0]);
  const bodyCells = [...rows[1].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(m => m[0]);
  assert.deepEqual(headerCells.map(c => /<w:jc w:val="([^"]+)"\/>/.exec(c)?.[1]), ['left', 'center', 'right']);
  assert.deepEqual(bodyCells.map(c => /<w:jc w:val="([^"]+)"\/>/.exec(c)?.[1]), ['left', 'center', 'right']);
  for (const cell of headerCells) assert.match(cell, /<w:rPr><w:b\/><\/w:rPr>/);
  for (const cell of bodyCells) assert.doesNotMatch(cell, /<w:b\/>/);
  assert.doesNotMatch(markdownBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |').xml, /<w:jc\b/);
  assert.doesNotThrow(() => new SaxesParser({ xmlns: true }).write(`<root xmlns:w="word">${result.xml}</root>`).close());
});

test('missing heading styles emit bold + outlineLvl, remain yellow-compatible, and feed outline/TOC', () => {
  const result = markdownBlocks('# 一级章\n\n## 二级节\n\n###### 六级条\n\n| 表头 |\n| --- |\n| 单元格 |');
  assert.deepEqual(result.missingHeadings, [1, 2, 6]);
  assert.deepEqual(directChildNames(result.xml, 'w:pPr').slice(0, 3), [
    ['w:keepNext', 'w:outlineLvl'],
    ['w:keepNext', 'w:outlineLvl'],
    ['w:keepNext', 'w:outlineLvl'],
  ]);
  const headingParas = [...result.xml.matchAll(/<w:p><w:pPr><w:keepNext\/><w:outlineLvl[^>]*\/><\/w:pPr>[\s\S]*?<\/w:p>/g)].map(m => m[0]);
  assert.equal(headingParas.length, 3);
  for (const headingPara of headingParas) assert.match(headingPara, /<w:rPr><w:b\/><\/w:rPr>/);
  assert.match(result.xml, /<w:outlineLvl w:val="0"\/>/);
  assert.match(result.xml, /<w:outlineLvl w:val="1"\/>/);
  assert.match(result.xml, /<w:outlineLvl w:val="5"\/>/);
  const docXml = `<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>目录</w:t></w:r></w:p>${result.xml}</w:body></w:document>`;
  const sections = outline(docXml);
  assert.deepEqual(sections.map(s => [s.title, s.level]), [['一级章', 1], ['二级节', 2], ['六级条', 6]]);
  const toc = applyInsertToc(docXml, { op: 'insert_toc', at: 'p:0', position: 'after', maxLevel: 3 }, '');
  assert.deepEqual(toc.entries.map(e => [e.title, e.level]), [['一级章', 1], ['二级节', 2]]);
  const yellowResult = markdownBlocks('## 待定节\n\n| 列 |\n| --- |\n| 值 |', { yellow: true });
  assert.match(yellowResult.xml, /<w:outlineLvl w:val="1"\/>/);
  assert.ok((yellowResult.xml.match(/<w:highlight w:val="yellow"\/>/g) ?? []).length >= 3);
  assert.doesNotThrow(() => new SaxesParser({ xmlns: true }).write(`<root xmlns:w="word">${yellowResult.xml}</root>`).close());
});

test('missing heading styles are reported and HTML or unresolved images are rejected', () => {
  assert.deepEqual(markdownBlocks('## 标题').missingHeadings, [2]);
  assert.throws(() => markdownBlocks('<script>bad</script>'));
  assert.throws(() => markdownBlocks('![x](image.png)'));
});
