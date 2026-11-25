import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeHostPort } from '../src/shells/node-host.js';
import { runKnowledgeBase } from '../src/shells/cli/kb.js';
import { runProject } from '../src/shells/cli/project-v2.js';
import { workflowTemplate } from './fixtures/workflow-template.js';

test('kb CLI entrypoints isolate SEAL_HOME and expose search/get/save without a verification command', async t => {
  const home = path.resolve('.tmp', `kb-cli-${randomUUID()}`);
  await fs.mkdir(home, { recursive: true });
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous; await fs.rm(home, { recursive: true, force: true }); });
  const host = new NodeHostPort();
  const created = await runKnowledgeBase(host, ['init', '--vault', 'cli-test-vault', '--name', '合成资料柜']) as { format: string; vaultId: string };
  assert.equal(created.format, 'seal-kb-2');
  const saved = await runKnowledgeBase(host, ['save', '--vault', created.vaultId, '--data', JSON.stringify({
    action: 'create', kind: 'record', fields: { title: '合成证据', type: '其他', holder: '合成主体', tags: ['正控'] }, body: '用于测试检索。',
  })]) as { id: string; verified: boolean };
  assert.match(saved.id, /^kb-/);
  assert.equal(saved.verified, false);
  const found = await runKnowledgeBase(host, ['search', '--vault', created.vaultId, '--query', '合成证据']) as Array<{ id: string }>;
  assert.equal(found.length, 1);
  assert.equal(found[0].id, saved.id);
  const full = await runKnowledgeBase(host, ['get', '--vault', created.vaultId, '--id', saved.id, '--kind', 'record']) as { body: string; fields: Record<string, unknown> };
  assert.equal(full.body, '用于测试检索。');
  assert.equal(full.fields.title, '合成证据');
  const tender = path.join(home, 'input.docx'), project = path.join(home, 'project');
  await fs.writeFile(tender, await workflowTemplate());
  await runProject(host, ['init', '--root', project, '--name', '日期验证', '--deadline', '2028-03-01', '--vault', created.vaultId, '--tender', tender]);
  const projectKb = (command: string, ...args: string[]) => runKnowledgeBase(host, [command, '--project', project, ...args]);
  await projectKb('save', '--data', JSON.stringify({ action: 'update', kind: 'subject', fields: { legalName: '合成主体' } }));
  const updated = await projectKb('save', '--data', JSON.stringify({ action: 'update', kind: 'record', id: saved.id, fields: { validUntil: '2028-02-29' } })) as { health: { referenceDate: string; validity: string; subject: string } };
  assert.equal(updated.health.referenceDate, '2028-03-01');
  assert.equal(updated.health.validity, 'expired');
  assert.equal(updated.health.subject, 'self');
  const record = await projectKb('get', '--id', saved.id) as typeof updated;
  assert.deepEqual(record.health, updated.health);
  const expired = await projectKb('search', '--validity', 'expired') as Array<{ id: string; validity: string }>;
  assert.deepEqual(expired.map(item => [item.id, item.validity]), [[saved.id, 'expired']]);
  await assert.rejects(runKnowledgeBase(host, ['search', '--vault', created.vaultId, '--validity', 'expired']), /--reference-date/);
  await assert.rejects(runKnowledgeBase(host, ['verify', '--vault', created.vaultId, '--id', saved.id]), /支持的知识库命令/);
  await assert.rejects(runKnowledgeBase(host, ['save', '--vault', created.vaultId, '--data', JSON.stringify({
    action: 'update', kind: 'record', id: saved.id, fields: { verified: true },
  })]), /不能设置核实字段/);
  assert.ok((await fs.readdir(home)).includes('vaults'));
});

test('kb ingest lists every batch candidate and rolls back when its Agent log cannot commit', async t => {
  const sandbox = path.resolve('.tmp', `kb-ingest-cli-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  await fs.mkdir(sandbox, { recursive: true });
  t.after(async () => { if (previous === undefined) delete process.env.SEAL_HOME; else process.env.SEAL_HOME = previous; await fs.rm(sandbox, { recursive: true, force: true }); });
  const source = path.join(sandbox, 'master.docx'), legacy = path.join(sandbox, 'legacy.doc');
  const bytes = await workflowTemplate();
  await fs.writeFile(source, bytes);
  const originalDoc = Buffer.from('read-only DOC input for shell conversion test');
  await fs.writeFile(legacy, originalDoc);
  let conversionPath: string | undefined, failLog = false;
  const host = new class extends NodeHostPort {
    async convertDocToDocx(input: string, output: string) {
      assert.equal(input, legacy);
      assert.deepEqual(await fs.readFile(input), originalDoc);
      await fs.mkdir(output, { recursive: true });
      conversionPath = path.join(output, 'legacy.docx');
      await fs.writeFile(conversionPath, bytes);
      return conversionPath;
    }
    async writeFiles(...[writes]: Parameters<NodeHostPort['writeFiles']>) {
      if (failLog && writes.some(write => write.path.endsWith('log.jsonl'))) throw new Error('injected log failure');
      return super.writeFiles(writes);
    }
  }();
  const vault = 'ingest-cli';
  await runKnowledgeBase(host, ['init', '--vault', vault, '--name', '合成母本']);
  const run = (command: string, ...args: string[]) => runKnowledgeBase(host, [command, '--vault', vault, ...args]);
  const input = ['--files', JSON.stringify([source, legacy, source]), '--limit', '1'];
  type Page = { batchId: string; candidates: Array<{ id: string }>; nextAfter: string | null; candidateCount: number; sourceCount: number; imageCount: number };
  const result = await run('ingest', ...input) as Page;
  assert.match(result.batchId, /^batch-/);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.imageCount, 0);
  assert.ok(result.candidateCount >= 3);
  assert.equal(result.candidates.length, 1);
  const all = result.candidates.map(item => item.id);
  for (let next = result.nextAfter; next;) {
    const page = await run('search', '--batch', result.batchId, '--after', next, '--limit', '1') as Page;
    all.push(...page.candidates.map(item => item.id));
    next = page.nextAfter;
  }
  assert.equal(new Set(all).size, result.candidateCount);
  const entries = await Promise.all(all.map(id => run('get', '--id', id))) as Array<{ fields: { source: string } }>;
  assert.ok(entries.some(entry => entry.fields.source === 'legacy.doc'));
  assert.deepEqual(await fs.readFile(legacy), originalDoc);
  assert.ok(conversionPath);
  await assert.rejects(fs.stat(conversionPath), { code: 'ENOENT' });
  const root = path.join(process.env.SEAL_HOME!, 'vaults', vault), log = path.join(root, 'log.jsonl');
  const before = await fs.readFile(log, 'utf8');
  const event = JSON.parse(before.trim().split('\n').at(-1)!);
  assert.deepEqual([event.actor, event.action, event.object], ['agent', 'ingest', `batch:${result.batchId}`]);
  failLog = true;
  await assert.rejects(run('ingest', ...input), /injected log failure/);
  assert.deepEqual(await fs.readdir(path.join(root, 'inbox')), [result.batchId]);
  assert.deepEqual(await fs.readdir(path.join(root, 'files')), [result.batchId]);
  assert.equal(await fs.readFile(log, 'utf8'), before);
  await assert.rejects(fs.stat(conversionPath), { code: 'ENOENT' });
});
