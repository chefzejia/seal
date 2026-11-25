import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { constraintCases } from './fixtures/layout-constraints.js';
import { packageDocument } from './fixtures/layout-matrix.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const semver: { satisfies(version: string, range: string): boolean } = createRequire(require.resolve('sharp'))('semver');
const originalDocx = Buffer.from('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', 'base64');

function packageRoot(name: string, owner: NodeJS.Require): string {
  for (const directory of owner.resolve.paths(name) ?? []) {
    const manifest = path.join(directory, name, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) return fs.realpathSync(path.dirname(manifest));
  }
  throw Object.assign(new Error(`Installed runtime package is missing: ${name}`), { code: 'MODULE_NOT_FOUND' });
}

/** Materialize installed runtime bytes; package peers are supplied separately by the real ASAR loader. */
function copyRuntimeDependencies(root: string, packageDir: string, dependencies: Record<string, string>): unknown[] {
  const installed = createRequire(path.join(root, 'package.json'));
  const targets = new Map<string, string>();
  const copied = new Set<string>();
  const records: unknown[] = [];
  const copy = (name: string, range: string, owner: NodeJS.Require, destinationOwner: string): void => {
    const source = packageRoot(name, owner);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    assert.ok(semver.satisfies(manifest.version, range), `${name}@${manifest.version} does not satisfy packaged ${range}`);
    const shared = path.join(packageDir, 'node_modules', name);
    const destination = !targets.has(shared) || targets.get(shared) === source ? shared : path.join(destinationOwner, 'node_modules', name);
    if (copied.has(destination)) return;
    targets.set(destination, source);
    copied.add(destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, dereference: true, filter: input => input === source || path.basename(input) !== 'node_modules' });
    records.push({ name, version: manifest.version, source, destination });
    const from = createRequire(path.join(source, 'package.json'));
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) copy(dependency, version as string, from, destination);
    for (const [dependency, version] of Object.entries(manifest.optionalDependencies ?? {})) {
      try { packageRoot(dependency, from); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue; throw error; }
      copy(dependency, version as string, from, destination);
    }
  };
  for (const [name, range] of Object.entries(dependencies)) copy(name, range, installed, packageDir);
  return records;
}

