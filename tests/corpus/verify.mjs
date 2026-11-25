import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const metadataOnly = process.argv.includes('--metadata-only');
const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.ok(manifest.samples.length >= 4 && manifest.samples.length <= 6);
assert.equal(new Set(manifest.samples.map(sample => sample.id)).size, manifest.samples.length);
assert.equal(new Set(manifest.samples.map(sample => sample.purchaser.name)).size, manifest.samples.length);
assert.ok(new Set(manifest.samples.map(sample => sample.category)).size >= 2);
assert.ok(manifest.samples.filter(sample => sample.file.format === 'pdf').length <= 1);

const entries = [...manifest.samples, manifest.golden];
for (const entry of entries) {
  const digest = entry.file?.sha256 ?? entry.sha256;
  assert.match(digest, /^[a-f0-9]{64}$/, `${entry.id}: invalid SHA256`);
  assert.ok(entry.structure.formatSection.title);
  assert.ok(entry.structure.formatSection.renderedPage1 > 0);
  assert.ok(entry.structure.forms.length >= 2);
  assert.ok(entry.structure.volumes.length > 0);
  assert.ok(entry.structure.features.length > 0);
  assert.equal(entry.labels, `labels/${entry.id}.json`);
  const labels = JSON.parse(await readFile(path.join(root, entry.labels), 'utf8'));
  assert.equal(labels.schemaVersion, 1);
  assert.equal(labels.sampleId, entry.id);
  assert.equal(labels.normalization, 'ignore-whitespace');
  assert.equal(labels.forms.length, 2);
  assert.equal(new Set(labels.forms.map(form => form.id)).size, labels.forms.length);
  const applicabilityNotes = entry.structure.selectedFormApplicability ?? [];
  assert.ok(Array.isArray(applicabilityNotes));
  assert.equal(new Set(applicabilityNotes.map(note => note.formId)).size, applicabilityNotes.length);
  for (const note of applicabilityNotes) {
    const form = labels.forms.find(candidate => candidate.id === note.formId);
    assert.ok(form?.applicability, `${entry.id}/${note.formId}: missing whole-form applicability recorded in inventory`);
    assert.deepEqual(form.applicability.source, note.source, `${entry.id}/${note.formId}: applicability source differs from inventory`);
    assert.equal(form.applicability.alternativeRequirement, note.alternativeRequirement, `${entry.id}/${note.formId}: alternative requirement differs from inventory`);
  }
  for (const form of labels.forms) {
    assert.ok(form.title && form.renderedPage1 > 0 && form.coverage.scope);
    assert.ok(Array.isArray(form.coverage.excluded));
    assert.ok(form.fields.length > 0);
    assert.equal(new Set(form.fields.map(field => field.id)).size, form.fields.length);
    for (const field of form.fields) assert.ok(field.anchor && field.position && field.meaning);
    if (form.applicability !== undefined) {
      const rule = form.applicability;
      assert.ok(applicabilityNotes.some(note => note.formId === form.id), `${entry.id}/${form.id}: whole-form applicability missing from inventory`);
      assert.ok([rule.requiredWhen, rule.notRequiredWhen].some(value => typeof value === 'string' && value.trim()));
      assert.ok(rule.source?.anchor && rule.source.position && rule.source.renderedPage1 > 0);
      if (rule.alternativeRequirement !== undefined) assert.ok(typeof rule.alternativeRequirement === 'string' && rule.alternativeRequirement.trim());
    }
  }
  if (entry.file) {
    assert.match(entry.downloadedOn, /^\d{4}-\d{2}-\d{2}$/);
    for (const address of [entry.source.pageUrl, entry.source.downloadUrl]) {
      const url = new URL(address);
      assert.ok(['http:', 'https:'].includes(url.protocol));
      assert.ok(url.hostname.endsWith('.gov.cn') || url.hostname.endsWith('.edu.cn'));
    }
    assert.equal(entry.file.relativePath, `${entry.id}/tender.${entry.file.format}`);
  } else {
    assert.equal(entry.inputEnv, 'SEAL_GOLDEN_DOC');
    assert.ok(!Object.hasOwn(entry, 'path') && !Object.hasOwn(entry, 'fileName'));
  }
  if (!metadataOnly) {
    const input = entry.file
      ? path.join(assertEnv('SEAL_CORPUS_DIR'), entry.file.relativePath)
      : assertEnv(entry.inputEnv);
    const data = await readFile(input);
    assert.equal(createHash('sha256').update(data).digest('hex'), digest, `${entry.id}: SHA256 mismatch`);
    if (entry.file) {
      assert.equal(data.length, entry.file.bytes, `${entry.id}: byte count mismatch`);
      assert.ok(entry.file.format === 'pdf' ? data.subarray(0, 5).toString() === '%PDF-' : data.subarray(0, 2).toString() === 'PK', `${entry.id}: wrong file signature`);
    }
  }
  console.log(`${entry.id}: ${metadataOnly ? 'metadata' : digest} (${labels.forms.map(form => form.fields.length).join(' + ')} locations)`);
}

function assertEnv(name) {
  assert.ok(process.env[name], `Set ${name} explicitly; corpus checks never discover private files.`);
  return process.env[name];
}
