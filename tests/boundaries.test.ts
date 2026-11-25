import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { dependencyViolations } from './dependency-policy.js';

function getAllFiles(directory: string, ancestors = new Set<string>()): string[] {
  if (!fs.existsSync(directory)) return [];
  const physical = fs.realpathSync(directory);
  assert.ok(!ancestors.has(physical), `Source directory symlink cycle: ${directory}`);
  const nextAncestors = new Set([...ancestors, physical]);
  return fs.readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name);
    return fs.statSync(file).isDirectory() ? getAllFiles(file, nextAncestors) : [file];
  });
}

function hardcodedProductionValues(content: string): string[] {
  return content.match(/\/Users\/[^/\s'"`]+|\/home\/[^/\s'"`]+|[A-Za-z]:\\+(?:Users|Documents and Settings)\\+[^\\\s'"`]+|\b(?:tbl|t):\d+|\b(?:section_after:)?p:\d+/g) ?? [];
}

const codeFile = /\.(?:[cm]?[jt]sx?|svelte|html)$/;

function comparisonHintDependencies(entry: string): string[] {
  const root = path.resolve('src'), seen = new Set<string>(), found: string[] = [];
  const visit = (file: string) => {
    file = fs.realpathSync(file);
    if (seen.has(file) || !file.startsWith(root + path.sep)) return;
    seen.add(file);
    if (path.basename(file) === 'blank-hints.ts' || path.basename(file) === 'document-view.ts') { found.push(path.relative(process.cwd(), file)); return; }
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node) => {
      let specifier: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const resolved = ts.resolveModuleName(specifier.text, file, { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext }, ts.sys).resolvedModule;
        if (resolved && !resolved.isExternalLibraryImport) visit(resolved.resolvedFileName);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(entry);
  return found;
}

describe('Architecture Boundaries (Three-Layer DAG)', () => {
  const srcFiles = getAllFiles(path.resolve('src')).filter(file => codeFile.test(file));
  const testFiles = getAllFiles(path.resolve('tests')).filter(file => codeFile.test(file));

  test('every production source obeys the resolved three-layer and host boundaries', () => {
    assert.deepEqual(dependencyViolations(process.cwd(), srcFiles), []);
  });

  test('independent document comparison has no direct or transitive dependency on hint detection', () => {
    assert.deepEqual(comparisonHintDependencies(path.resolve('src/core/docx/package-compare.ts')), []);
    assert.ok(comparisonHintDependencies(path.resolve('src/core/docx/read-document.ts')).some(file => file.endsWith('document-view.ts')));
  });

  test('production source and scripts contain no sample identity, local-user fallback or fixed template coordinate', () => {
    for (const file of [...getAllFiles(path.resolve('src')), ...getAllFiles(path.resolve('scripts'))]) {
      assert.deepEqual(hardcodedProductionValues(fs.readFileSync(file, 'utf8')), [], path.relative(process.cwd(), file));
    }
  });

  test('hardcoded-value detector rejects user paths and literal paragraph/table addresses', () => {
    for (const content of [
      'const source = "/Users/another-user/Documents/file.docx";', 'const source = "/home/bidder/file.docx";',
      String.raw`const source = "C:\\Users\\bidder\\file.docx";`,
      'const address = "p:857";', 'const address = "section_after:p:857";',
      'const address = "tbl:15/r:3/c:2";', 'const address = "t:15/r:3";',
      '// example address p:857',
    ]) assert.ok(hardcodedProductionValues(content).length > 0, content);
    for (const content of [
      'const address = `p:${index}`;', 'const address = `section_after:p:${index}`;',
      'const address = `t:${table}/r:${row}/c:${column}`;', 'const address = "p:" + index;',
      'const projectRoot = host.projectRoot;', 'const pattern = /^p:(\\d+)$/;',
    ]) assert.deepEqual(hardcodedProductionValues(content), [], content);
  });

  test('no function alias wrapping or vm.runInContext fake tests', () => {
    for (const file of [...srcFiles, ...testFiles]) {
      if (file === path.resolve('tests/boundaries.test.ts')) continue;
      const content = fs.readFileSync(file, 'utf8');
      const relative = path.relative(process.cwd(), file);
      assert.doesNotMatch(content, /const\s+\w+Base\s*=\s*\w+/, `${relative} contains forbidden const fnBase = fn alias pattern`);
      assert.doesNotMatch(content, /vm\.runInContext/, `${relative} contains forbidden vm.runInContext`);
    }
  });
});
