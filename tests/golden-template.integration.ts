import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const golden = process.env.SEAL_GOLDEN_DOC;
const run = promisify(execFile);

test('golden bid letter and appendix are filled and checked through the CLI without altering the source', { skip: !golden }, async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/golden-cli-'));
  try {
    const source = path.resolve(golden!), original = await readFile(source), root = path.join(sandbox, 'project');
    assert.equal(createHash('sha256').update(original).digest('hex'), 'b2b444a53aa91864b33b847fb0a015d411b716ddf653a6aa2bd7be58a11cf87c');
    const cli = async (...args: string[]) => JSON.parse((await run(process.execPath, ['--import', 'tsx', 'src/shells/cli/index.ts', ...args], { env: { ...process.env, SEAL_HOME: path.join(sandbox, 'home') }, maxBuffer: 20_000_000 })).stdout);
    await cli('project', 'init', '--root', root, '--name', 'golden', '--deadline', '2028-12-31', '--tender', source);
    const outline = await cli('read', '--project', root, '--file', 'tender/1.docx', '--mode', 'outline');
    assert.ok(Array.isArray(outline.items));
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'sample', '--ranges', JSON.stringify([{ from: 'p:776', to: 'p:798' }, { from: 't:21', to: 't:21' }]));
    const before = await cli('read', '--project', root, '--file', 'sample', '--mode', 'blocks', '--limit', '200');
    assert.ok(before.items.some((item: { text: string }) => item.text.includes('（一）投标函')));
    const edits = [
      { op: 'replace', at: 'p:1', blank: 1, value: '待确认招标人' },
      { op: 'replace', at: 'p:2', blank: 1, value: '待确认项目名称' },
      { op: 'replace', at: 'p:11', blank: 0, value: '示例投标人（待核验）' },
      { op: 'replace', at: 'p:15', blank: 0, value: '2026年8月31日' },
      { op: 'replace', at: 'p:19', blank: 0, value: '示例投标人（待核验）' },
      { op: 'replace', at: 'p:21', blank: 0, value: '2026年8月31日' },
      { op: 'set_cell', at: 't:0/r:1/c:3', value: '待确认交货期限' },
      { op: 'set_cell', at: 't:0/r:2/c:3', value: '待确认质保期' },
      { op: 'insert_rows', at: 't:0/r:3', mode: 'after', rows: [['3', '其他承诺', '待核对', '待确认', '待核对']] },
      { op: 'check', at: 't:1/r:0/c:0/p:0', option: '我公司已详细阅读招标文件中各项商务要求，所有商务要求均无偏离', checked: true, pending: { category: '偏离', note: '须人确认' } },
      { op: 'insert', at: 'p:8', position: 'after', markdown: '### 履约安排\n\n供货与安装方案待核实。' },
    ];
    const edited = await cli('edit', '--project', root, '--draft', 'sample', '--ops', JSON.stringify(edits));
    assert.equal(edited.results.length, edits.length);
    assert.ok(edited.results.every((item: { status: string }) => item.status === 'applied'));
    const after = await cli('read', '--project', root, '--file', 'sample', '--mode', 'blocks', '--limit', '200');
    for (const text of ['待确认招标人', '待确认项目名称', '示例投标人', '待确认交货期限', '待确认质保期', '履约安排']) assert.ok(after.items.some((item: { text: string }) => item.text.includes(text)), text);
    assert.equal(after.items.filter((item: { text: string }) => item.text.includes('2026年8月31日')).length, 2);
    const report = await cli('check', '--project', root, '--draft', 'sample');
    for (const group of ['C01', 'C10', 'C11', 'C15']) assert.deepEqual(report.results[group], [], group);
    assert.ok(report.results.C04.length);
    assert.deepEqual(await readFile(source), original);
    if (process.env.SEAL_GOLDEN_EVIDENCE) {
      const evidence = path.resolve(process.env.SEAL_GOLDEN_EVIDENCE), temporaryRoot = path.resolve('.tmp');
      assert.ok(evidence.startsWith(`${temporaryRoot}${path.sep}`));
      await mkdir(evidence, { recursive: true });
      await copyFile(path.join(root, 'draft', 'sample.docx'), path.join(evidence, 'worker-golden.docx'));
      await copyFile(path.join(root, 'draft', 'sample.base.docx'), path.join(evidence, 'worker-golden.base.docx'));
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});