test('complete TGZ executes through the installed DSH SDK and native executor', { timeout: 240_000 }, async (t) => {
  const root = process.cwd();
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(root, '.tmp/dsh-bundle-'));
  const env = { ...process.env, SEAL_HOME: path.join(sandbox, 'seal-home'), DSH_HOME: path.join(sandbox, 'dsh-home'), TMPDIR: sandbox };
  try {
    let artifact: string;
    if (process.env.SEAL_DSH_ARTIFACT !== undefined) artifact = path.resolve(process.env.SEAL_DSH_ARTIFACT);
    else {
      const packageBefore = fs.readFileSync(path.join(root, 'package.json'));
      const outcomes = await Promise.allSettled([0, 1].map(async () => {
        const result = await run(process.execPath, ['scripts/build-dsh-bundle.mjs'], { cwd: root, env, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
        const file = result.stdout.trim().split('\n').at(-1)!;
        const manifest = JSON.parse((await run('tar', ['-xOzf', file, 'package/package.json'])).stdout);
        assert.equal(path.basename(file), `seal-dsh-${manifest.version}.tgz`, 'Concurrent builds retain their own package manifest');
        return { file, version: manifest.version, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
      }));
      const builds = outcomes.map(outcome => {
        if (outcome.status === 'rejected') throw outcome.reason;
        return outcome.value;
      });
      assert.equal(new Set(builds.map(build => build.file)).size, 2, 'Concurrent builds return distinct artifact paths');
      assert.equal(new Set(builds.map(build => build.version)).size, 2, 'Concurrent builds never reuse a version');
      assert.equal(new Set(builds.map(build => build.sha256)).size, 2);
      assert.deepEqual(fs.readFileSync(path.join(root, 'package.json')), packageBefore, 'Building never changes the tracked package version');
      t.diagnostic(JSON.stringify({ parallelBuilds: builds }));
      artifact = builds[0].file;
    }
    assert.ok(path.isAbsolute(artifact) && fs.statSync(artifact).isFile(), 'The build must return its TGZ path');
    const digest = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    const members = (await run('tar', ['-tzf', artifact], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split('\n');
    assert.ok(members.every(member => member.startsWith('package/') && !member.split('/').includes('..')), 'Archive members stay under package/');
    assert.ok(members.every(member => !/(^|\/)(node_modules|docs|\.tmp)(\/|$)/.test(member)), 'Only distributable package files belong in the TGZ');
    await run('tar', ['-xzf', artifact, '-C', sandbox]);
    const packageDir = path.join(sandbox, 'package');
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const expectedPackageName = process.env.SEAL_NPM_PACKAGE?.trim() || 'seal-dsh';
    assert.equal(manifest.name, expectedPackageName);
    assert.equal(path.basename(artifact), `seal-dsh-${manifest.version}.tgz`);
    const patchYaml = fs.readFileSync(path.join(packageDir, 'cordis.patch.yml'), 'utf8');
    assert.ok(patchYaml.includes(`name: '${expectedPackageName}'`), 'cordis.patch.yml must reference the published package name');
    const clientJs = fs.readFileSync(path.join(packageDir, 'lib/client.js'), 'utf8');
    assert.ok(
      clientJs.includes(`"${expectedPackageName}"`) || clientJs.includes(`'${expectedPackageName}'`),
      'lib/client.js must register __ModuleLoader__ with the published package name',
    );
    assert.equal(manifest.exports['.'], './lib/index.js');
    assert.equal(manifest.author, 'Seal Team');
    assert.equal(manifest.license, 'MIT');
    assert.equal(manifest.homepage, 'https://github.com/chefzejia/seal#readme');
    assert.equal(manifest.repository?.url, 'git+https://github.com/chefzejia/seal.git');
    assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.includes('docx'));
    assert.equal(manifest.publishConfig?.access, 'public');
    assert.equal(manifest.engines?.node, '>=22.0.0');
    assert.equal(manifest.dependencies['@hyzyla/pdfium'], '^3.0.0');
    for (const file of ['lib/index.js', 'lib/client.js', 'lib/shells/pdf-engine.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md']) assert.ok(members.includes(`package/${file}`), file);
    for (const lang of ['zh', 'en']) {
      const locale = JSON.parse(fs.readFileSync(path.join(packageDir, `locale/${lang}.json`), 'utf8'));
      assert.equal(locale.meta?.title, 'Seal');
      assert.ok(typeof locale.meta?.description === 'string' && locale.meta.description.length > 20);
      assert.equal(locale.meta?.detail, undefined, `${lang} locale omits meta.detail so DSH falls back to README.md`);
    }
    const dependencies = copyRuntimeDependencies(root, packageDir, manifest.dependencies);
    t.diagnostic(JSON.stringify({ artifact, sha256: digest, package: manifest.version, dependencies }));
    const source = path.join(sandbox, 'original.docx');
    fs.writeFileSync(source, originalDocx, { flag: 'wx' });
    fs.copyFileSync(path.join(root, 'tests/fixtures/geometry.gif'), path.join(sandbox, 'image.gif'));
    const electron = process.env.SEAL_DSH_ELECTRON ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
    const sdkModules = process.env.SEAL_DSH_NODE_MODULES ?? path.resolve(path.dirname(electron), '../Resources/app.asar/dsh/node_modules');
    const config = path.join(sandbox, 'runtime.json');
    const geometryFixtures = [];
    for (const id of ['row-exact-0', 'vertical-margins', 'natural-columns-0', 'paragraph-indent-3']) {
      const item = constraintCases.find(item => item.id === id)!;
      const file = path.join(sandbox, `${id}.docx`);
      fs.writeFileSync(file, await packageDocument(item.body, item.section, item.styles));
      geometryFixtures.push({ id, file, at: item.at, ranges: [{ from: item.body.startsWith('<w:tbl') ? 't:0' : 'p:0', to: item.id.startsWith('natural') ? 'p:133' : item.body.startsWith('<w:tbl') ? 't:0' : 'p:0' }], maxWidth: item.maxWidth });
    }
    fs.writeFileSync(config, JSON.stringify({ packageDir, sdkModules, sandbox, source, artifact, sha256: digest, readonlyFixtures: path.join(root, 'tests/fixtures'), geometryFixtures, geometryEvidence: process.env.SEAL_LAYOUT_SDK_EVIDENCE }));
    const runtimeEnv: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    delete runtimeEnv.NODE_TEST_CONTEXT;
    delete runtimeEnv.NODE_TEST_REPORTER;
    let result: { stdout: string; stderr: string; code?: number };
    try {
      result = await run(electron, [path.join(root, 'tests/fixtures/dsh-sdk-runtime.mjs'), config], {
        cwd: sandbox, env: runtimeEnv, timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number; signal?: string; killed?: boolean };
      t.diagnostic(JSON.stringify({ message: failure.message, code: failure.code, signal: failure.signal, killed: failure.killed }));
      t.diagnostic(failure.stdout ?? '');
      t.diagnostic(failure.stderr ?? '');
      throw new Error(`Installed SDK integration failed with exit ${String(failure.code)}; see runtime diagnostics`);
    }
    t.diagnostic(result.stdout);
    assert.equal(result.stderr.trim(), '', 'SDK runtime reports no uncaught errors');
    assert.deepEqual(fs.readFileSync(source), originalDocx, 'All packaged operations preserve the original tender bytes');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
