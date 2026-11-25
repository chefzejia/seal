import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { initializeProject, readProject } from '../src/core/bid/project.js';
import { sha256Hex, writeZip } from '../src/core/docx/zip.js';
import type { HostPort } from '../src/core/host.js';

test('project initialization copies sources and rejects duplicate directories and invalid dates', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/project-v2-'));
  try {
    const host: HostPort = {
      async readBytes(file) { return readFile(file); },
      async writeBytes(file, data) { await writeFile(file, data); },
      async readText(file) { return readFile(file, 'utf8'); },
      async writeText(file, text) { await writeFile(file, text); },
      async stat(file) { try { const value = await stat(file); return { exists: true, size: value.size, isDirectory: value.isDirectory() }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, size: 0, isDirectory: false }; throw error; } },
      async makeDirectory(dir) { await mkdir(dir); },
      async authorizationKey() { return new Uint8Array(32).fill(13); },
      async ledgerAnchorPath(projectRoot) { return path.join(projectRoot, 'anchor.json'); },
      joinPath: path.join, dirname: path.dirname,
    };
    const source = path.join(sandbox, 'source.docx');
    const input = await writeZip(new Map([
      ['[Content_Types].xml', new TextEncoder().encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
      ['word/document.xml', new TextEncoder().encode('<w:document xmlns:w="word"><w:body/></w:document>')],
    ]));
    await writeFile(source, input);
    const projectRoot = path.join(sandbox, 'project');
    const options = { name: '测试', deadline: '2028-02-29', tenders: [source], createdAt: '2026-01-01T00:00:00Z' };
    const project = await initializeProject(host, projectRoot, options);
    assert.deepEqual(await readProject(host, projectRoot), project);
    assert.deepEqual(new Uint8Array(await readFile(source)), input);
    assert.deepEqual(new Uint8Array(await readFile(path.join(projectRoot, project.tenders[0].copy))), input);
    await assert.rejects(initializeProject(host, projectRoot, options), /已存在/);
    await assert.rejects(initializeProject(host, path.join(sandbox, 'invalid'), { ...options, deadline: '2027-02-29' }), /截标日/);
    const legacy = path.join(sandbox, 'source.doc');
    await writeFile(legacy, 'original legacy bytes');
    host.convertDocToDocx = async (file, outDir) => {
      assert.ok(file.startsWith(path.join(sandbox, 'legacy-project') + path.sep));
      assert.equal(await readFile(file, 'utf8'), 'original legacy bytes');
      const converted = path.join(outDir, 'converted.docx');
      await writeFile(converted, input);
      return converted;
    };
    const legacyRoot = path.join(sandbox, 'legacy-project');
    const converted = await initializeProject(host, legacyRoot, { ...options, tenders: [legacy] });
    assert.equal(await readFile(legacy, 'utf8'), 'original legacy bytes');
    assert.equal(converted.tenders[0].sourceSha256, sha256Hex('original legacy bytes'));
    assert.equal(converted.tenders[0].sha256, sha256Hex(input));
    assert.deepEqual(new Uint8Array(await readFile(path.join(legacyRoot, converted.tenders[0].copy))), input);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
