import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDocument, readableParagraphs, type ReadDocumentOptions } from '../src/core/docx/read-document.js';
import { bodyBlocks } from '../src/core/docx/document-view.js';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { resolveAddress } from '../src/core/docx/addresses.js';
import { writeZip, sha256Hex } from '../src/core/docx/zip.js';
import { validatePackageStructure } from '../src/core/docx/package-structure.js';

const p = (text: string, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const doc = (body: string) => `<w:document xmlns:w="word" xmlns:r="relations" xmlns:a="drawing" xmlns:mc="compat"><w:body>${body}</w:body></w:document>`;
const encode = (value: string) => new TextEncoder().encode(value);
async function packageOf(body: string, relations = '', extra: Array<[string, string]> = []): Promise<Uint8Array> {
  return writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>')],
    ['word/document.xml', encode(doc(body))],
    ['word/_rels/document.xml.rels', encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations}</Relationships>`)],
    ...extra.map(([name, value]) => [name, encode(value)] as [string, Uint8Array]),
  ]));
}
const texts = (result: Awaited<ReturnType<typeof readDocument>>) => result.items.map(item => item.text).join('');

test('public blocks recursively expose real editable addresses without contaminating internal text', async () => {
  const body = p('姓名：____') + `<w:tbl><w:tr><w:tc>${p('格内首段')}<w:tbl><w:tr><w:tc>${p('嵌套段')}</w:tc></w:tr></w:tbl>${p('格内尾段')}</w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr>${p('续格隐藏内容')}<w:sdt>${p('续格容器隐藏内容')}</w:sdt></w:tc></w:tr></w:tbl>`;
  const bytes = await packageOf(body), before = sha256Hex(bytes);
  const result = await readDocument(bytes, { mode: 'blocks' });
  assert.match(texts(result), /姓名：⟦0:____⟧/);
  assert.match(texts(result), /嵌套段/);
  assert.match(texts(result), /〃/);
  assert.ok(!texts(result).includes('续格隐藏内容'));
  assert.ok(!texts(result).includes('续格容器隐藏内容'));
  for (const item of result.items) if (item.editable) assert.doesNotThrow(() => resolveAddress(doc(body), item.address!));
  assert.ok(result.items.some(item => item.address === 't:0/r:0/c:0/t:0/r:0/c:0/p:0'));
  assert.equal(bodyBlocks(doc(body))[0].text, '姓名：____');
  assert.equal(sha256Hex(bytes), before);
  const from = await readDocument(bytes, { mode: 'blocks', from: 't:0/r:0/c:0/p:1', limit: 1 });
  assert.equal(from.items[0].text, '格内尾段');
});

test('public inline markers preserve text, object positions, hidden text and pending anchors', async () => {
  const body = '<w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t>甲</w:t><w:tab/><w:t>姓名：__</w:t></w:r><w:r><w:t>__</w:t><w:drawing/><w:t>乙</w:t><w:object/><w:br/><w:t>☐未选 √已选</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏词</w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>原有黄色</w:t></w:r></w:p>';
  const bytes = await packageOf(body);
  const result = await readDocument(bytes, { mode: 'blocks' }, { pending: [{ address: 'p:0', find: '乙', category: '商务待定' }] });
  const text = texts(result);
  assert.match(text, /甲\t姓名：⟦0:____⟧\[图片\]«待定:商务待定»乙«\/待定»\[对象\]\n/);
  assert.match(text, /□未选 ☑已选/);
  assert.match(text, /‹隐藏›隐藏词‹\/隐藏›原有黄色/);
  assert.equal((text.match(/«待定:/g) ?? []).length, 1);
  assert.ok(!bodyBlocks(doc(body))[0].text.includes('‹隐藏›'));
  assert.ok(!bodyBlocks(doc(body))[0].text.includes('隐藏词'));
});

test('pending offsets distinguish repeated text and continuation binds pending context', async () => {
  const bytes = await packageOf(p('甲100乙100丙') + p('续文'.repeat(50)));
  const context = { pending: [{ address: 'p:0', find: '100', category: '报价', offset: 5 }] };
  const result = await readDocument(bytes, { mode: 'blocks', maxChars: 80 }, context);
  assert.match(texts(result), /甲100乙«待定:报价»100«\/待定»丙/);
  assert.ok(result.next);
  await assert.rejects(readDocument(bytes, result.next!, { pending: [{ ...context.pending[0], offset: 1 }] }));
  const invalid = await readDocument(bytes, { mode: 'blocks' }, { pending: [{ ...context.pending[0], offset: 2 }] });
  assert.ok(invalid.warnings.some(warning => warning.includes('待定锚点无法唯一定位')));
  assert.doesNotMatch(texts(invalid), /«待定:/);
});

test('only related, referenced stories and actual text boxes are exposed as read-only', async () => {
  const body = p('正文') + '<w:p><w:r><w:drawing><w:txbxContent>' + p('文本框内容') + '</w:txbxContent></w:drawing></w:r></w:p><w:p><w:r><w:footnoteReference w:id="4"/><w:commentReference w:id="7"/></w:r></w:p><w:sectPr><w:headerReference r:id="h"/><w:footerReference r:id="f"/><w:sectPrChange><w:sectPr><w:headerReference r:id="oldHeader"/></w:sectPr></w:sectPrChange></w:sectPr><w:del><w:r><w:footnoteReference w:id="99"/></w:r></w:del>';
  const relations = '<Relationship Id="unused" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header-orphan.xml"/><Relationship Id="h" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="stories/custom.xml"/><Relationship Id="f" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="stories/custom-footer.xml"/><Relationship Id="n" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="notes/custom.xml"/><Relationship Id="c" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="notes/comments.xml"/>';
  const root = (tag: string, text: string) => `<w:${tag} xmlns:w="word">${p(text)}</w:${tag}>`;
  const bytes = await packageOf(body, relations, [['word/stories/custom.xml', root('hdr', '实际页眉')], ['word/stories/custom-footer.xml', root('ftr', '实际页脚')], ['word/header-orphan.xml', root('hdr', '孤立页眉不展示')], ['word/notes/custom.xml', '<w:footnotes xmlns:w="word"><w:footnote w:id="0" w:type="separator">' + p('分隔符不展示') + '</w:footnote><w:footnote w:id="4">' + p('实际脚注') + '</w:footnote><w:footnote w:id="5">' + p('未引用脚注') + '</w:footnote></w:footnotes>'], ['word/notes/comments.xml', '<w:comments xmlns:w="word"><w:comment w:id="7">' + p('实际批注') + '</w:comment></w:comments>']]);
  const result = await readDocument(bytes, { mode: 'blocks' });
  for (const value of ['实际页眉', '实际页脚', '实际脚注', '实际批注', '文本框内容']) {
    const item = result.items.find(item => item.text.includes(value))!;
    assert.ok(item, value); assert.equal(item.editable, false); assert.equal(item.address, null); assert.match(item.label!, /不可编辑/);
  }
  for (const value of ['孤立页眉不展示', '分隔符不展示', '未引用脚注']) assert.ok(!texts(result).includes(value));
});

test('complete readable paragraph traversal includes referenced headers and text boxes', async () => {
  const body = p('正文2028年2月29日') + '<w:p><w:r><w:drawing><w:txbxContent>' + p('文本框2027年2月29日') + '</w:txbxContent></w:drawing></w:r></w:p><w:sectPr><w:headerReference r:id="h"/></w:sectPr>';
  const rel = '<Relationship Id="h" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header.xml"/>';
  const input = await packageOf(body, rel, [['word/header.xml', `<w:hdr xmlns:w="word">${p('页眉2027年2月29日')}</w:hdr>`]]);
  const entries = readableParagraphs(await validatePackageStructure(input));
  assert.ok(entries.some(entry => entry.address.includes('readonly') && entry.text === '文本框2027年2月29日'));
  assert.ok(entries.some(entry => entry.address.includes('header.xml') && entry.text === '页眉2027年2月29日'));
});

test('alternate textbox branches are exclusive while identical independent textboxes remain distinct', async () => {
  const box = (text: string) => `<w:p><w:r><w:drawing><w:txbxContent>${p(text)}</w:txbxContent></w:drawing></w:r></w:p>`;
  const alt = (choice: string, fallback: string) => `<mc:AlternateContent><mc:Choice Requires="unknown">${box(choice)}</mc:Choice><mc:Fallback>${box(fallback)}</mc:Fallback></mc:AlternateContent>`;
  const input = await packageOf(alt('仅备选：____', '相同：____') + box('相同：____') + box('相同：____') + alt('另一备选：____', '相同：____'));
  const result = await readDocument(input, { mode: 'blocks' });
  const boxes = result.items.filter(item => item.label?.includes('文本框'));
  assert.equal(boxes.length, 4);
  assert.ok(boxes.every(item => item.text.includes('相同：⟦0:____⟧')));
  assert.equal(new Set(boxes.map(item => item.location)).size, 4);
});

test('search is literal and shows bounded source context rather than matching annotations', async () => {
  const bytes = await packageOf(p('前'.repeat(100) + '字面[.*]命中' + '后'.repeat(100)) + p('只有点号.这不是字面模式') + '<w:p><w:r><w:drawing/></w:r></w:p>');
  const result = await readDocument(bytes, { mode: 'search', query: '[.*]', context: 4 });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].address, 'p:0');
  assert.ok(result.items[0].text.length < 40); assert.match(result.items[0].text, /字面\[\.\*\]命中/);
  assert.equal((await readDocument(bytes, { mode: 'search', query: '[图片]' })).items.length, 0);
  await assert.rejects(readDocument(bytes, { mode: 'search', query: '' }));
  const unicode = await readDocument(await packageOf(p('😀命中😀')), { mode: 'search', query: '命中', context: 1 });
  assert.equal(texts(unicode), '😀命中😀');
});

test('character and item limits have replayable continuations even inside one huge block', async () => {
  const bytes = await packageOf(p('长段😀'.repeat(120)) + Array.from({ length: 70 }, (_, i) => p(`尾段${i}`)).join(''));
  const complete = await readDocument(bytes, { mode: 'blocks', maxChars: 50000, limit: 200 });
  let options: ReadDocumentOptions | null = { mode: 'blocks', maxChars: 37, limit: 3 };
  const parts: string[] = [];
  let pages = 0;
  while (options) {
    assert.ok(++pages < 300);
    const result = await readDocument(bytes, options);
    assert.ok(result.items.length <= 3); assert.ok(result.characters <= 37);
    for (const item of result.items) { assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(item.text)); parts.push(item.text); }
    assert.equal(result.truncated, result.next !== null);
    options = result.next;
  }
  assert.ok(pages > 2); assert.equal(parts.join(''), texts(complete));
  const first = await readDocument(bytes, { mode: 'blocks', maxChars: 37 });
  await assert.rejects(readDocument(await packageOf(p('文档已变化'.repeat(300))), first.next!));
  await assert.rejects(readDocument(bytes, { ...first.next!, mode: 'search', query: '长段' }));
  await assert.rejects(readDocument(bytes, { mode: 'blocks', from: 'p:99999' }));
});

test('public outline exposes parent links, section ranges and recursive counts', async () => {
  const body = p('父标题', '<w:outlineLvl w:val="0"/>') + `<w:tbl><w:tr><w:tc>${p('____')}<w:tbl><w:tr><w:tc>${p('嵌套')}</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>` + p('子标题', '<w:outlineLvl w:val="1"/>') + p('尾文');
  const result = await readDocument(await packageOf(body), { mode: 'outline' });
  assert.deepEqual(result.items.map(item => [item.text, item.level, item.parent]), [['父标题', 1, null], ['子标题', 2, 'p:0']]);
  assert.deepEqual(result.items[0].range, { from: 'p:0', to: 'p:2' });
  assert.equal(result.items[0].counts!.tables, 2); assert.equal(result.items[0].counts!.paragraphs, 5); assert.equal(result.items[0].counts!.hints, 1);
});

test('hidden style toggles and direct false are displayed without changing the plain compatibility API', async () => {
  const styles = '<w:styles xmlns:w="word"><w:style w:type="paragraph" w:styleId="Hidden"><w:rPr><w:vanish/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Visible"><w:basedOn w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style></w:styles>';
  const body = p('样式隐藏', '<w:pStyle w:val="Hidden"/>') + p('两次切换可见', '<w:pStyle w:val="Visible"/>') + '<w:p><w:pPr><w:pStyle w:val="Hidden"/></w:pPr><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>直接关闭可见</w:t></w:r></w:p>';
  const bytes = await packageOf(body, '<Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles/custom.xml"/>', [['word/styles/custom.xml', styles]]);
  assert.equal(texts(await readDocument(bytes, { mode: 'blocks' })), '‹隐藏›样式隐藏‹/隐藏›两次切换可见直接关闭可见');
  assert.equal(bodyBlocks(doc(body))[0].text, '样式隐藏');
  const relation = '<Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  for (const definition of ['<w:style w:type="character" w:styleId="DefaultChar" w:default="1"><w:rPr><w:vanish/></w:rPr></w:style>', '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>']) {
    const defaults = await packageOf(p('默认隐藏'), relation, [['word/styles.xml', `<w:styles xmlns:w="word">${definition}</w:styles>`]]);
    assert.equal(texts(await readDocument(defaults, { mode: 'blocks' })), '‹隐藏›默认隐藏‹/隐藏›');
  }
});

test('pending anchors can be scoped to a cell and unknown or ambiguous anchors are reported', async () => {
  const body = `<w:tbl><w:tr><w:tc>${p('甲')}${p('待定内容')}${p('尾段')}</w:tc><w:tc>${p('待定内容')}</w:tc></w:tr></w:tbl>`;
  const bytes = await packageOf(body);
  const marked = await readDocument(bytes, { mode: 'blocks' }, { pending: [{ address: 't:0/r:0/c:0', find: '待定内容', category: '类别' }] });
  assert.equal((texts(marked).match(/«待定:类别»待定内容«\/待定»/g) ?? []).length, 1);
  const stale = await readDocument(bytes, { mode: 'blocks' }, { pending: [{ address: 'p:99', find: '待定内容', category: '类别' }, { address: 't:0', find: '待定内容', category: '类别' }] });
  assert.equal(stale.warnings.length, 2); assert.ok(!texts(stale).includes('«待定:'));
});

test('underlined spaces and empty noncontinuation cells have stable public hint labels', async () => {
  const body = '<w:p><w:r><w:t>留白：</w:t></w:r><w:r><w:rPr><w:u/></w:rPr><w:t xml:space="preserve">   </w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>';
  const bytes = await packageOf(body);
  const one = await readDocument(bytes, { mode: 'blocks' }), two = await readDocument(bytes, { mode: 'blocks' });
  assert.deepEqual(one, two);
  assert.match(texts(one), /留白：⟦0:   ⟧/);
  assert.equal(one.items.find(item => item.address === 't:0/r:0/c:0')!.text, '⟦0:⟧');
  assert.equal(one.items.find(item => item.address === 't:0/r:0/c:1')!.text, '〃');
});

test('unreadable or malformed referenced stories fail explicitly instead of disappearing', async () => {
  await assert.rejects(readDocument(await packageOf('<w:sectPr><w:headerReference r:id="missing"/></w:sectPr>'), { mode: 'blocks' }), /缺少关系/);
  await assert.rejects(readDocument(await packageOf('<w:sectPr><w:headerReference/></w:sectPr>'), { mode: 'blocks' }), /缺少标识/);
  await assert.rejects(readDocument(await packageOf(p('正文'), '<Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>', [['word/styles.xml', '<w:wrong xmlns:w="word"/>']]), { mode: 'blocks' }), /样式部件根节点/);
  const body = '<w:p><w:r><w:footnoteReference w:id="4"/></w:r></w:p>';
  const relation = '<Relationship Id="n" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="notes.xml"/>';
  await assert.rejects(readDocument(await packageOf(body, relation, [['word/notes.xml', '<w:wrong xmlns:w="word"/>']]), { mode: 'blocks' }), /根节点/);
  await assert.rejects(readDocument(await packageOf(body, relation, [['word/notes.xml', '<w:footnotes xmlns:w="word"/>']]), { mode: 'blocks' }), /记录不存在/);
});

test('reading before real primitive editing leaves source anchors and object placement usable', async () => {
  const body = '<w:p><w:r><w:drawing/><w:t>甲</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏干扰</w:t></w:r><w:r><w:t>____</w:t><w:object/><w:t>尾部</w:t></w:r></w:p>';
  const input = await packageOf(body), original = input.slice();
  const viewed = await readDocument(input, { mode: 'blocks' });
  const item = viewed.items.find(item => item.text.includes('____'))!;
  assert.equal(item.address, 'p:0');
  assert.equal(bodyBlocks(doc(body))[0].hints[0].start, 1);
  const output = await editTextDocument(input, [{ op: 'replace', at: item.address!, find: '____', value: '已填写' }]);
  const updated = texts(await readDocument(output, { mode: 'blocks' }));
  assert.match(updated, /\[图片\]甲‹隐藏›隐藏干扰‹\/隐藏›已填写\[对象\]尾部/);
  assert.deepEqual(input, original);
});

test('default search and outline item limits continue with the original request intact', async () => {
  const bytes = await packageOf(Array.from({ length: 65 }, (_, i) => p(`标题命中${i}`, '<w:outlineLvl w:val="0"/>')).join(''));
  for (const [mode, expected] of [['search', 30], ['outline', 60]] as const) {
    const first = await readDocument(bytes, { mode, ...(mode === 'search' ? { query: '命中' } : {}) });
    assert.equal(first.items.length, expected); assert.ok(first.next); assert.match(first.notice!, /截断/);
    const second = await readDocument(bytes, first.next!);
    assert.equal(second.items[0].address, `p:${expected}`);
    assert.equal(second.mode, mode);
  }
  for (const option of [{ mode: 'blocks', limit: 201 }, { mode: 'blocks', maxChars: 1 }, { mode: 'search', query: '命中', context: 201 }] as const) await assert.rejects(readDocument(bytes, option));
});

test('hundreds of trusted pending anchors remain complete across compact continuation pages', async () => {
  const values = Array.from({ length: 320 }, (_, i) => `待定项${i}`);
  const bytes = await packageOf(values.map(value => p(value)).join(''));
  const display = { pending: values.map((find, i) => ({ address: `p:${i}`, find, category: '类别' })) };
  let options: ReadDocumentOptions | null = { mode: 'blocks', limit: 17, maxChars: 320 };
  const parts: string[] = [];
  let pages = 0;
  while (options) {
    assert.ok(++pages < 100);
    const result = await readDocument(bytes, options, display);
    assert.ok(result.characters <= 320); assert.ok(result.items.length <= 17);
    parts.push(texts(result));
    if (result.next) {
      assert.ok(!('pending' in result.next));
      assert.ok(JSON.stringify(result.next).length < 800);
    }
    options = result.next;
  }
  assert.ok(pages > 10);
  assert.equal(parts.join(''), values.map(value => `«待定:类别»${value}«/待定»`).join(''));
});

test('continuations reject forgotten or changed trusted pending context', async () => {
  const values = Array.from({ length: 300 }, (_, i) => `待定项${i}`);
  const bytes = await packageOf(values.map(value => p(value)).join(''));
  const pending = values.map((find, i) => ({ address: `p:${i}`, find, category: '类别' }));
  const first = await readDocument(bytes, { mode: 'blocks', limit: 1 }, { pending });
  assert.ok(first.next);
  await assert.rejects(readDocument(bytes, { mode: 'blocks', pending } as unknown as ReadDocumentOptions), /上下文/);
  await assert.rejects(readDocument(bytes, first.next!), /续读/);
  await assert.rejects(readDocument(bytes, first.next!, { pending: pending.slice(0, -1) }), /续读/);
  await assert.rejects(readDocument(bytes, first.next!, { pending: pending.map((mark, i) => i === 299 ? { ...mark, category: '已变化' } : mark) }), /续读/);
  const replay = await readDocument(bytes, first.next!, { pending: pending.map(mark => ({ category: mark.category, find: mark.find, address: mark.address })) });
  assert.equal(texts(replay), '«待定:类别»待定项1«/待定»');
});

test('large trusted contexts keep continuation payloads and unresolved-anchor diagnostics bounded', async () => {
  const values = Array.from({ length: 256 }, (_, i) => `待定项${i}：${'字'.repeat(3900)}`);
  const bytes = await packageOf(values.map(value => p(value)).join(''));
  const invalid = Array.from({ length: 300 }, () => ({ address: 'p:99999', find: '不存在的锚点', category: '类别' }));
  const pending = [...invalid, ...values.map((find, i) => ({ address: `p:${i}`, find, category: '类别' }))];
  const result = await readDocument(bytes, { mode: 'blocks', limit: 1, maxChars: 100 }, { pending });
  assert.match(texts(result), /^«待定:类别»待定项0：/);
  assert.equal(result.warningCount, 300); assert.equal(result.warningsTruncated, true);
  assert.equal(result.warnings.length, 20);
  assert.ok(result.warnings.every(warning => warning.length <= 200));
  assert.ok(result.next); assert.ok(!('pending' in result.next));
  assert.ok(JSON.stringify(result.next).length < 800);
  assert.ok(result.characters <= 100);
  assert.ok(JSON.stringify(result).length < 8000);
});
