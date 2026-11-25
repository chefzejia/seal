import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { writeZip } from '../src/core/docx/zip.js';

const run = promisify(execFile);
const enc = (s: string) => new TextEncoder().encode(s);
const p = (s: string) => `<w:p><w:r><w:t>${s}</w:t></w:r></w:p>`;

test('CLI reports referenced read-only hints separately, even when C02 is truncated', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/readonly-check-'));
  const cli = async (...args: string[]) => JSON.parse((await run(process.execPath, ['--import', 'tsx', 'src/shells/cli/index.ts', ...(args[0] === 'init' ? ['project'] : []), ...args], { env: { ...process.env, SEAL_HOME: path.join(sandbox, 'home') } })).stdout);
  try {
    const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
    const body = Array.from({ length: 55 }, (_, i) => p(`正文${i}：____`)).join('') + `<w:p><w:r><w:drawing><w:txbxContent>${p('文本框：____')}</w:txbxContent></w:drawing><w:footnoteReference w:id="4"/><w:endnoteReference w:id="8"/><w:commentReference w:id="7"/></w:r></w:p><w:sectPr><w:headerReference r:id="h"/><w:footerReference r:id="f"/></w:sectPr>`;
    const parts: Array<[string, string]> = [
      ['[Content_Types].xml', '<Types><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/xml"/></Types>'],
      ['word/document.xml', `<w:document xmlns:w="word" xmlns:r="relations"><w:body>${body}</w:body></w:document>`],
      ['word/_rels/document.xml.rels', `<Relationships>${rel('h', 'header', 'header.xml')}${rel('f', 'footer', 'footer.xml')}${rel('n', 'footnotes', 'footnotes.xml')}${rel('e', 'endnotes', 'endnotes.xml')}${rel('c', 'comments', 'comments.xml')}${rel('orphan', 'header', 'orphan.xml')}</Relationships>`],
      ['word/header.xml', `<w:hdr>${Array.from({ length: 52 }, (_, i) => p(`页眉${i}：____`)).join('')}</w:hdr>`],
      ['word/footer.xml', `<w:ftr>${p('页脚：____')}</w:ftr>`],
      ['word/orphan.xml', `<w:hdr>${p('孤立：____')}</w:hdr>`],
      ['word/footnotes.xml', `<w:footnotes><w:footnote w:id="4">${p('脚注：____')}</w:footnote><w:footnote w:id="5">${p('未引用：____')}</w:footnote></w:footnotes>`],
      ['word/endnotes.xml', `<w:endnotes><w:endnote w:id="8">${p('尾注：____')}</w:endnote></w:endnotes>`],
      ['word/comments.xml', `<w:comments><w:comment w:id="7">${p('批注：____')}</w:comment></w:comments>`],
    ];
    const source = path.join(sandbox, 'source.docx'), root = path.join(sandbox, 'project');
    await writeFile(source, await writeZip(new Map(parts.map(([name, value]) => [name, enc(value.replace(/<w:(hdr|ftr|footnotes|endnotes|comments)>/, '<w:$1 xmlns:w="word">'))]))));
    await cli('init', '--root', root, '--name', '测试', '--deadline', '2028-02-29', '--tender', source);
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', '商务', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:55' }]));
    const view = await cli('read', '--project', root, '--file', '商务', '--mode', 'blocks', '--limit', '200');
    const report = await cli('check', '--project', root, '--draft', '商务', '--group', 'C02');
    assert.equal(report.readonlyHints.count, 57);
    assert.equal(report.readonlyHints.items.length, 50);
    assert.equal(report.readonlyHints.remaining, 7);
    assert.equal(report.readonlyHints.truncated, true);
    assert.equal(report.readonlyHints.continuation.tool, 'seal_doc_read');
    assert.deepEqual(report.readonlyHints.continuation.arguments, { file: '商务', mode: 'blocks', limit: 50 });
    assert.match(report.readonlyHints.continuation.instruction, /next/);
    let options: any = report.readonlyHints.continuation.arguments;
    const readLocations = new Set<string>();
    let pages = 0;
    do {
      assert.ok(++pages < 20);
      const page = await cli('read', '--project', root, '--file', options.file ?? '商务', '--mode', options.mode, '--limit', String(options.limit), ...(options.maxChars === undefined ? [] : ['--max-chars', String(options.maxChars)]), ...(options.context === undefined ? [] : ['--context', String(options.context)]), ...(options.cursor ? ['--cursor', JSON.stringify(options.cursor)] : []));
      for (const item of page.items) if (!item.editable) readLocations.add(item.location);
      options = page.next;
    } while (options);
    for (const location of ['word/footer.xml#p:0', 'word/footnotes.xml#footnote:4#p:0', 'word/endnotes.xml#endnote:8#p:0', 'word/comments.xml#comment:7#p:0']) assert.ok(readLocations.has(location), location);
    assert.equal(report.counts.C02, 112);
    assert.equal(report.remaining.C02, 62);
    for (const item of report.readonlyHints.items) {
      assert.equal(item.editable, false); assert.equal(item.address, null);
      assert.match(item.label, /不可编辑/);
      assert.ok(view.items.some((entry: any) => entry.location === item.location && entry.editable === false));
    }
    assert.equal(new Set(report.readonlyHints.items.map((item: any) => item.id)).size, 50);
    assert.ok(!JSON.stringify(report).includes('orphan.xml'));
    assert.ok(!JSON.stringify(report).includes('footnote:5'));
    const shortSource = path.join(sandbox, 'short.docx'), shortRoot = path.join(sandbox, 'short-project');
    await writeFile(shortSource, await writeZip(new Map(parts.map(([name, value]) => [name, enc((name === 'word/header.xml' ? `<w:hdr>${p('页眉：____')}</w:hdr>` : value).replace(/正文(\d+)：____/g, '正文$1：完成').replace(/<w:(hdr|ftr|footnotes|endnotes|comments)>/, '<w:$1 xmlns:w="word">'))]))));
    await cli('init', '--root', shortRoot, '--name', '测试', '--deadline', '2028-02-29', '--tender', shortSource);
    await cli('extract', '--project', shortRoot, '--tender', 'tender/1.docx', '--draft', '商务', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:55' }]));
    const short = await cli('check', '--project', shortRoot, '--draft', '商务', '--group', 'C02');
    assert.equal(short.readonlyHints.count, 6);
    assert.equal(short.readonlyHints.remaining, 0);
    for (const label of ['页眉', '页脚', '脚注', '尾注', '批注', '文本框']) assert.ok(short.readonlyHints.items.some((item: any) => item.label.includes(label)), label);
    assert.equal(short.results.C02.filter((item: any) => item.editable === false).length, 6);
    assert.equal(short.counts.C02, 6);
    const otherGroup = await cli('check', '--project', shortRoot, '--draft', '商务', '--group', 'C04');
    assert.equal(otherGroup.readonlyHints, undefined);
    const cleanSource = path.join(sandbox, 'clean.docx'), cleanRoot = path.join(sandbox, 'clean-project');
    await writeFile(cleanSource, await writeZip(new Map(parts.map(([name, value]) => [name, enc(value.replaceAll('____', '完成').replace(/<w:(hdr|ftr|footnotes|endnotes|comments)>/, '<w:$1 xmlns:w="word">'))]))));
    await cli('init', '--root', cleanRoot, '--name', '测试', '--deadline', '2028-02-29', '--tender', cleanSource);
    await cli('extract', '--project', cleanRoot, '--tender', 'tender/1.docx', '--draft', '商务', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:55' }]));
    const clean = await cli('check', '--project', cleanRoot, '--draft', '商务', '--group', 'C02');
    assert.equal(clean.readonlyHints.count, 0);
    assert.deepEqual(clean.results.C02, []);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test('CLI counts mutually exclusive real textbox representations once per object', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/readonly-alt-'));
  const cli = async (...args: string[]) => JSON.parse((await run(process.execPath, ['--import', 'tsx', 'src/shells/cli/index.ts', ...(args[0] === 'init' ? ['project'] : []), ...args], { env: { ...process.env, SEAL_HOME: path.join(sandbox, 'home') } })).stdout);
  try {
    for (const [fixture, expected] of [['readonly-single-textbox.docx', 1], ['readonly-two-textboxes.docx', 2]] as const) {
      const source = path.resolve('tests/fixtures', fixture), original = await readFile(source), root = path.join(sandbox, fixture);
      await cli('init', '--root', root, '--name', '测试', '--deadline', '2028-02-29', '--tender', source);
      const tender = await cli('read', '--project', root, '--file', 'tender/1.docx', '--mode', 'blocks', '--limit', '200');
      const top = tender.items.filter((item: any) => item.editable && item.address && !item.address.includes('/'));
      await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', '商务', '--ranges', JSON.stringify([{ from: top[0].address, to: top.at(-1).address }]));
      const view = await cli('read', '--project', root, '--file', '商务', '--mode', 'blocks', '--limit', '200');
      const report = await cli('check', '--project', root, '--draft', '商务', '--group', 'C02');
      assert.equal(view.items.filter((item: any) => item.label?.includes('文本框') && item.text.includes('____')).length, expected);
      assert.equal(report.readonlyHints.items.filter((item: any) => item.label?.includes('文本框')).length, expected);
      assert.equal(report.readonlyHints.count, expected + 5);
      assert.deepEqual(await readFile(source), original);
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});
