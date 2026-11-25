import { test } from 'node:test';

import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';

import { promisify } from 'node:util';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import * as path from 'node:path';

import { writeZip } from '../src/core/docx/zip.js';

const exec = promisify(execFile);

const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, ['--import', 'tsx', 'src/shells/cli/index.ts', ...args])).stdout);

test('CLI reads and updates hints in nested cells without storing hint identities', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/hint-current-'));
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'home');
  try {
    const enc = new TextEncoder(), source = path.join(sandbox, 'source.docx'), root = path.join(sandbox, 'project');
    const body = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名：____</w:t></w:r></w:p></w:tc><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>嵌套：（单位名称）</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr></w:tbl>';
    const original = await writeZip(new Map([['[Content_Types].xml', enc.encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')], ['word/document.xml', enc.encode(`<w:document xmlns:w="word"><w:body>${body}<w:sectPr/></w:body></w:document>`)]]));
    await writeFile(source, original);
    await cli('project', 'init', '--root', root, '--name', 'test', '--deadline', '2028-12-31', '--tender', source);
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 't:0', to: 't:0' }]));
    const nested = 't:0/r:0/c:1/t:0/r:0/c:0/p:0', first = 't:0/r:0/c:0/p:0';
    const initial = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(initial.results.C02.some((item: { address: string }) => item.address === nested));
    assert.ok(initial.results.C02.some((item: { address: string }) => item.address === first));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'replace', at: first, blank: 0, value: '某人' }, { op: 'dismiss_hint', at: nested, blank: 0, reason: '不适用' }]));
    const dismissed = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(dismissed.results.C03.some((item: { address: string }) => item.address === nested));
    assert.ok(!dismissed.results.C02.some((item: { address: string }) => item.address === first));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'replace', at: nested, find: '嵌套', value: '变更' }]));
    const changed = await cli('check', '--project', root, '--draft', 'bid');
    assert.ok(changed.results.C02.some((item: { address: string }) => item.address === nested));
    assert.ok(!changed.results.C03.some((item: { address: string }) => item.address === nested));
    const ledger = JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8'));
    assert.equal(ledger.hints, undefined);
    assert.deepEqual(await readFile(source), Buffer.from(original));
  } finally {
    if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('CLI checks dates in nested table paragraphs as well as the top level', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/nested-dates-'));
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'home');
  try {
    const enc = new TextEncoder(), source = path.join(sandbox, 'source.docx'), root = path.join(sandbox, 'project');
    const body = '<w:p><w:r><w:t>顶部</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>外层</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>内层</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>';
    await writeFile(source, await writeZip(new Map([
      ['[Content_Types].xml', enc.encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
      ['word/document.xml', enc.encode(`<w:document xmlns:w="word"><w:body>${body}<w:sectPr/></w:body></w:document>`)]])));
    await cli('project', 'init', '--root', root, '--name', 'test', '--deadline', '2028-12-31', '--tender', source);
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 't:0' }]));
    const addresses = ['p:0', 't:0/r:0/c:0/p:0', 't:0/r:0/c:0/t:0/r:0/c:0/p:0'];
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify(addresses.map(at => ({ op: 'insert', at, position: 'after', markdown: '2027年2月29日' }))));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'insert', at: 'p:0', position: 'before', markdown: '2028年2月29日' }]));
    const report = await cli('check', '--project', root, '--draft', 'bid');
    assert.equal(report.results.C11.length, 3);
    assert.ok(report.results.C11.some((item: { address: string }) => item.address.includes('/t:0/r:0/c:0/p:')));
  } finally {
    if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous;
    await rm(sandbox, { recursive: true, force: true });
  }
});
