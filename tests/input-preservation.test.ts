import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertOutputIsolation } from '../src/shells/output-isolation.js';

test('output preflight rejects physical aliases and every sidecar before writes', t => {
  fs.mkdirSync('.tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.tmp/input-preservation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'source.docx'), vault = path.join(root, 'vault');
  fs.writeFileSync(input, 'ORIGINAL'); fs.mkdirSync(vault);
  const vaultFile = path.join(vault, 'subject.md'); fs.writeFileSync(vaultFile, 'ORIGINAL VAULT');
  const symlink = path.join(root, 'symlink.docx'), hardlink = path.join(root, 'hardlink.docx');
  fs.symlinkSync(input, symlink); fs.linkSync(input, hardlink);
  const vaultAlias = path.join(root, 'vault-alias'); fs.symlinkSync(vault, vaultAlias);
  const vaultHardlink = path.join(root, 'vault-hardlink.json'); fs.linkSync(vaultFile, vaultHardlink);
  for (const output of [input, path.join(root, 'x/../source.docx'), symlink, hardlink, vaultHardlink, path.join(vaultAlias, 'new.json')]) {
    assert.throws(() => assertOutputIsolation({ files: [path.join(root, 'safe.docx'), output] }, { files: [input], directories: [vault] }), /must not overwrite/);
    assert.equal(fs.existsSync(path.join(root, 'safe.docx')), false);
  }
  const out = path.join(root, 'out'); fs.mkdirSync(out); fs.linkSync(input, path.join(out, 'future-target.json'));
  assert.throws(() => assertOutputIsolation({ directories: [out] }, { files: [input] }), /must not overwrite/);
  assert.throws(() => assertOutputIsolation({ directories: [root] }, { files: [input] }), /must not overwrite/);
  assert.throws(() => assertOutputIsolation({ files: [symlink, hardlink] }, {}), /must be distinct/);
  assert.doesNotThrow(() => assertOutputIsolation({ files: [path.join(root, 'new/output.docx')] }, { files: [input], directories: [vault] }));
  assert.equal(fs.readFileSync(input, 'utf8'), 'ORIGINAL');
});
