import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareBodyXml, mapBodyAddresses } from '../src/core/docx/compare.js';
import { applyTextBatch } from '../src/core/docx/text-batch.js';

const doc = (body: string) => `<w:document><w:body>${body}</w:body></w:document>`;
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const row = (text: string) => `<w:tr><w:tc>${p(text)}</w:tc></w:tr>`;
const table = (...rows: string[]) => `<w:tbl>${rows.join('')}</w:tbl>`;

test('independent comparison separates fill, source changes and removed rows', () => {
  const before = doc(p('姓名：____') + p('固定条款') + table(row('第一行'), row('第二行')));
  const filled = doc(p('姓名：李四') + p('固定条款') + table(row('第一行'), row('第二行')));
  assert.deepEqual(compareBodyXml(before, filled).filter(item => item.kind !== 'formatChanged').map(item => item.kind), ['filled']);
  const changed = doc(p('姓名：____') + p('条款已改') + table(row('第一行')));
  const diffs = compareBodyXml(before, changed);
  assert.ok(diffs.some(item => item.kind === 'modified' && item.before === '固定条款'));
  assert.ok(diffs.some(item => item.kind === 'deleted' && item.before === '第二行'));
});

test('independent comparison detects lost objects and stable IDs', () => {
  const before = doc('<w:p><w:r><w:drawing/><w:t>正文</w:t></w:r></w:p>');
  const after = doc(p('正文'));
  const one = compareBodyXml(before, after), two = compareBodyXml(before, after);
  assert.ok(one.some(item => item.kind === 'objectLost'));
  assert.deepEqual(one, two);
});

test('a suggestive nonblank phrase is not sufficient to exempt source changes', () => {
  const result = compareBodyXml(doc(p('本条款适用（项目说明）')), doc(p('本条款适用不同内容')));
  assert.ok(result.some(item => item.kind === 'modified'));
  assert.ok(!result.some(item => item.kind === 'filled'));
});

test('nonempty bracket prompts remain original text when surrounding blanks are present', () => {
  const before = doc(p('单位：（单位名称） 电话：____'));
  const after = doc(p('单位：甲公司 电话：____'));
  assert.deepEqual(compareBodyXml(before, after).map(item => item.kind), ['modified']);
  assert.ok(compareBodyXml(before, doc(p('单位已改：甲公司 电话：____'))).some(item => item.kind === 'modified'));
});

test('object identity follows related content and detects a lost placement', () => {
  const drawing = (id: string, docId: string) => `<w:drawing><wp:docPr id="${docId}"/><a:blip r:embed="${id}"/></w:drawing>`;
  const first = doc(`<w:p><w:r>${drawing('r1', '1')}<w:t>甲</w:t></w:r></w:p>${p('乙')}`);
  const saved = doc(`<w:p><w:r>${drawing('r9', '88')}<w:t>甲</w:t></w:r></w:p>${p('乙')}`);
  const refs = { before: new Map([['r1', 'image-digest']]), after: new Map([['r9', 'image-digest']]) };
  assert.ok(!compareBodyXml(first, saved, refs).some(item => item.kind === 'objectLost' || item.kind === 'formatChanged'));
  const moved = doc(`${p('甲')}<w:p><w:r>${drawing('r9', '88')}<w:t>乙</w:t></w:r></w:p>`);
  assert.ok(compareBodyXml(first, moved, refs).some(item => item.kind === 'objectLost' && item.address === 'p:0'));
});

test('simple fields and both bookmark endpoints survive independently of their displayed words', () => {
  const field = '<w:p><w:fldSimple w:instr="DATE"><w:r><w:t>正文</w:t></w:r></w:fldSimple></w:p>';
  assert.ok(compareBodyXml(doc(field), doc(p('正文'))).some(item => item.kind === 'objectLost' && item.address === 'p:0'));
  const marked = '<w:p><w:bookmarkStart w:id="1" w:name="source"/><w:r><w:t>正文</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>';
  const missingEnd = marked.replace('<w:bookmarkEnd w:id="1"/>', '');
  assert.ok(compareBodyXml(doc(marked), doc(missingEnd)).some(item => item.kind === 'objectLost'));
  const renumbered = marked.replaceAll('w:id="1"', 'w:id="99"');
  assert.deepEqual(compareBodyXml(doc(marked), doc(renumbered)), []);
});

