import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyBlocks, searchBody } from '../src/core/docx/document-view.js';

const xml = '<w:document><w:body><w:p><w:r><w:t>姓名：____</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>项目名称</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>项目名称</w:t></w:r></w:p></w:body></w:document>';

test('body blocks preserve document order and current addresses', () => {
  const blocks = bodyBlocks(xml);
  assert.deepEqual(blocks.map(block => block.address), ['p:0', 't:0/r:0/c:0', 't:0/r:0/c:1', 'p:1']);
  assert.equal(blocks[0].hints[0].text, '____');
});

test('literal search provides an explicit continuation offset', () => {
  const first = searchBody(xml, '项目', 0, 1);
  assert.equal(first.blocks[0].address, 't:0/r:0/c:1');
  assert.equal(first.next, 1);
  assert.equal(searchBody(xml, '项目', first.next!, 1).blocks[0].address, 'p:1');
  assert.throws(() => searchBody(xml, ''));
});

test('internal flat text and search remain free of display annotations', () => {
  const sample = '<w:document><w:body><w:p><w:r><w:t>姓名：____</w:t><w:drawing/></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏</w:t></w:r></w:p></w:body></w:document>';
  assert.equal(bodyBlocks(sample)[0].text, '姓名：____');
  assert.equal(bodyBlocks(sample)[0].hints[0].start, 3);
  assert.equal(searchBody(sample, '[图片]').blocks.length, 0);
  assert.equal(searchBody(sample, '隐藏').blocks.length, 0);
});
