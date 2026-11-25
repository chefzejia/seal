import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileBatch } from '../src/shells/atomic-files.js';

test('batch write restores all prior files when a later replacement fails', async () => {
  await mkdir('.tmp', { recursive: true });
  const directory = await mkdtemp(path.resolve('.tmp/atomic-files-'));
  try {
    const draft = path.join(directory, 'draft'), ledger = path.join(directory, 'ledger');
    await writeFile(draft, 'old draft');
    await writeFile(ledger, 'old ledger');
    let calls = 0;
    await assert.rejects(writeFileBatch([
      { path: draft, data: Buffer.from('new draft') },
      { path: ledger, data: Buffer.from('new ledger') },
    ], async (from, to) => {
      if (++calls === 2) throw new Error('injected second replacement failure');
      return rename(from, to);
    }), /injected second replacement failure/);
    assert.equal(await readFile(draft, 'utf8'), 'old draft');
    assert.equal(await readFile(ledger, 'utf8'), 'old ledger');
    assert.deepEqual((await readdir(directory)).sort(), ['draft', 'ledger']);
    await writeFileBatch([{ path: draft, data: Buffer.from('new draft') }, { path: ledger, data: Buffer.from('new ledger') }]);
    assert.equal(await readFile(draft, 'utf8'), 'new draft');
    assert.equal(await readFile(ledger, 'utf8'), 'new ledger');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('batch write removes newly created files when a later replacement fails', async () => {
  await mkdir('.tmp', { recursive: true });
  const directory = await mkdtemp(path.resolve('.tmp/atomic-files-'));
  try {
    const created = path.join(directory, 'created'), ledger = path.join(directory, 'ledger');
    await writeFile(ledger, 'old ledger');
    await assert.rejects(writeFileBatch([
      { path: created, data: Buffer.from('new'), createOnly: true },
      { path: ledger, data: Buffer.from('changed') },
    ], async () => { throw new Error('injected replacement failure'); }), /injected replacement failure/);
    assert.deepEqual(await readdir(directory), ['ledger']);
    assert.equal(await readFile(ledger, 'utf8'), 'old ledger');
    await assert.rejects(writeFileBatch([{ path: ledger, data: Buffer.from('overwrite'), createOnly: true }]));
    assert.equal(await readFile(ledger, 'utf8'), 'old ledger');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
