import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { validatePackageStructure } from '../src/core/docx/package-structure.js';
import { xmlElements } from '../src/core/docx/xml.js';
import { xmlAttributes } from '../src/core/docx/outline.js';
import { caption, containers, matrixDocument, paths } from './fixtures/layout-matrix.js';
import { auditImageLayout } from '../src/core/docx/layout.js';

async function xmlOf(bytes: Uint8Array): Promise<string> { return new TextDecoder().decode((await validatePackageStructure(bytes)).get('word/document.xml')); }
const long = sharp({ create: { width: 1239, height: 1827, channels: 3, background: '#446688' } }).png().toBuffer();

for (const item of containers) for (const path of paths) test(`layout matrix ${item.id} / ${path} / long / caption`, async () => {
  const { base, output, width } = await matrixDocument(item, path, await long);
  const xml = await xmlOf(output);
  assert.deepEqual(auditImageLayout(xml), [], 'independent whole-document check accepts the fitted drawing');
  const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)!;
  assert.ok(extent, 'image actually exists');
  const captionLines = Math.ceil(Array.from(caption).length / Math.max(1, Math.floor(width / 200)));
  const height = (item.height ?? 12960) - 360 - 300 * (captionLines + 2);
  const scale = Math.min(1, width * 635 / (1239 * 9525), height * 635 / (1827 * 9525));
  assert.equal(Number(extent[1]), Math.max(1, Math.floor(1239 * 9525 * scale)), 'maximum proportional width from independent fixture dimensions');
  assert.equal(Number(extent[2]), Math.max(1, Math.floor(1827 * 9525 * scale)), 'maximum proportional height from independent fixture dimensions');
  assert.match(xml, /持证方：矩阵企业/);
  if (item.id !== 'body' && item.id !== 'landscape' && item.id !== 'columns') assert.match(xml, /相邻备注完整|外侧备注完整/);
  const elements = xmlElements(xml);
  const beforeXml = await xmlOf(base), beforeElements = xmlElements(beforeXml);
  for (const name of ['w:tblPr', 'w:tblGrid', 'w:tcPr']) {
    const counts = (source: string, nodes: ReturnType<typeof xmlElements>) => nodes.filter(node => node.name === name).reduce((map, node) => {
      const value = source.slice(node.start, node.end);
      map.set(value, (map.get(value) ?? 0) + 1);
      return map;
    }, new Map<string, number>());
    const previous = counts(beforeXml, beforeElements), current = counts(xml, elements);
    for (const [value, count] of previous) assert.ok((current.get(value) ?? 0) >= count, 'existing table properties and grids remain byte-for-byte present');
  }
  for (const inline of elements.filter(node => node.name === 'wp:inline')) {
    const attributes = xmlAttributes(xml, inline);
    for (const edge of ['distT', 'distB', 'distL', 'distR']) assert.equal(attributes.get(edge), '0', 'drawing reserves no implicit distance outside the measured extent');
  }
  const authoredCount = item.generated ? 0 : (item.body.match(/<w:tbl>/g)?.length ?? 0);
  const generatedTables = elements.flatMap((node, index) => node.name === 'w:tbl' ? [index] : []).slice(authoredCount);
  assert.ok(generatedTables.length >= (path === 'same-markdown' || path === 'staged-table' ? 2 : item.at.includes('/c:') ? 1 : 0));
  for (const index of generatedTables) {
    const properties = elements.findIndex(node => node.parent === index && node.name === 'w:tblPr');
    const layout = elements.find(node => node.parent === properties && node.name === 'w:tblLayout');
    assert.equal(layout && xmlAttributes(xml, layout).get('w:type'), 'fixed');
    const widthNode = elements.find(node => node.parent === properties && node.name === 'w:tblW');
    assert.equal(widthNode && xmlAttributes(xml, widthNode).get('w:type'), 'dxa');
    const grid = elements.findIndex(node => node.parent === index && node.name === 'w:tblGrid');
    assert.ok(grid >= 0, 'generated table has an explicit grid');
    const gridColumns = elements.filter(node => node.parent === grid && node.name === 'w:gridCol');
    assert.ok(gridColumns.length > 0);
    assert.ok(gridColumns.every(node => Number(xmlAttributes(xml, node).get('w:w')) > 0));
    const tableWidth = Number(xmlAttributes(xml, widthNode!).get('w:w'));
    assert.equal(gridColumns.reduce((sum, node) => sum + Number(xmlAttributes(xml, node).get('w:w')), 0), tableWidth);
    for (const [cellIndex, cell] of elements.entries()) {
      if (cell.name !== 'w:tc' || cell.parent === null || elements[cell.parent].parent !== index) continue;
      const cellPr = elements.findIndex(node => node.parent === cellIndex && node.name === 'w:tcPr');
      const tcWidth = elements.find(node => node.parent === cellPr && node.name === 'w:tcW');
      assert.equal(tcWidth && xmlAttributes(xml, tcWidth).get('w:type'), 'dxa');
      assert.ok(Number(xmlAttributes(xml, tcWidth!).get('w:w')) > 0);
    }
  }
});

for (const [shape, w, h] of [['wide', 1600, 600], ['small', 20, 30]] as const) test(`layout ${shape} without caption only shrinks`, async () => {
  const image = await sharp({ create: { width: w, height: h, channels: 3, background: '#446688' } }).png().toBuffer();
  const { output } = await matrixDocument(containers[0], 'paragraph-markdown', image, null);
  const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(await xmlOf(output))!;
  assert.doesNotMatch(await xmlOf(output), /持证方|w:cantSplit/);
  const scale = Math.min(1, 9360 * 635 / (w * 9525), 12600 * 635 / (h * 9525));
  assert.equal(Number(extent[1]), Math.floor(w * 9525 * scale));
  assert.equal(Number(extent[2]), Math.floor(h * 9525 * scale));
});
