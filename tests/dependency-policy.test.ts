import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { dependencyViolations } from './dependency-policy.js';

function withFixture(run: (root: string, options: ts.CompilerOptions) => void): void {
  fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.tmp/dependency-policy-'));
  try {
    for (const file of ['src/core/value.ts', 'src/workbench/value.ts', 'src/shells/value.ts', 'src/packs/retired/value.ts', 'outside.ts', 'node_modules/@deepseek-ai/host/index.d.ts']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'export const value = 1;');
    }
    fs.mkdirSync(path.join(root, 'src/core/nested'));
    for (const [name, packageName] of [['native-host', 'sharp'], ['renamed-sdk', '@deepseek-ai/dsh-tools'], ['unreviewed-package', 'unreviewed-package']]) {
      const directory = path.join(root, 'node_modules', name!);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'index.d.ts'), 'export const value: number;');
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: packageName, types: 'index.d.ts' }));
    }
    fs.symlinkSync(path.dirname(ts.resolveModuleName('saxes', path.resolve('tests/dependency-policy.test.ts'), { moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule!.resolvedFileName), path.join(root, 'node_modules/xml-alias'), 'dir');
    run(root, { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, baseUrl: root, paths: { '@local/*': ['src/*'], '@host': ['node_modules/@deepseek-ai/host/index.d.ts'], '@native': ['node_modules/native-host/index.d.ts'], '@xml': ['node_modules/xml-alias/saxes.d.ts'] } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('parsed dependency policy resolves all loading syntax and the three physical layers', () => withFixture((root, options) => {
  const cases: Array<[string, string, boolean]> = [
    ['core', "import { value } from './value.js'", true],
    ['core', "import type { value } from './value.js'", true],
    ['core', "export * from './value.js'", true],
    ['core', "export type { value } from './value.js'", true],
    ['core', "import local = require('./value.js')", true],
    ['core', "export * from './nested/../value.js'", true],
    ['core', 'const value = import(`./value.js`)', true],
    ['core', "type Value = import('./value.js').value", true],
    ['core', "const value = require('./value.js')", true],
    ['core', "const value = module.require('./value.js')", true],
    ['core', "require.resolve('./value.js')", true],
    ['core', "require['resolve']('./value.js')", true],
    ['core', "globalThis['require']('./value.js')", true],
    ['core', "export * from '@local/core/value.js'", true],
    ['workbench', "import { value } from '../core/value.js'", true],
    ['workbench', "export * from './value.js'", true],
    ['workbench', "export * from '@local/core/value.js'", true],
    ['core', "import { SaxesParser } from 'saxes'", true],
    ['core', "import { marked } from 'marked'", true],
    ['core', "import { SaxesParser } from 'xml-alias'", true],
    ['core', "import { SaxesParser } from '@xml'", true],
    ['workbench', "import jpeg from 'jpeg-js'", true],
    ['shells', "import 'node:fs'; import '@deepseek-ai/dsh-tools'", true],
    ['shells', "import sharp from 'sharp'; import 'marked/bin/marked'", true],
    ['shells', "export * from '../core/value.js'; export * from '../workbench/value.js'", true],
    ['core', "import { value } from '../workbench/value.js'", false],
    ['core', "export * from '@local/workbench/value.js'", false],
    ['core', "export type { value } from '../shells/value.js'", false],
    ['workbench', "export * from '../shells/value.js'", false],
    ['workbench', "export * from '@local/shells/value.js'", false],
    ['core', "export * from './nested/../../shells/value.js'", false],
    ['core', "import '../packs/retired/value.js'", false],
    ['workbench', "export * from '../packs/retired/value.js'", false],
    ['packs/retired', 'export const value = 1;', false],
    ['core', "import('node:fs')", false],
    ['workbench', "import('node:fs')", false],
    ['core', "import fs from 'node:fs'", false],
    ['core', "import '@deepseek-ai/dsh-tools'", false],
    ['core', "import '@host'", false],
    ['core', "import sharp from 'sharp'", false],
    ['core', "import 'marked/bin/marked'", false],
    ['core', "import '@native'", false],
    ['core', "import 'native-host'", false],
    ['core', "import 'renamed-sdk'", false],
    ['core', "import 'unreviewed-package'", false],
    ['core', "import '../../node_modules/@deepseek-ai/host/index.js'", false],
    ['workbench', "export * from 'node:fs'", false],
    ['core', "const fs = require('fs')", false],
    ['core', "const fs = module.require('node:fs')", false],
    ['core', "import fs = require('node:fs')", false],
    ['core', "type Stat = import('node:fs').Stats", false],
    ['workbench', "require.resolve('node:fs')", false],
    ['core', "require['resolve']('node:fs')", false],
    ['core', "globalThis['require']('node:fs')", false],
    ['core', "module['re' + 'quire']('node:fs')", false],
    ['core', "const load = require; load('node:fs')", false],
    ['core', "const load = module.require; load('node:fs')", false],
    ['core', "const { require: load } = module; load('node:fs')", false],
    ['core', "const host = module; host['require']('node:fs')", false],
    ['core', "(require)('node:fs')", false],
    ['core', "require.call(null, 'node:fs')", false],
    ['core', "const key = 'require'; module[key]('node:fs')", false],
    ['core', "declare const module: any; const key = 'require'; module[key]('node:fs')", false],
    ['workbench', 'const name = "./value.js"; import(name)', false],
    ['core', 'const name = "./value.js"; require(name)', false],
    ['core', "import './missing.js'", false],
    ['core', "import '../../outside.js'", false],
    ['core', "import 'unresolved-package'", false],
    ['core', "import './value.js", false],
    ['core', "const example = `import('node:fs')`; // import 'node:fs'", true],
    ['core', "const module = 'assembly'; const state = { module };", true],
    ['workbench', "function name(module: string) { return module; }", true],
    ['core', "const value = require()", false],
    ['core', "import(`node:${name}`)", false],
    ['core', "import { readFile } from 'fs/promises'", false],
    ['core', "type Host = import('@deepseek-ai/dsh-tools').Host", false],
    ['workbench', "/* export * from '../shells/value.js' */ const text = \"require('fs')\";", true],
  ];
  for (const [layer, source, allowed] of cases) {
    const file = path.join(root, 'src', layer, 'entry.ts');
    fs.writeFileSync(file, source);
    const failures = dependencyViolations(root, [file], options);
    assert.equal(failures.length === 0, allowed, `${layer}: ${source}\n${JSON.stringify(failures)}`);
  }
}));

test('symlinks cannot move a confined source or target outside its physical layer', () => withFixture((root, options) => {
  const entry = path.join(root, 'src/core/entry.ts');
  for (const [name, target] of [['host', '../shells/value.ts'], ['outside', '../../outside.ts'], ['retired', '../packs/retired/value.ts']]) {
    const symlink = path.join(root, `src/core/${name}-alias.ts`);
    fs.symlinkSync(target!, symlink);
    fs.writeFileSync(entry, `export * from './${name}-alias.js'`);
    assert.ok(dependencyViolations(root, [entry], options).length > 0, `${name}: symlink target`);
    assert.ok(dependencyViolations(root, [symlink], options).length > 0, `${name}: symlink source`);
  }
  const sameLayer = path.join(root, 'src/core/local-alias.ts');
  fs.symlinkSync('./value.ts', sameLayer);
  fs.writeFileSync(entry, "export * from './local-alias.js'");
  assert.deepEqual(dependencyViolations(root, [entry, sameLayer], options), []);
  const sdkAlias = path.join(root, 'node_modules/sdk-alias');
  fs.symlinkSync(path.join(root, 'node_modules/@deepseek-ai/host'), sdkAlias, 'dir');
  fs.writeFileSync(entry, "import 'sdk-alias/index.js'");
  assert.ok(dependencyViolations(root, [entry], options).length > 0, 'a renamed SDK symlink cannot disguise a physical host package');
  const externalAlias = path.join(root, 'node_modules/disguised');
  fs.symlinkSync(path.join(root, 'src/shells'), externalAlias, 'dir');
  fs.writeFileSync(entry, "import 'disguised/value.js'");
  assert.ok(dependencyViolations(root, [entry], options).length > 0, 'node_modules cannot disguise a local host target');
}));
