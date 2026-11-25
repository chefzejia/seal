import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateXmlParts } from '../src/core/docx/xml-validation.js';
import { assertXmlCharacters, injectHighlightYellow, unescapeXml } from '../src/core/docx/xml.js';
import { replaceVisibleRange } from '../src/core/docx/visible-surgery.js';

const encode = (value: string) => new TextEncoder().encode(value);

test('all XML and relationship parts use strict UTF-8 and XML parsing', () => {
  const entries = new Map([
    ['word/document.xml', encode('<root>中文 �</root>')],
    ['word/_rels/document.xml.rels', encode('<Relationships/>')],
    ['word/styles.xml', encode('<styles/>')],
  ]);
  assert.doesNotThrow(() => validateXmlParts(entries));
  const malformedUtf8 = new Uint8Array([...encode('<styles>'), 0xff, ...encode('</styles>')]);
  for (const bad of [malformedUtf8, encode('<styles>&missing;</styles>'), encode('<!DOCTYPE styles><styles/>')]) {
    const broken = new Map(entries);
    broken.set('word/styles.xml', bad);
    assert.throws(() => validateXmlParts(broken), /word\/styles\.xml/);
  }
});

test('reject illegal Unicode before encoding and decode entities once', () => {
  for (const value of ['\u0001', '\ud800', '\udc00']) assert.throws(() => assertXmlCharacters(value));
  assert.doesNotThrow(() => assertXmlCharacters('中文😀�'));
  assert.equal(unescapeXml('&#x1F600; &#40; &amp;#65;'), '😀 ( &#65;');
  assert.throws(() => unescapeXml('&#0;'));
});

test('numeric entity offsets preserve text outside a replacement', () => {
  const paragraph = '<w:p><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>😀&#91;姓名&#x5D; 固定 &amp;#65;</w:t></w:r></w:p>';
  const output = replaceVisibleRange(paragraph, 2, 6, '张三');
  assert.match(output, /😀/);
  assert.match(output, /张三/);
  assert.match(output, /固定 &amp;#65;/);
  assert.match(output, /<w:u w:val="single"\/>/);
});

test('yellow highlighting expands self-closing run properties', () => {
  assert.equal(injectHighlightYellow('<w:rPr/>'), '<w:rPr><w:highlight w:val="yellow"/></w:rPr>');
});
