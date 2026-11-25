import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HostPort } from '../../core/host.js';
import { KnowledgeBase, assertHealthReferenceDate, candidatePage, type KbEntry, type KbKind, type SaveInput } from '../../core/kb/index.js';
import { readProject } from '../../core/bid/project.js';
import { assertOutputIsolation } from '../output-isolation.js';
import { prepareKbIngestInputs } from '../kb-ingest-prep.js';
import { assertKnowledgeBaseTree, knowledgeBasesRoot, serializedKnowledgeBase } from '../knowledge-base-service.js';

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (value === undefined || value.startsWith('--')) throw new Error(`缺少 --${name}`);
  return value;
}

function bounded(value: unknown, maximum = 50000, offset = 0): unknown {
  if (value && typeof value === 'object' && 'body' in value && typeof value.body === 'string') {
    const item = value as Record<string, unknown> & { body: string };
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.body.length) throw new Error('offset 必须是正文范围内的非负整数字符位置');
    const previousCodeUnit = item.body.charCodeAt(offset - 1), currentCodeUnit = item.body.charCodeAt(offset);
    if (offset > 0 && offset < item.body.length && previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff && currentCodeUnit >= 0xdc00 && currentCodeUnit <= 0xdfff) {
      throw new Error(`offset=${offset} 位于 UTF-16 代理对内部；请使用 ${offset - 1}（码点前）或 ${offset + 1}（码点后），连续读取请传上一页 nextOffset。`);
    }
    const remaining = { ...item, body: item.body.slice(offset) };
    if (JSON.stringify(remaining).length <= maximum) return remaining;
    const page = (length: number) => ({ ...item, body: item.body.slice(offset, offset + length), truncated: true, nextOffset: offset + length, totalCharacters: item.body.length });
    if (JSON.stringify(page(0)).length >= maximum) throw new Error('记录元数据超过输出上限；请缩减超长字段后重新读取正文');
    let lower = 0, upper = Math.min(item.body.length - offset, maximum);
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (JSON.stringify(page(middle)).length <= maximum) lower = middle;
      else upper = middle - 1;
    }
    const last = item.body.charCodeAt(offset + lower - 1);
    if (last >= 0xd800 && last <= 0xdbff) lower--;
    if (lower === 0) throw new Error('记录元数据未留出正文空间；请缩减超长字段后重新读取');
    return page(lower);
  }
  const serialized = JSON.stringify(value);
  if (serialized.length <= maximum) return value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let size = 2;
    for (const item of value) {
      const itemSize = JSON.stringify(item).length + (output.length ? 1 : 0);
      if (size + itemSize > maximum - 80) break;
      output.push(item); size += itemSize;
    }
    return { items: output, truncated: output.length < value.length, returned: output.length, total: value.length };
  }
  return { output: serialized.slice(0, maximum - 80), truncated: true, notice: '输出已截断；请缩小查询或读取单条记录。' };
}

const KB_HELP_FLAGS = new Set(['--help', '-h', 'help']);
const KB_COMMANDS = new Set(['init', 'search', 'get', 'save', 'ingest', 'health']);

export function kbHelpText(): string {
  return [
    'Seal 知识库命令行用法:',
    '  seal kb init --name <名称> [--vault <知识库ID>]',
    '  seal kb search (--vault <ID> | --project <目录>) [--query <关键词>] [--type <类型>] [--tags <JSON数组>] [--validity <状态>] [--reference-date <YYYY-MM-DD>] [--limit <N>] [--batch <批次ID> --after <游标>]',
    '  seal kb get (--vault <ID> | --project <目录>) (--subject | --id <ID> [--kind <subject|record|material>]) [--offset <N>] [--reference-date <YYYY-MM-DD>]',
    '  seal kb save (--vault <ID> | --project <目录>) --data <JSON>',
    '  seal kb ingest (--vault <ID> | --project <目录>) --files <JSON文件或目录路径数组> [--limit <1..100>]',
    '  seal kb health (--vault <ID> | --project <目录>) [--reference-date <YYYY-MM-DD>]',
    '  seal kb --help | -h | help',
  ].join('\n');
}

