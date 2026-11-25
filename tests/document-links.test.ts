import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

interface LinkViolation { file: string; href: string; reason: string }

function markdownFiles(directory: string, ancestors = new Set<string>()): string[] {
  const physical = fs.realpathSync(directory);
  assert.ok(!ancestors.has(physical), `Documentation directory symlink cycle: ${directory}`);
  const nextAncestors = new Set([...ancestors, physical]);
  return fs.readdirSync(directory).sort((left, right) => left.localeCompare(right)).flatMap(name => {
    const file = path.join(directory, name);
    return fs.statSync(file).isDirectory() ? markdownFiles(file, nextAncestors) : name.endsWith('.md') ? [file] : [];
  });
}

function documentLinkViolations(root: string): LinkViolation[] {
  const failures: LinkViolation[] = [];
  const files = [path.join(root, 'AGENTS.md'), path.join(root, 'README.md'), ...markdownFiles(path.join(root, 'docs'))];
  for (const file of files) {
    marked.walkTokens(marked.lexer(fs.readFileSync(file, 'utf8')), token => {
      if (token.type !== 'link' && token.type !== 'image') return;
      const href = token.href;
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return;
      const target = href.split(/[?#]/, 1)[0]!;
      if (target === '') return;
      let decoded: string;
      try { decoded = decodeURIComponent(target); }
      catch {
        failures.push({ file: path.relative(root, file), href, reason: 'Invalid URL encoding in relative link' }); return;
      }
      const destination = path.resolve(path.dirname(file), decoded);
      if (!fs.existsSync(destination)) failures.push({ file: path.relative(root, file), href, reason: `Missing target: ${path.relative(root, destination)}` });
    });
  }
  return failures;
}

test('AGENTS, README and every docs Markdown link resolve to an existing file or directory', () => {
  assert.deepEqual(documentLinkViolations(process.cwd()), []);
});

test('document link guard parses Markdown, resolves each document directory and detects missing targets', () => {
  fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.tmp/document-links-'));
  try {
    fs.mkdirSync(path.join(root, 'docs/nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '[docs](docs/)\n[readme](README.md#unknown-heading)');
    fs.writeFileSync(path.join(root, 'README.md'), '[nested](docs/nested/guide.md?view=source#anything)');
    fs.writeFileSync(path.join(root, 'docs/space name (draft).md'), '# Target');
    fs.writeFileSync(path.join(root, 'docs/中文.md'), '# 中文');
    fs.writeFileSync(path.join(root, 'docs/nested/guide.md'), [
      '[file](<../space name (draft).md>)', '[encoded](../space%20name%20%28draft%29.md)',
      '[Chinese](../%E4%B8%AD%E6%96%87.md#任意)', '[folder](../)',
      '[remote](https://example.test/missing.md)', '[network](//example.test/missing.md)',
      '[email](mailto:author@example.test)', '[anchor](#missing-heading)',
      '`[inline example](missing-inline.md)`', '```md', '[example](missing-fenced.md)', '```',
      '    [indented example](missing-indented.md)',
      '[reference][existing]', '', '[existing]: ../%E4%B8%AD%E6%96%87.md',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'docs/LESSONS.md'), '[valid history](nested/guide.md)');
    assert.deepEqual(documentLinkViolations(root), []);
    fs.writeFileSync(path.join(root, 'docs/nested/guide.md'), '[missing](../gone.md)\n![missing image](../gone.png)\n[encoded](bad%ZZ.md)');
    fs.writeFileSync(path.join(root, 'docs/LESSONS.md'), '[missing history](missing-history.md)');
    assert.deepEqual(documentLinkViolations(root).map(failure => [failure.file, failure.href]), [
      ['docs/LESSONS.md', 'missing-history.md'], ['docs/nested/guide.md', '../gone.md'],
      ['docs/nested/guide.md', '../gone.png'], ['docs/nested/guide.md', 'bad%ZZ.md'],
    ]);
    fs.unlinkSync(path.join(root, 'README.md'));
    assert.throws(() => documentLinkViolations(root), /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