test('a replacement that preserves existing text retains bookmarks inside that text', () => {
  const start = '<w:bookmarkStart w:id="1" w:name="mark"/>';
  const end = '<w:bookmarkEnd w:id="1"/>';
  const before = doc(`<w:p><w:r><w:t>小写</w:t></w:r>${start}<w:r><w:t>：</w:t></w:r>${end}</w:p>`);
  const same = applyTextBatch(before, [{ op: 'replace', at: 'p:0', find: '小写：', value: '小写：' }]);
  assert.ok(!compareBodyXml(before, same).some(item => item.kind === 'objectLost'));
  const after = applyTextBatch(before, [{ op: 'replace', at: 'p:0', find: '小写：', value: '小写：1000000.00', yellow: true }]);
  assert.ok(!compareBodyXml(before, after).some(item => item.kind === 'objectLost'));
  assert.ok(after.indexOf('>小写<') < after.indexOf(start) && after.indexOf(start) < after.indexOf('>：<'));
  assert.ok(after.indexOf('>：<') < after.indexOf(end) && after.indexOf(end) < after.indexOf('>1000000.00<'));
  assert.ok(compareBodyXml(before, after.replace(start, '')).some(item => item.kind === 'objectLost'));
  const moved = after.replace(start, '').replace(end, `${start}${end}`);
  assert.ok(compareBodyXml(before, moved).some(item => item.kind === 'objectLost'));
});