export async function runKnowledgeBase(host: HostPort, args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (command && (KB_HELP_FLAGS.has(command) || (KB_COMMANDS.has(command) && (rest.includes('--help') || rest.includes('-h'))))) {
    return { help: kbHelpText() };
  }
  const root = knowledgeBasesRoot();
  assertKnowledgeBaseTree(root);
  return serializedKnowledgeBase(root, async () => {
    const kb = new KnowledgeBase(host, root);
    if (command === 'init') {
      const result = await kb.createVault({ name: required(rest, 'name'), ...(option(rest, 'vault') ? { vaultId: option(rest, 'vault') } : {}) });
      return bounded(result);
    }
    const project = option(rest, 'project');
    const metadata = project === undefined ? undefined : await readProject(host, path.resolve(project));
    const vaultId = option(rest, 'vault') ?? metadata?.vaultId;
    if (!vaultId) throw new Error('请提供 --vault 或关联知识库的 --project');
    const referenceDate = metadata?.deadline ?? option(rest, 'reference-date');
    if (referenceDate !== undefined) assertHealthReferenceDate(referenceDate);
    const display = async (entry: KbEntry, offset = 0) => bounded(referenceDate === undefined ? entry : { ...entry, health: await kb.entryHealth(vaultId, entry, referenceDate) }, 50000, offset);
    const vaultRoot = kb.vaultRoot(vaultId);
    await kb.metadata(vaultId);
    if (command === 'search') {
      const batch = option(rest, 'batch');
      const after = option(rest, 'after');
      const tagsValue = option(rest, 'tags');
      if (batch !== undefined) {
        if (['query', 'type', 'tags', 'validity'].some(name => option(rest, name) !== undefined)) throw new Error('候选批次续读使用 --batch、--after 和 --limit');
        return kb.listCandidates(vaultId, batch, Number(option(rest, 'limit') ?? 20), after);
      }
      if (after !== undefined) throw new Error('--after 需要 --batch');
      const result = await kb.search(vaultId, {
        ...(option(rest, 'query') === undefined ? {} : { query: option(rest, 'query')! }),
        ...(option(rest, 'type') === undefined ? {} : { type: option(rest, 'type')! }),
        ...(tagsValue === undefined ? {} : { tags: JSON.parse(tagsValue) as string[] }),
        ...(option(rest, 'validity') === undefined ? {} : { validity: option(rest, 'validity')! }),
        referenceDate,
        ...(option(rest, 'limit') === undefined ? {} : { limit: Number(option(rest, 'limit')) }),
      });
      return bounded(result);
    }
    if (command === 'get') {
      const offset = Number(option(rest, 'offset') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数字符位置');
      if (rest.includes('--subject')) return display(await kb.get(vaultId, 'subject'), offset);
      const id = required(rest, 'id'), kind = option(rest, 'kind') as KbKind | undefined;
      if (kind) {
        if (!['subject', 'record', 'material'].includes(kind)) throw new Error('kind 必须为 subject、record 或 material');
        return display(await kb.get(vaultId, kind, id), offset);
      }
      if (id.startsWith('candidate-')) return display(await kb.getCandidate(vaultId, id), offset);
      if (/^kb-[\p{L}\p{N}-]+$/u.test(id)) {
        const record = await host.stat(host.joinPath(vaultRoot, 'records', `${id}.md`));
        return display(await kb.get(vaultId, record.exists ? 'record' : 'material', id), offset);
      }
      throw new Error('请提供 kind=record|material，或读取 subject=true / candidate-*');
    }
    if (command === 'save') {
      const input = JSON.parse(required(rest, 'data')) as SaveInput & { filePath?: string };
      if (!input || !['create', 'update', 'delete', 'attach_file', 'dismiss_candidate', 'dismiss_candidates'].includes(input.action)) {
        throw new Error('save data 的 action 无效；action 允许 create、update、delete、attach_file、dismiss_candidate、dismiss_candidates');
      }
      if ((input.action === 'dismiss_candidate' || input.action === 'dismiss_candidates') && input.kind === undefined) {
        input.kind = 'material';
      }
      if (!['subject', 'record', 'material'].includes(input.kind)) {
        throw new Error('save data 的 kind 无效；kind 允许 subject、record、material');
      }
      if (input.action === 'attach_file') {
        if (!input.filePath || typeof input.filePath !== 'string') throw new Error('attach_file 需要 filePath');
        const filePath = path.resolve(input.filePath);
        assertOutputIsolation({ directories: [vaultRoot] }, { files: [filePath] });
        input.file = { fileName: path.basename(filePath), bytes: await fs.readFile(filePath) };
        delete input.filePath;
      }
      const result = await kb.save(vaultId, input);
      return input.action === 'delete' || input.action === 'dismiss_candidates' ? bounded(result) : display(result);
    }
    if (command === 'ingest') {
      const sourcePaths = JSON.parse(required(rest, 'files')) as unknown;
      if (!Array.isArray(sourcePaths) || sourcePaths.length < 1 || sourcePaths.some(item => typeof item !== 'string')) throw new Error('--files 必须是非空文件或目录路径数组');
      const limit = Number(option(rest, 'limit') ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('候选 limit 范围为 1 到 100');
      const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'seal-kb-ingest-'));
      try {
        const prepared = await prepareKbIngestInputs({
          host,
          vaultRoot,
          rawPaths: sourcePaths as string[],
          stagingRoot,
        });
        const report = await kb.ingestMaterials(
          vaultId,
          prepared.items,
          path.join(stagingRoot, 'ingest'),
          prepared.skipped,
        );
        const byId = new Map(report.candidates.map(candidate => [candidate.id, candidate]));
        const page = candidatePage(report.batchId, report.candidates.map(candidate => candidate.id), limit);
        return {
          ...page,
          candidates: page.candidates.map(item => ({
            ...item,
            ...(byId.get(item.id)?.sourceType ? { sourceType: byId.get(item.id)!.sourceType } : {}),
          })),
          sourceCount: report.sourceCount,
          imageCount: report.imageCount,
          ...(report.skipped.length ? { skipped: report.skipped } : {}),
        };
      } finally {
        await fs.rm(stagingRoot, { recursive: true, force: true });
      }
    }
    if (command === 'health') {
      if (referenceDate === undefined) throw new Error('体检需要 --project 或 --reference-date YYYY-MM-DD');
      return bounded(await kb.health(vaultId, referenceDate));
    }
    throw new Error('支持的知识库命令：kb init、search、get、save、ingest');
  });
}
