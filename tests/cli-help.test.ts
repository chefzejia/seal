import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SEAL_BID_SKILL } from '../src/shells/dsh/seal-bid-skill.js';

const exec = promisify(execFile);

async function runCli(...args: string[]) {
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', 'src/shells/cli/index.ts', ...args]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('CLI --help, -h, help and kb help exit with code 0 and print usage to stdout', async () => {
  for (const args of [['--help'], ['-h'], ['help'], ['read', '--help'], ['project', '--help'], ['project', 'init', '--help']]) {
    const result = await runCli(...args);
    assert.equal(result.code, 0, args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
    assert.match(result.stdout, /project init/, args.join(' '));
    assert.match(result.stdout, /requirements/, args.join(' '));
  }
  for (const args of [['kb', '--help'], ['kb', '-h'], ['kb', 'help'], ['kb', 'search', '--help']]) {
    const result = await runCli(...args);
    assert.equal(result.code, 0, args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
    assert.match(result.stdout, /kb search/, args.join(' '));
    assert.match(result.stdout, /kb ingest/, args.join(' '));
  }
});

test('CLI unknown commands and invalid arguments fail with exit code 1 on stderr', async () => {
  for (const args of [[], ['unknown-cmd'], ['unknown-cmd', '--help'], ['kb'], ['kb', 'unknown-sub'], ['kb', 'unknown-sub', '--help']]) {
    const result = await runCli(...args);
    assert.equal(result.code, 1, args.join(' '));
    assert.notEqual(result.stderr.trim(), '', args.join(' '));
  }
});

test('seal-bid skill enforces structured self-written sections against requirements.json', () => {
  assert.ok(SEAL_BID_SKILL.description.length <= 500);
  assert.match(SEAL_BID_SKILL.content, /requirements\.json/);
  assert.match(SEAL_BID_SKILL.content, /seal_kb_search/);
  assert.match(SEAL_BID_SKILL.content, /insert/);
  assert.match(SEAL_BID_SKILL.content, /响应对照表/);
  assert.match(SEAL_BID_SKILL.content, /pending/);
});