test('a changed field instruction cannot borrow the same result and field markers', () => {
  const field = (instruction: string) => `<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>${instruction}</w:instrText><w:fldChar w:fldCharType="separate"/><w:t>1</w:t><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  assert.ok(compareBodyXml(doc(field('PAGE')), doc(field('NUMPAGES'))).some(item => item.kind === 'objectLost'));
});

test('address mapping includes every cell paragraph and nested table descendant', () => {
  const cell = (body: string) => `<w:tc>${body}</w:tc>`;
  const before = doc(p('前文') + table(`<w:tr>${cell(p('甲') + p('乙') + table(row('内一'), row('内二')))}</w:tr>`));
  const after = doc(p('新前文') + p('前文') + table(row('新外行'), `<w:tr>${cell(p('新增段') + p('甲') + p('乙') + table(row('新内行'), row('内一'), row('内二')))}</w:tr>`));
  const mapping = mapBodyAddresses(before, after);
  assert.equal(mapping.get('p:0'), 'p:1');
  assert.equal(mapping.get('t:0/r:0/c:0'), 't:0/r:1/c:0');
  assert.equal(mapping.get('t:0/r:0/c:0/p:1'), 't:0/r:1/c:0/p:2');
  assert.equal(mapping.get('t:0/r:0/c:0/t:0'), 't:0/r:1/c:0/t:0');
  assert.equal(mapping.get('t:0/r:0/c:0/t:0/r:1/c:0/p:0'), 't:0/r:1/c:0/t:0/r:2/c:0/p:0');
});

test('insertions and deletions anchor surviving blocks and rows instead of two replacements', () => {
  const before = doc(p('甲') + p('乙'));
  const after = doc(p('新内容') + p('甲'));
  assert.deepEqual(compareBodyXml(before, after).map(item => [item.kind, item.before, item.after]), [['inserted', '', '新内容'], ['deleted', '乙', '']]);
  assert.equal(mapBodyAddresses(before, after).get('p:0'), 'p:1');
  assert.ok(!mapBodyAddresses(before, after).has('p:1'));
  const rows = compareBodyXml(doc(table(row('甲'), row('乙'))), doc(table(row('乙'), row('新增'))));
  assert.deepEqual(rows.map(item => [item.kind, item.before, item.after]), [['deleted', '甲', ''], ['inserted', '', '新增']]);
});

test('same-text table paragraphs retain their object placement boundaries', () => {
  const image = '<w:p><w:r><w:drawing/><w:t>同文</w:t></w:r></w:p>';
  const before = doc(table(`<w:tr><w:tc>${image}${p('另一段')}</w:tc></w:tr>`));
  const after = doc(table(`<w:tr><w:tc>${p('同文')}<w:p><w:r><w:drawing/><w:t>另一段</w:t></w:r></w:p></w:tc></w:tr>`));
  assert.ok(compareBodyXml(before, after).some(item => item.kind === 'objectLost' && item.address === 't:0/r:0/c:0/p:0'));
});

test('an inserted image paragraph cannot steal the identity of an unchanged empty paragraph', () => {
  const blank = '<w:p><w:pPr><w:rPr><w:color w:val="auto"/></w:rPr></w:pPr></w:p>';
  const trailing = '<w:p><w:pPr><w:pStyle w:val="47"/></w:pPr></w:p>';
  const image = '<w:p><w:pPr><w:pStyle w:val="47"/></w:pPr><w:r><w:drawing/></w:r></w:p>';
  const before = doc(p('原文') + blank + trailing);
  const after = doc(p('改文') + blank + p('插入说明') + image + trailing);
  assert.equal(mapBodyAddresses(before, after).get('p:1'), 'p:1');
  assert.ok(!compareBodyXml(before, after).some(item => item.address === 'p:1' && item.kind === 'formatChanged'));
  const changed = after.replace('<w:color w:val="auto"/>', '<w:color w:val="FF0000"/>');
  assert.ok(compareBodyXml(before, changed).some(item => item.address === 'p:1' && item.kind === 'formatChanged'));
});

test('objects moved within a paragraph are lost at their original textual position', () => {
  const before = doc('<w:p><w:r><w:t>甲</w:t><w:object/><w:t>乙</w:t></w:r></w:p>');
  const after = doc('<w:p><w:r><w:t>甲乙</w:t><w:object/></w:r></w:p>');
  assert.ok(compareBodyXml(before, after).some(item => item.kind === 'objectLost'));
  const blank = doc('<w:p><w:r><w:t>姓名：____</w:t><w:object/><w:t>乙</w:t></w:r></w:p>');
  for (const value of ['李四', '用于测试的较长合成名称']) {
    const filled = doc(`<w:p><w:r><w:t>姓名：${value}</w:t><w:object/><w:t>乙</w:t></w:r></w:p>`);
    assert.deepEqual(compareBodyXml(blank, filled).map(item => item.kind), ['filled']);
  }
});

test('nested paragraph deletion reports its own source address and objects', () => {
  const field = '<w:p><w:fldSimple w:instr="DATE"><w:r><w:t>日期</w:t></w:r></w:fldSimple></w:p>';
  const before = doc(table(`<w:tr><w:tc>${p('保留')}${table(`<w:tr><w:tc>${field}${p('尾部')}</w:tc></w:tr>`)}</w:tc></w:tr>`));
  const after = doc(table(`<w:tr><w:tc>${p('保留')}${table(row('尾部'))}</w:tc></w:tr>`));
  const differences = compareBodyXml(before, after);
  assert.ok(differences.some(item => item.kind === 'deleted' && item.address === 't:0/r:0/c:0/t:0/r:0/c:0/p:0' && item.before === '日期'));
  assert.ok(differences.some(item => item.kind === 'objectLost' && item.address === 't:0/r:0/c:0/t:0/r:0/c:0/p:0'));
});

test('blank characters are fills while placeholders and fixed words remain modifications', () => {
  for (const [before, after] of [['单位：    ', '单位：甲公司'], ['日期： 年 月 日', '日期：2026年11月16日']]) {
    assert.deepEqual(compareBodyXml(doc(p(before)), doc(p(after))).map(item => item.kind), ['filled']);
  }
  assert.ok(compareBodyXml(doc(p('姓名：XXXX')), doc(p('姓名：李四'))).some(item => item.kind === 'modified'));
  assert.ok(compareBodyXml(doc(p('固定条款 ____')), doc(p('改写条款 已填写'))).some(item => item.kind === 'modified'));
});

test('deep mapping does not cross distinct paragraph and table boundaries with equal flat text', () => {
  const before = doc(table(`<w:tr><w:tc>${p('甲乙')}</w:tc><w:tc>${p('固定')}</w:tc></w:tr>`));
  const after = doc(table(`<w:tr><w:tc>${p('甲')}${p('乙')}</w:tc><w:tc>${p('固定')}</w:tc></w:tr>`));
  const differences = compareBodyXml(before, after);
  assert.ok(differences.some(item => item.kind === 'modified' || item.kind === 'deleted'));
  assert.equal(mapBodyAddresses(before, after).get('t:0/r:0/c:1/p:0'), 't:0/r:0/c:1/p:0');
});

test('large alignments keep exact anchors across more than 32 new blocks', () => {
  const lines = Array.from({ length: 730 }, (_, index) => p(`固定条款${index}`));
  const extra = Array.from({ length: 40 }, (_, index) => p(`新增条款${index}`));
  const before = doc(lines.join('')), after = doc([...lines.slice(0, 2), ...extra, ...lines.slice(2)].join(''));
  const differences = compareBodyXml(before, after);
  assert.equal(differences.length, 40);
  assert.ok(differences.every(item => item.kind === 'inserted'));
  assert.equal(mapBodyAddresses(before, after).get('p:2'), 'p:42');
  const changedEdges = after.replace('固定条款0<', '修改首条<').replace('固定条款729<', '修改末条<');
  const edged = compareBodyXml(before, changedEdges);
  assert.equal(edged.filter(item => item.kind === 'inserted').length, 40);
  assert.equal(edged.filter(item => item.kind === 'modified').length, 2);
  assert.equal(edged.length, 42);
});

test('difference identities use baseline positions and distinguish repeated lost objects', () => {
  const before = doc(p('原文：旧内容') + p('固定尾部'));
  const direct = compareBodyXml(before, doc(p('原文：改后') + p('固定尾部'))).find(item => item.kind === 'modified')!;
  const shifted = compareBodyXml(before, doc(p('新插入') + p('原文：改后') + p('固定尾部'))).find(item => item.kind === 'modified' && item.before === '原文：旧内容')!;
  assert.ok(direct && shifted);
  assert.equal(direct.id, shifted.id);
  assert.notEqual(direct.id, compareBodyXml(before, doc(p('再次改变') + p('固定尾部'))).find(item => item.kind === 'modified')!.id);
  const lost = compareBodyXml(doc('<w:p><w:r><w:drawing/><w:drawing/><w:t>正文</w:t></w:r></w:p>'), doc(p('正文'))).filter(item => item.kind === 'objectLost');
  assert.equal(lost.length, 2);
  assert.equal(new Set(lost.map(item => item.id)).size, 2);
  const lostChanged = compareBodyXml(doc('<w:p><w:r><w:drawing/><w:drawing/><w:t>正文</w:t></w:r></w:p>'), doc(p('改稿'))).filter(item => item.kind === 'objectLost');
  assert.notEqual(lost[0].id, lostChanged[0].id);
});

test('field identities retain quoted instructions and ignore instruction run splitting', () => {
  const simple = (instruction: string) => doc(`<w:p><w:fldSimple w:instr="${instruction}"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>`);
  assert.ok(compareBodyXml(simple("Owner's field"), simple("Owner's changed field")).some(item => item.kind === 'objectLost'));
  const complex = (instructions: string) => doc(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>${instructions}<w:r><w:fldChar w:fldCharType="separate"/><w:t>1</w:t><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
  const instruction = (text: string) => `<w:r><w:instrText>${text}</w:instrText></w:r>`;
  assert.deepEqual(compareBodyXml(complex(instruction('PAGE')), complex(instruction('PA') + instruction('GE'))), []);
});

test('visible text comparison reads controls and excludes hidden, deleted, and drawing text', () => {
  const fragment = (hidden: string, deleted: string, textbox: string) => doc(`<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C</w:t><w:br/><w:t>D</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>${hidden}</w:t></w:r><w:del><w:r><w:t>${deleted}</w:t></w:r></w:del><w:txbxContent>${p(textbox)}</w:txbxContent></w:p>`);
  assert.deepEqual(compareBodyXml(fragment('hidden', 'deleted', 'textbox'), fragment('other hidden', 'other deleted', 'other textbox')), []);
  const changed = compareBodyXml(fragment('hidden', 'deleted', 'textbox'), fragment('hidden', 'deleted', 'textbox').replace('<w:t>D</w:t>', '<w:t>E</w:t>'));
  assert.equal(changed.find(item => item.kind === 'modified')!.before, 'A&B\tC\nD');
  const wrapped = (text: string) => doc(table(`<w:tr><w:tc><w:sdt>${p(text)}</w:sdt>${p('直接段')}</w:tc></w:tr>`));
  assert.ok(compareBodyXml(wrapped('包裹段'), wrapped('包裹更新')).some(item => item.kind === 'modified' && item.address === 'word/document.xml#readonly:p:0'));
  const object = (text: string) => doc(`<w:p><w:r><w:t>${text}</w:t><w:object/><w:t>尾部</w:t></w:r></w:p>`);
  for (const value of ['改文', '用于测试的较长改写内容']) {
    const differences = compareBodyXml(object('原文'), object(value));
    assert.ok(differences.some(item => item.kind === 'modified'));
    assert.ok(!differences.some(item => item.kind === 'objectLost'));
  }
  const drawing = (id: string, docId: string) => `<w:drawing><wp:docPr id="${docId}"/><a:blip r:embed="${id}"/></w:drawing>`;
  const drawingBefore = (prefix: string) => doc(`<w:p><w:r><w:t>${prefix}</w:t>${drawing('r1', '1')}<w:t>尾部</w:t></w:r></w:p>`);
  const splitAfter = doc(`<w:p><w:r><w:t>姓名：</w:t></w:r><w:r><w:t>用于测试的较长合成名称</w:t></w:r><w:r>${drawing('r9', '88')}</w:r><w:r><w:t>尾部</w:t></w:r></w:p>`);
  const refs = { before: new Map([['r1', 'same-image']]), after: new Map([['r9', 'same-image']]) };
  assert.deepEqual(compareBodyXml(drawingBefore('姓名：____'), splitAfter, refs).map(item => item.kind), ['filled']);
  assert.deepEqual(compareBodyXml(drawingBefore('姓名：原文'), splitAfter, refs).map(item => item.kind), ['modified']);
});

test('visible comparison traverses paragraphs and tables inside content controls', () => {
  const control = (body: string) => doc(`<w:sdt><w:sdtPr/><w:sdtContent>${body}</w:sdtContent></w:sdt>`);
  const before = control(p('控件原文') + table(row('控件表格原文')));
  const after = control(p('控件改写') + table(row('控件表格改写')));
  const differences = compareBodyXml(before, after);
  assert.ok(differences.some(item => item.kind === 'modified' && item.before === '控件原文'));
  assert.ok(differences.some(item => item.kind === 'modified' && item.before === '控件表格原文'));
  assert.ok(!compareBodyXml(before, after.replace('控件改写', '控件原文').replace('控件表格改写', '控件表格原文')).some(item => item.kind === 'modified'));
});

test('format changes remain visible at paragraph, table, row, and cell addresses', () => {
  const before = doc(table(row('正文')));
  for (const [tag, property, address] of [['w:tbl', '<w:tblPr><w:tblW w:w="1200"/></w:tblPr>', 't:0'], ['w:tr', '<w:trPr><w:cantSplit/></w:trPr>', 't:0/r:0'], ['w:tc', '<w:tcPr><w:shd w:fill="yellow"/></w:tcPr>', 't:0/r:0/c:0'], ['w:p', '<w:pPr><w:keepNext/></w:pPr>', 't:0/r:0/c:0/p:0']]) {
    assert.ok(compareBodyXml(before, before.replace(`<${tag}>`, `<${tag}>${property}`)).some(item => item.kind === 'formatChanged' && item.address === address));
  }
  const style = (value: string) => doc(`<w:p><w:r><w:rPr><w:b w:val="${value}"/></w:rPr><w:t>正文</w:t></w:r></w:p>`);
  const first = compareBodyXml(style('0'), style('1')).find(item => item.kind === 'formatChanged')!;
  const second = compareBodyXml(style('0'), style('true')).find(item => item.kind === 'formatChanged')!;
  assert.notEqual(first.id, second.id);
  assert.ok(compareBodyXml(doc(p('日期： 年 月 日')), doc(p('日期：2026年11月16号'))).some(item => item.kind === 'modified'));
});
